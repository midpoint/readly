import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/lib/feed-parser";
import { detectLang, fnv1a, sanitizeFeedHtml, stripHtml } from "../src/lib/text";

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>示例科技</title>
  <link>https://example.com</link>
  <description>科技新闻</description>
  <item>
    <title>大模型价格战开打</title>
    <link>https://example.com/a/1</link>
    <guid isPermaLink="false">post-1</guid>
    <pubDate>Mon, 13 Oct 2025 08:00:00 GMT</pubDate>
    <dc:creator>张三</dc:creator>
    <content:encoded><![CDATA[<p>正文内容<script>alert(1)</script>很长很长的一段话。</p><img src="https://example.com/x.jpg">]]></content:encoded>
    <enclosure url="https://example.com/cover.jpg" type="image/jpeg" />
  </item>
  <item>
    <title>无 guid 的文章</title>
    <description>只有摘要</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 示例</title>
  <link href="https://atom.example.com/" rel="alternate" type="text/html"/>
  <link href="https://atom.example.com/feed.xml" rel="self" type="application/atom+xml"/>
  <icon>https://atom.example.com/icon.png</icon>
  <entry>
    <title>事件聚类是什么</title>
    <id>tag:atom.example.com,2025:e1</id>
    <link href="https://atom.example.com/e1" rel="alternate"/>
    <updated>2025-10-12T10:30:00Z</updated>
    <author><name>李四</name></author>
    <content type="html">&lt;p&gt;聚类把相近文章归组。&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.com">
    <title>RDF 示例</title>
    <link>https://rdf.example.com</link>
  </channel>
  <item rdf:about="https://rdf.example.com/i1">
    <title>RDF 条目一</title>
    <link>https://rdf.example.com/i1</link>
    <dc:date>2025-10-11T09:00:00+08:00</dc:date>
    <description>摘要文本</description>
  </item>
</rdf:RDF>`;

const JSONFEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Feed 示例",
  home_page_url: "https://json.example.com",
  feed_url: "https://json.example.com/feed.json",
  items: [
    {
      id: "j1",
      url: "https://json.example.com/j1",
      title: "JSON 条目",
      date_published: "2025-10-10T00:00:00Z",
      content_html: "<p>Hello <b>world</b></p>",
      image: "https://json.example.com/img.png",
    },
  ],
});

const RSS_NO_GUID = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title>
<item><title>文章A</title><link>https://example.com/stable-link</link></item>
</channel></rss>`;

describe("text 工具", () => {
  it("stripHtml 去标签并折叠空白", () => {
    expect(stripHtml("<p>你好&nbsp; 世界</p><br/><p>第二段</p>")).toBe("你好 世界 第二段");
  });
  it("sanitizeFeedHtml 去脚本/事件/危险协议", () => {
    const out = sanitizeFeedHtml(`<p onclick="x()">a</p><script>bad()</script><a href="javascript:evil()">c</a><iframe src="x"></iframe>`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("iframe");
    expect(out).toContain("<p>a</p>");
  });
  it("detectLang 按 CJK 占比", () => {
    expect(detectLang("大模型价格战开打")).toBe("zh");
    expect(detectLang("AI model price war starts")).toBe("en");
    expect(detectLang("123 !!!")).toBeNull();
  });
  it("fnv1a 稳定且区分输入", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("parseFeed", () => {
  it("解析 RSS2:标题/条目/日期/作者/图片/清洗", () => {
    const r = parseFeed(RSS2);
    expect(r.title).toBe("示例科技");
    expect(r.siteUrl).toBe("https://example.com");
    expect(r.items).toHaveLength(2);
    const it0 = r.items[0]!;
    expect(it0.guid).toBe("post-1");
    expect(it0.url).toBe("https://example.com/a/1");
    expect(it0.publishedAt).toBe("2025-10-13T08:00:00.000Z");
    expect(it0.author).toBe("张三");
    expect(it0.imageUrl).toBe("https://example.com/cover.jpg");
    expect(it0.content).toContain("正文内容");
    expect(it0.content).not.toContain("script");
    expect(it0.excerpt).toContain("正文内容");
    expect(it0.lang).toBe("zh");
  });
  it("缺失 guid/日期时兜底", () => {
    const r = parseFeed(RSS2);
    const it1 = r.items[1]!;
    expect(it1.guid).toMatch(/^[0-9a-f]{8}$/);
    expect(new Date(it1.publishedAt).getTime()).not.toBeNaN();
    expect(it1.excerpt).toBe("只有摘要");
  });
  it("解析 Atom:link 选择、content type=html、icon", () => {
    const r = parseFeed(ATOM);
    expect(r.title).toBe("Atom 示例");
    expect(r.siteUrl).toBe("https://atom.example.com/");
    expect(r.iconUrl).toBe("https://atom.example.com/icon.png");
    const it0 = r.items[0]!;
    expect(it0.guid).toBe("tag:atom.example.com,2025:e1");
    expect(it0.url).toBe("https://atom.example.com/e1");
    expect(it0.publishedAt).toBe("2025-10-12T10:30:00.000Z");
    expect(it0.author).toBe("李四");
    expect(it0.content).toContain("聚类把相近文章归组");
  });
  it("解析 RDF:dc:date 带时区归一化", () => {
    const r = parseFeed(RDF);
    expect(r.items[0]!.publishedAt).toBe("2025-10-11T01:00:00.000Z");
    expect(r.items[0]!.title).toBe("RDF 条目一");
  });
  it("解析 JSON Feed", () => {
    const r = parseFeed(JSONFEED, "application/feed+json");
    expect(r.title).toBe("JSON Feed 示例");
    const it0 = r.items[0]!;
    expect(it0.guid).toBe("j1");
    expect(it0.imageUrl).toBe("https://json.example.com/img.png");
    expect(it0.content).toContain("<b>world</b>");
  });
  it("非 feed 内容抛错", () => {
    expect(() => parseFeed("<html><body>hi</body></html>")).toThrowError(/无法识别/);
  });
  it("缺失 guid 时回退到 link 派生,跨次解析稳定", () => {
    const r = parseFeed(RSS_NO_GUID);
    expect(r.items[0]!.guid).toBe(fnv1a("https://example.com/stable-link"));
  });
});
