export interface OpmlFeed {
  url: string;
  title: string;
  siteUrl: string | null;
}

export interface OpmlResult {
  categories: { name: string; feeds: OpmlFeed[] }[];
  uncategorized: OpmlFeed[];
}

function outlineTitle(el: Element): string {
  return el.getAttribute("title") ?? el.getAttribute("text") ?? el.getAttribute("xmlUrl") ?? "";
}

export function parseOpml(xml: string): OpmlResult {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("OPML 解析失败:XML 格式错误");
  const body = doc.querySelector("body");
  if (!body) throw new Error("OPML 解析失败:缺少 body 节点");

  const categories: OpmlResult["categories"] = [];
  const uncategorized: OpmlFeed[] = [];
  const seen = new Set<string>();

  function toFeed(el: Element): OpmlFeed | null {
    const url = el.getAttribute("xmlUrl");
    if (!url) return null;
    const key = url.trim();
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return { url: key, title: outlineTitle(el).trim() || key, siteUrl: el.getAttribute("htmlUrl") };
  }

  function collectFeeds(el: Element, into: OpmlFeed[]): void {
    for (const child of Array.from(el.children)) {
      if (child.tagName.toLowerCase() !== "outline") continue;
      if (child.getAttribute("xmlUrl")) {
        const feed = toFeed(child);
        if (feed) into.push(feed);
      } else {
        collectFeeds(child, into);
      }
    }
  }

  for (const top of Array.from(body.children)) {
    if (top.tagName.toLowerCase() !== "outline") continue;
    if (top.getAttribute("xmlUrl")) {
      const feed = toFeed(top);
      if (feed) uncategorized.push(feed);
      continue;
    }
    const feeds: OpmlFeed[] = [];
    collectFeeds(top, feeds);
    if (feeds.length > 0) categories.push({ name: outlineTitle(top).trim() || "未命名分类", feeds });
  }

  return { categories, uncategorized };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function exportOpml(categories: { name: string; feeds: OpmlFeed[] }[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head><title>Readly 订阅导出</title></head>",
    "  <body>",
  ];
  for (const cat of categories) {
    lines.push(`    <outline text="${esc(cat.name)}" title="${esc(cat.name)}">`);
    for (const feed of cat.feeds) {
      const attrs = [`type="rss"`, `text="${esc(feed.title)}"`, `title="${esc(feed.title)}"`, `xmlUrl="${esc(feed.url)}"`];
      if (feed.siteUrl) attrs.push(`htmlUrl="${esc(feed.siteUrl)}"`);
      lines.push(`      <outline ${attrs.join(" ")} />`);
    }
    lines.push("    </outline>");
  }
  lines.push("  </body>", "</opml>");
  return lines.join("\n");
}
