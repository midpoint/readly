import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFeedIntoDb, refreshDueFeeds } from "../src/lib/refresh";
import { putSetting } from "../src/lib/settings";

const FEED_XML = (n: number) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>测试源</title><link>https://feed.example.com</link>
${Array.from({ length: n }, (_, i) => `<item><title>文章 ${i}</title><guid>g-${i}</guid><pubDate>Mon, 13 Oct 2025 0${i % 10}:00:00 GMT</pubDate><description>摘要 ${i}</description></item>`).join("")}
</channel></rss>`;

async function insertFeed(url: string, categoryId: number | null = null): Promise<number> {
  const res = await env.DB.prepare("INSERT INTO feeds (url, title, category_id) VALUES (?, ?, ?)").bind(url, url, categoryId).run();
  return Number(res.meta.last_row_id);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM settings;");
});

describe("fetchFeedIntoDb", () => {
  it("首次抓取按 initialLimit 截断并可更新元信息", async () => {
    const id = await insertFeed("https://feed.example.com/rss");
    const fetchMock = vi.fn().mockResolvedValue(new Response(FEED_XML(60), { status: 200 }));
    const r = await fetchFeedIntoDb(env.DB, { id, url: "https://feed.example.com/rss", lastEtag: null, lastModified: null }, { initialLimit: 50, fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.inserted).toBe(50);
    expect(r.title).toBe("测试源");
    const count = await env.DB.prepare("SELECT COUNT(*) c FROM articles WHERE feed_id = ?").bind(id).first<{ c: number }>();
    expect(count!.c).toBe(50);
  });

  it("重复抓取按 guid 去重", async () => {
    const id = await insertFeed("https://feed.example.com/rss");
    // 工厂形式还原 fetch 语义:每次调用返回全新的 Response(响应体是一次性流,复用实例第二次读会因流被锁定而失败)
    const fetchMock = vi.fn().mockImplementation(async () => new Response(FEED_XML(5), { status: 200 }));
    const deps = { id, url: "https://feed.example.com/rss", lastEtag: null, lastModified: null };
    await fetchFeedIntoDb(env.DB, deps, { fetchFn: fetchMock as unknown as typeof fetch });
    const second = await fetchFeedIntoDb(env.DB, deps, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(second.inserted).toBe(0);
  });

  it("304 时不写文章", async () => {
    const id = await insertFeed("https://feed.example.com/rss");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const r = await fetchFeedIntoDb(env.DB, { id, url: "https://feed.example.com/rss", lastEtag: "etag1", lastModified: null }, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.notModified).toBe(true);
    expect(r.inserted).toBe(0);
  });

  it("GBK 源(头无 charset,声明 encoding=gbk)标题与文章标题正确解码", async () => {
    const id = await insertFeed("https://gbk.example.com/rss");
    const ascii = (s: string) => new TextEncoder().encode(s);
    const GBK_WUAI = new Uint8Array([0xce, 0xe1, 0xb0, 0xae, 0xc6, 0xc6, 0xbd, 0xe2]); // 吾爱破解
    const GBK_CESHI = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]); // 测试
    const head = ascii(`<?xml version="1.0" encoding="gbk"?><rss version="2.0"><channel><title>`);
    const mid = ascii(`</title><item><title>`);
    const tail = ascii(`</title><guid>g1</guid><pubDate>Mon, 13 Oct 2025 08:00:00 GMT</pubDate></item></channel></rss>`);
    const body = new Uint8Array(head.byteLength + GBK_WUAI.byteLength + mid.byteLength + GBK_CESHI.byteLength + tail.byteLength);
    let off = 0;
    for (const part of [head, GBK_WUAI, mid, GBK_CESHI, tail]) {
      body.set(part, off);
      off += part.byteLength;
    }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } }));
    const r = await fetchFeedIntoDb(env.DB, { id, url: "https://gbk.example.com/rss", lastEtag: null, lastModified: null }, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.title).toBe("吾爱破解");
    const row = await env.DB.prepare("SELECT title FROM articles WHERE feed_id = ?").bind(id).first<{ title: string }>();
    expect(row!.title).toBe("测试");
  });

  it("charset 走 HTTP 头(gb2312)时同样正确解码", async () => {
    const id = await insertFeed("https://gbk-header.example.com/rss");
    const GBK_WUAI = new Uint8Array([0xce, 0xe1, 0xb0, 0xae, 0xc6, 0xc6, 0xbd, 0xe2]);
    const head = new TextEncoder().encode(`<?xml version="1.0"?><rss version="2.0"><channel><title>`);
    const tail = new TextEncoder().encode(`</title></channel></rss>`);
    const body = new Uint8Array(head.byteLength + GBK_WUAI.byteLength + tail.byteLength);
    body.set(head, 0);
    body.set(GBK_WUAI, head.byteLength);
    body.set(tail, head.byteLength + GBK_WUAI.byteLength);
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body, { status: 200, headers: { "Content-Type": "application/xml; charset=gb2312" } }));
    const r = await fetchFeedIntoDb(env.DB, { id, url: "https://gbk-header.example.com/rss", lastEtag: null, lastModified: null }, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.title).toBe("吾爱破解");
  });
});

describe("refreshDueFeeds", () => {
  it("按 limit 处理到期源并统计 remaining", async () => {
    await insertFeed("https://a.example.com/feed");
    await insertFeed("https://b.example.com/feed");
    await insertFeed("https://c.example.com/feed");
    // 本次用例会连续抓取多个源,同样需要每次调用返回全新的 Response
    const fetchMock = vi.fn().mockImplementation(async () => new Response(FEED_XML(2), { status: 200 }));
    const r = await refreshDueFeeds(env.DB, { limit: 2, fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.processed).toBe(2);
    expect(r.done).toBe(false);
    expect(r.remaining).toBe(1);
    const r2 = await refreshDueFeeds(env.DB, { limit: 2, fetchFn: fetchMock as unknown as typeof fetch });
    expect(r2.processed).toBe(1);
    expect(r2.done).toBe(true);
    expect(r2.remaining).toBe(0);
    const errs = await env.DB.prepare("SELECT COUNT(*) c FROM feeds WHERE error_count > 0").first<{ c: number }>();
    expect(errs!.c).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("失败源指数退避且记录错误", async () => {
    const id = await insertFeed("https://bad.example.com/feed");
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    await refreshDueFeeds(env.DB, { limit: 1, fetchFn: fetchMock as unknown as typeof fetch });
    const row = await env.DB.prepare("SELECT error_count, last_error, next_refresh_at FROM feeds WHERE id = ?").bind(id).first<{ error_count: number; last_error: string; next_refresh_at: string }>();
    expect(row!.error_count).toBe(1);
    expect(row!.last_error).toBeTruthy();
    expect(new Date(row!.next_refresh_at).getTime()).toBeGreaterThan(Date.now());
    // 未到期则不再处理
    const again = await refreshDueFeeds(env.DB, { limit: 1, fetchFn: fetchMock as unknown as typeof fetch });
    expect(again.processed).toBe(0);
  });

  it("读取 settings 的批大小默认值", async () => {
    await putSetting(env.DB, "refresh_batch_size", 1);
    await insertFeed("https://a.example.com/feed");
    await insertFeed("https://b.example.com/feed");
    const fetchMock = vi.fn().mockResolvedValue(new Response(FEED_XML(1), { status: 200 }));
    const r = await refreshDueFeeds(env.DB, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.processed).toBe(1);
  });

  it("settings 非法数值被钳制:batch=0 仍处理 1 个,interval=0 至少 1 分钟", async () => {
    await putSetting(env.DB, "refresh_batch_size", 0);
    await putSetting(env.DB, "refresh_interval", 0);
    const id = await insertFeed("https://clamp.example.com/feed");
    const fetchMock = vi.fn().mockImplementation(async () => new Response(FEED_XML(1), { status: 200 }));
    const before = Date.now();
    const r = await refreshDueFeeds(env.DB, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.processed).toBe(1);
    const row = await env.DB.prepare("SELECT next_refresh_at FROM feeds WHERE id = ?").bind(id).first<{ next_refresh_at: string }>();
    expect(new Date(row!.next_refresh_at).getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("settings 非数值(JSON 字符串)回退默认:批 2、间隔 30 分钟", async () => {
    // HTTP 设置路由校验数值,带引号的 JSON 字符串只能直写库表:JSON.parse 得到字符串 "abc"
    const now = new Date().toISOString();
    const stmt = "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)";
    await env.DB.prepare(stmt).bind("refresh_batch_size", '"abc"', now).run();
    await env.DB.prepare(stmt).bind("refresh_interval", '"abc"', now).run();
    const first = await insertFeed("https://a.example.com/feed");
    await insertFeed("https://b.example.com/feed");
    await insertFeed("https://c.example.com/feed");
    const fetchMock = vi.fn().mockImplementation(async () => new Response(FEED_XML(1), { status: 200 }));
    const before = Date.now();
    const r = await refreshDueFeeds(env.DB, { fetchFn: fetchMock as unknown as typeof fetch });
    expect(r.processed).toBe(2);
    expect(r.remaining).toBe(1);
    const row = await env.DB.prepare("SELECT next_refresh_at FROM feeds WHERE id = ?").bind(first).first<{ next_refresh_at: string }>();
    expect(new Date(row!.next_refresh_at).getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
  });
});
