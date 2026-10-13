import { XMLParser } from "fast-xml-parser";
import type { FeedParseResult, ParsedItem } from "@readly/shared";
import { fnv1a } from "./hash";
import { detectLang, excerptOf, sanitizeFeedHtml, stripHtml } from "./text";

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    const node = v as Node;
    if ("#text" in node) return String(node["#text"]);
  }
  return "";
}

function hrefOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const url = (v as Node)["@_url"];
    if (typeof url === "string") return url;
  }
  return null;
}

function atomLink(links: unknown, rel: string): string | null {
  for (const link of asArray(links as Node | Node[] | undefined)) {
    if (typeof link !== "object" || link === null) continue;
    const l = link as Node;
    const lrel = typeof l["@_rel"] === "string" ? (l["@_rel"] as string) : "alternate";
    if (lrel === rel && typeof l["@_href"] === "string") return l["@_href"] as string;
  }
  return null;
}

function parseDate(input: string): string {
  if (!input) return new Date().toISOString();
  const d = new Date(input.trim());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function firstImageInHtml(html: string): string | null {
  const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
  return m?.[1] ?? null;
}

function makeItem(parts: {
  guid: string | null;
  url: string | null;
  title: string;
  author: string | null;
  published: string;
  rawContent: string;
  imageUrl: string | null;
}): ParsedItem {
  const title = parts.title.trim() || "(无标题)";
  const publishedAt = parseDate(parts.published);
  const content = parts.rawContent ? sanitizeFeedHtml(parts.rawContent) : null;
  const guid = parts.guid?.trim() || fnv1a(parts.url ?? title);
  return {
    guid,
    url: parts.url,
    title,
    author: parts.author,
    publishedAt,
    excerpt: content ? excerptOf(content) : null,
    content,
    imageUrl: parts.imageUrl ?? (content ? firstImageInHtml(content) : null),
    lang: detectLang(title),
  };
}

function parseRss2(root: Node): FeedParseResult {
  const channel = (root.rss as Node).channel as Node;
  const items = asArray(channel.item as Node | Node[] | undefined).map((raw) => {
    const item = raw as Node;
    const content = textOf(item["content:encoded"]) || textOf(item.description);
    const enclosureUrl = hrefOf(item.enclosure);
    const enclosureType =
      item.enclosure && typeof item.enclosure === "object"
        ? String((item.enclosure as Node)["@_type"] ?? "")
        : "";
    const imageUrl =
      enclosureUrl && (!enclosureType || enclosureType.startsWith("image/"))
        ? enclosureUrl
        : hrefOf(item["media:thumbnail"]) ?? hrefOf(item["media:content"]);
    return makeItem({
      guid: textOf(item.guid) || null,
      url: textOf(item.link) || null,
      title: textOf(item.title),
      author: textOf(item["dc:creator"]) || textOf(item.author) || null,
      published: textOf(item.pubDate) || textOf(item["dc:date"]),
      rawContent: content,
      imageUrl,
    });
  });
  return {
    title: textOf(channel.title) || "(未命名订阅)",
    siteUrl: textOf(channel.link) || null,
    description: textOf(channel.description) || null,
    iconUrl: null,
    items,
  };
}

function parseAtom(root: Node): FeedParseResult {
  const feed = root.feed as Node;
  const items = asArray(feed.entry as Node | Node[] | undefined).map((raw) => {
    const entry = raw as Node;
    const authorNode = entry.author as Node | undefined;
    return makeItem({
      guid: textOf(entry.id) || null,
      url: atomLink(entry.link, "alternate") ?? atomLink(entry.link, ""),
      title: textOf(entry.title),
      author: authorNode ? textOf(authorNode.name) || null : null,
      published: textOf(entry.published) || textOf(entry.updated),
      rawContent: textOf(entry.content) || textOf(entry.summary),
      imageUrl: hrefOf(entry["media:thumbnail"]),
    });
  });
  return {
    title: textOf(feed.title) || "(未命名订阅)",
    siteUrl: atomLink(feed.link, "alternate"),
    description: textOf(feed.subtitle) || null,
    iconUrl: textOf(feed.icon) || textOf(feed.logo) || null,
    items,
  };
}

function parseRdf(root: Node): FeedParseResult {
  const rdf = root["rdf:RDF"] as Node;
  const channel = rdf.channel as Node;
  const items = asArray(rdf.item as Node | Node[] | undefined).map((raw) => {
    const item = raw as Node;
    const content = textOf(item["content:encoded"]) || textOf(item.description);
    return makeItem({
      guid: textOf(item["@_rdf:about"]) || textOf(item["@_about"]) || null,
      url: textOf(item.link) || null,
      title: textOf(item.title),
      author: textOf(item["dc:creator"]) || null,
      published: textOf(item["dc:date"]),
      rawContent: content,
      imageUrl: null,
    });
  });
  return {
    title: textOf(channel.title) || "(未命名订阅)",
    siteUrl: textOf(channel.link) || null,
    description: textOf(channel.description) || null,
    iconUrl: null,
    items,
  };
}

function parseJsonFeed(body: string): FeedParseResult {
  const data = JSON.parse(body) as {
    title?: string;
    home_page_url?: string;
    description?: string;
    icon?: string;
    items?: {
      id?: string;
      url?: string;
      title?: string;
      author?: { name?: string };
      date_published?: string;
      content_html?: string;
      summary?: string;
      image?: string;
    }[];
  };
  const items = (data.items ?? []).map((it) =>
    makeItem({
      guid: it.id ?? null,
      url: it.url ?? null,
      title: it.title ?? "",
      author: it.author?.name ?? null,
      published: it.date_published ?? "",
      rawContent: it.content_html ?? it.summary ?? "",
      imageUrl: it.image ?? null,
    })
  );
  return {
    title: data.title ?? "(未命名订阅)",
    siteUrl: data.home_page_url ?? null,
    description: data.description ?? null,
    iconUrl: data.icon ?? null,
    items,
  };
}

export function parseFeed(body: string, contentType?: string | null): FeedParseResult {
  const head = body.slice(0, 200).trimStart();
  if (
    (contentType?.includes("json") ?? false) ||
    head.startsWith("{") ||
    head.startsWith("[")
  ) {
    return parseJsonFeed(body);
  }
  let doc: Node;
  try {
    doc = parser.parse(body) as Node;
  } catch {
    throw new Error("无法识别的订阅格式:XML 解析失败");
  }
  if (doc.rss) return parseRss2(doc);
  if (doc.feed) return parseAtom(doc);
  if (doc["rdf:RDF"]) return parseRdf(doc);
  throw new Error("无法识别的订阅格式:不是 RSS/Atom/JSON Feed");
}
