import { describe, expect, it } from "vitest";
import { exportOpml, parseOpml } from "@/modules/opml";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>订阅列表</title></head>
  <body>
    <outline text="科技">
      <outline type="rss" text="少数派" title="少数派" xmlUrl="https://sspai.com/feed" htmlUrl="https://sspai.com"/>
      <outline type="rss" text="IT之家" xmlUrl="https://www.ithome.com/rss/"/>
    </outline>
    <outline text="独立源" type="rss" xmlUrl="https://blog.example.com/atom.xml" title="独立博客"/>
    <outline text="空分类"></outline>
  </body>
</opml>`;

describe("parseOpml", () => {
  it("解析分类与未分类,去重", () => {
    const r = parseOpml(SAMPLE);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0]!.name).toBe("科技");
    expect(r.categories[0]!.feeds.map((f) => f.url)).toEqual(["https://sspai.com/feed", "https://www.ithome.com/rss/"]);
    expect(r.categories[0]!.feeds[0]!.title).toBe("少数派");
    expect(r.categories[0]!.feeds[0]!.siteUrl).toBe("https://sspai.com");
    expect(r.uncategorized).toHaveLength(1);
    expect(r.uncategorized[0]!.title).toBe("独立博客");
  });

  it("重复 url 只保留一次", () => {
    const dup = `<opml version="2.0"><body>
      <outline text="A"><outline type="rss" xmlUrl="https://x.example.com/feed" text="X1"/></outline>
      <outline type="rss" xmlUrl="https://x.example.com/feed" text="X2"/>
    </body></opml>`;
    const r = parseOpml(dup);
    expect(r.categories[0]!.feeds).toHaveLength(1);
    expect(r.uncategorized).toHaveLength(0);
  });

  it("非 OPML 抛错", () => {
    expect(() => parseOpml("<html></html>")).toThrow(/OPML/);
  });
});

describe("exportOpml", () => {
  it("roundtrip:导出后再解析结构一致", () => {
    const cats = [
      { name: "科技", feeds: [{ url: "https://sspai.com/feed", title: "少数派 & 朋友", siteUrl: "https://sspai.com" }] },
      { name: "设计", feeds: [{ url: "https://d.example.com/rss", title: "Design", siteUrl: null }] },
    ];
    const xml = exportOpml(cats);
    expect(xml).toContain('version="2.0"');
    expect(xml).toContain("&amp;");
    const parsed = parseOpml(xml);
    expect(parsed.categories.map((c) => c.name)).toEqual(["科技", "设计"]);
    expect(parsed.categories[0]!.feeds[0]!.title).toBe("少数派 & 朋友");
    expect(parsed.uncategorized).toHaveLength(0);
  });
});

describe("parseOpml 深层嵌套", () => {
  it("深层嵌套(3 层)的源归入顶层分类,不丢失", () => {
    const nested = `<opml version="2.0"><body>
      <outline text="科技">
        <outline text="AI">
          <outline type="rss" xmlUrl="https://deep.example.com/feed" text="深层源"/>
        </outline>
      </outline>
    </body></opml>`;
    const r = parseOpml(nested);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0]!.name).toBe("科技");
    expect(r.categories[0]!.feeds.map((f) => f.url)).toEqual(["https://deep.example.com/feed"]);
  });
});
