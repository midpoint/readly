import { describe, expect, it, vi } from "vitest";
import { discoverFeeds } from "../src/lib/discover";

const HTML_PAGE = `<!doctype html><html><head>
<title>我的博客</title>
<link rel="alternate" type="application/rss+xml" title="RSS 订阅" href="/feed.xml">
<link rel="alternate" type="application/atom+xml" title="Atom" href="https://blog.example.com/atom.xml">
<link rel="stylesheet" href="/style.css">
</head><body>hi</body></html>`;

describe("discoverFeeds", () => {
  it("从页面 <link rel=alternate> 提取并解析相对地址", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(HTML_PAGE, { status: 200, headers: { "Content-Type": "text/html" } })
    );
    const out = await discoverFeeds("https://blog.example.com/", fetchMock as unknown as typeof fetch);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ url: "https://blog.example.com/feed.xml", title: "RSS 订阅", type: "application/rss+xml" });
    expect(out[1]!.url).toBe("https://blog.example.com/atom.xml");
  });

  it("目标本身是 feed 时直接返回", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>', {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      })
    );
    const out = await discoverFeeds("https://example.com/feed", fetchMock as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://example.com/feed");
  });

  it("页面无 link 时探测常见路径", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "https://example.com/") return Promise.resolve(new Response("<html><head><title>t</title></head></html>", { status: 200 }));
      if (url === "https://example.com/feed") return Promise.resolve(new Response("<rss version=\"2.0\"><channel><title>f</title></channel></rss>", { status: 200 }));
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const out = await discoverFeeds("https://example.com/", fetchMock as unknown as typeof fetch);
    expect(out.map((c) => c.url)).toEqual(["https://example.com/feed"]);
  });

  it("无任何结果返回空数组", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html><head><title>t</title></head></html>", { status: 200 }));
    expect(await discoverFeeds("https://example.com/", fetchMock as unknown as typeof fetch)).toEqual([]);
  });
});
