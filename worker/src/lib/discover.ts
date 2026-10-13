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

function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 1000);
  const stripped = head.replace(/^<\?xml[^>]*\?>/, "").trimStart();
  if (/^<rss[\s>]/i.test(stripped) || /^<feed[\s>]/i.test(stripped) || /^<rdf[:R]?[DF]*[\s>]/i.test(stripped)) return true;
  if (/<rss[\s>]/i.test(head) || /<rdf:RDF/i.test(head) || /<feed[^>]+xmlns/i.test(head)) return true;
  if (/"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(head)) return true;
  return false;
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
  if (looksLikeFeed(page.body)) {
    return [{ url: page.finalUrl, title: "", type: contentType?.split(";")[0]?.trim().toLowerCase() ?? "application/xml" }];
  }

  const fromLinks = scanLinks(page.body, page.finalUrl);
  if (fromLinks.length > 0) return fromLinks;

  const base = new URL(page.finalUrl);
  const found: FeedCandidate[] = [];
  for (const path of COMMON_PATHS) {
    const candidate = new URL(path, base).toString();
    try {
      const res = await fetchText(candidate, { maxBytes: 64 * 1024, timeoutMs: 8000 }, fetchFn);
      if (res.status >= 200 && res.status < 300 && looksLikeFeed(res.body)) {
        found.push({ url: res.finalUrl, title: "", type: res.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "application/xml" });
        break;
      }
    } catch {
      continue;
    }
  }
  return found;
}
