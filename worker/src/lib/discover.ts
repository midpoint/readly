import { fetchText } from "./http";

export interface FeedCandidate {
  url: string;
  title: string;
  type: string;
}

const FEED_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
  "text/xml",
];

const COMMON_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/feed/"];

function looksLikeFeed(body: string, contentType: string | null): boolean {
  if (contentType && (contentType.includes("xml") || contentType.includes("json"))) {
    const head = body.slice(0, 500).trimStart();
    return /^<(\?xml|rss|feed|rdf)/i.test(head) || head.startsWith("{");
  }
  const head = body.slice(0, 500).trimStart();
  return /^<(\?xml|rss|feed|rdf:RDF)/i.test(head) || /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(head);
}

function scanLinks(html: string, baseUrl: string): FeedCandidate[] {
  const out: FeedCandidate[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  for (const tag of html.match(linkRe) ?? []) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("alternate")) continue;
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!FEED_TYPES.some((t) => type === t || type.startsWith(t))) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const title = /\btitle\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    out.push({ url: absolute, title, type });
  }
  return out;
}

export async function discoverFeeds(
  pageUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<FeedCandidate[]> {
  const page = await fetchText(pageUrl, { maxBytes: 256 * 1024 }, fetchFn);
  if (page.status < 200 || page.status >= 300) {
    throw new Error(`目标页面无法访问(HTTP ${page.status})`);
  }
  const contentType = page.headers.get("Content-Type");
  if (looksLikeFeed(page.body, contentType)) {
    return [{ url: page.finalUrl, title: "", type: contentType ?? "application/xml" }];
  }

  const fromLinks = scanLinks(page.body, page.finalUrl);
  if (fromLinks.length > 0) return fromLinks;

  const base = new URL(page.finalUrl);
  const found: FeedCandidate[] = [];
  for (const path of COMMON_PATHS) {
    const candidate = new URL(path, base).toString();
    try {
      const res = await fetchText(candidate, { maxBytes: 64 * 1024, timeoutMs: 8000 }, fetchFn);
      if (res.status >= 200 && res.status < 300 && looksLikeFeed(res.body, res.headers.get("Content-Type"))) {
        found.push({ url: res.finalUrl, title: "", type: res.headers.get("Content-Type") ?? "application/xml" });
        break;
      }
    } catch {
      continue;
    }
  }
  return found;
}
