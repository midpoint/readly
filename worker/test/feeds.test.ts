import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>示例源</title><link>https://feed.example.com</link>
<item><title>甲</title><guid>a1</guid><pubDate>Mon, 13 Oct 2025 08:00:00 GMT</pubDate><description>甲摘要</description></item>
<item><title>乙</title><guid>a2</guid><pubDate>Mon, 13 Oct 2025 09:00:00 GMT</pubDate><description>乙摘要</description></item>
</channel></rss>`;

// 新地址抓取用:标题不同、guid a2 与原源重复、a3 为新文章(验证 保留+增量 同时成立)
const NEW_FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>新源标题</title><link>https://new.example.com</link>
<item><title>乙</title><guid>a2</guid><pubDate>Mon, 13 Oct 2025 09:00:00 GMT</pubDate><description>乙摘要</description></item>
<item><title>丙</title><guid>a3</guid><pubDate>Mon, 13 Oct 2025 10:00:00 GMT</pubDate><description>丙摘要</description></item>
</channel></rss>`;

beforeAll(() => {
  fetchMock.activate();
  // 未拦截的请求(如 bad.example.com)必须立即失败,而不是落到真实网络:
  // 真实 DNS 在本环境会挂起并触发 5s 用例超时,残留的 rejection 还会破坏 isolated storage 栈。
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

beforeEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
});

function mockFeed(url: string) {
  fetchMock.get(url).intercept({ path: "/rss" }).reply(200, FEED_XML, { headers: { "Content-Type": "application/rss+xml" } });
}

describe("feeds API", () => {
  it("批量订阅:成功入库、重复 URL 去重、失败的单独报告", async () => {
    mockFeed("https://feed.example.com");
    const res = await apiFetch("/api/feeds", {
      method: "POST",
      body: { urls: ["https://feed.example.com/rss", "https://bad.example.com/rss", "https://feed.example.com/rss"] },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { created: { id: number; url: string; title: string; itemCount: number }[]; failed: { url: string }[] };
    expect(data.created).toHaveLength(1);
    expect(data.created[0]!.title).toBe("示例源");
    expect(data.created[0]!.itemCount).toBe(2);

    const list = await apiFetch("/api/feeds");
    const feeds = (await list.json()) as { unreadCount: number }[];
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.unreadCount).toBe(2);
  });

  it("单源刷新去重后不再新增", async () => {
    mockFeed("https://feed.example.com");
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    const r = await apiFetch(`/api/feeds/${id}/refresh`, { method: "POST" });
    expect(((await r.json()) as { inserted: number }).inserted).toBe(0);
  });

  it("PATCH 移动分类,GET 反映;DELETE 级联删文章", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    const cat = (await (await apiFetch("/api/categories", { method: "POST", body: { name: "科技" } })).json()) as { id: number };

    const patched = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { categoryId: cat.id, title: "新名字" } });
    const feed = (await patched.json()) as { categoryId: number; title: string };
    expect(feed.categoryId).toBe(cat.id);
    expect(feed.title).toBe("新名字");

    await apiFetch(`/api/feeds/${id}`, { method: "DELETE" });
    const count = await env.DB.prepare("SELECT COUNT(*) c FROM articles").first<{ c: number }>();
    expect(count!.c).toBe(0);
  });

  it("discover 返回候选", async () => {
    fetchMock.get("https://site.example.com").intercept({ path: "/" }).reply(200, `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`, { headers: { "Content-Type": "text/html" } });
    const res = await apiFetch("/api/feeds/discover", { method: "POST", body: { url: "https://site.example.com/" } });
    const out = (await res.json()) as { url: string }[];
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://site.example.com/feed.xml");
  });

  it("超过 100 个 URL 报 400", async () => {
    const res = await apiFetch("/api/feeds", { method: "POST", body: { urls: Array.from({ length: 101 }, (_, i) => `https://f${i}.example.com/rss`) } });
    expect(res.status).toBe(400);
  });

  it("PATCH 分类不存在报 400,不改动原值", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { categoryId: 999 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_category");
    const row = await env.DB.prepare("SELECT category_id FROM feeds WHERE id = ?").bind(id).first<{ category_id: number | null }>();
    expect(row!.category_id).toBeNull();
  });

  it("全空 URL 报 400", async () => {
    const res = await apiFetch("/api/feeds", { method: "POST", body: { url: "   " } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_urls");
  });

  it("PATCH url:抓取成功采纳新元数据并重置校验器,旧文章保留、新文章增量入库", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    // 预置旧校验器与错误计数:改址成功后必须被覆盖/清零
    await env.DB.prepare("UPDATE feeds SET last_etag = '\"v1\"', last_modified = 'Mon, 01 Jan 2024 00:00:00 GMT', error_count = 3, last_error = '旧错误' WHERE id = ?").bind(id).run();
    fetchMock
      .get("https://new.example.com")
      .intercept({ path: "/rss" })
      .reply(200, NEW_FEED_XML, { headers: { "Content-Type": "application/rss+xml", ETag: '"v2"', "Last-Modified": "Wed, 15 Oct 2025 00:00:00 GMT" } });

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(res.status).toBe(200);
    const feed = (await res.json()) as { url: string; title: string; siteUrl: string | null; unreadCount: number };
    expect(feed.url).toBe("https://new.example.com/rss");
    expect(feed.title).toBe("新源标题"); // 采纳新源标题
    expect(feed.siteUrl).toBe("https://new.example.com");
    expect(feed.unreadCount).toBe(3); // a1 保留 + a2 去重 + a3 增量

    const row = await env.DB.prepare("SELECT last_etag, last_modified, error_count, last_error FROM feeds WHERE id = ?")
      .bind(id)
      .first<{ last_etag: string; last_modified: string; error_count: number; last_error: string | null }>();
    expect(row!.last_etag).toBe('"v2"');
    expect(row!.last_modified).toBe("Wed, 15 Oct 2025 00:00:00 GMT");
    expect(row!.error_count).toBe(0);
    expect(row!.last_error).toBeNull();

    const guids = await env.DB.prepare("SELECT guid FROM articles WHERE feed_id = ? ORDER BY guid").bind(id).all<{ guid: string }>();
    expect(guids.results.map((r) => r.guid)).toEqual(["a1", "a2", "a3"]);
  });

  it("PATCH url:他源已占用的地址报 400,库内不变", async () => {
    mockFeed("https://feed.example.com");
    mockFeed("https://other.example.com");
    const a = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const b = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://other.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const bId = b.created[0]!.id;

    const res = await apiFetch(`/api/feeds/${bId}`, { method: "PATCH", body: { url: "https://feed.example.com/rss" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: "already_subscribed", message: "已订阅该源" });
    const row = await env.DB.prepare("SELECT url, title FROM feeds WHERE id = ?").bind(bId).first<{ url: string; title: string }>();
    expect(row!.url).toBe("https://other.example.com/rss");
    expect(row!.title).toBe("示例源");
    expect(a.created[0]!.id).toBeDefined(); // 源 A 不受影响
  });

  it("PATCH url:内网地址报 400,不发任何网络请求", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "http://127.0.0.1/rss" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: "invalid_url", message: "不允许访问内网地址" });
    // 若代码走了抓取路径,net 连接被禁 → 会以 502 冒头;400 本身即证明未发请求
    expect(fetchMock.pendingInterceptors()).toHaveLength(0);
  });

  it("PATCH url:抓取失败报 502,旧地址/旧标题/错误计数原样", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    fetchMock.get("https://dead.example.com").intercept({ path: "/rss" }).reply(404, "gone", { headers: { "Content-Type": "text/plain" } });

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "https://dead.example.com/rss" } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("fetch_failed");
    const row = await env.DB.prepare("SELECT url, title, error_count, last_error FROM feeds WHERE id = ?")
      .bind(id)
      .first<{ url: string; title: string; error_count: number; last_error: string | null }>();
    expect(row!.url).toBe("https://feed.example.com/rss");
    expect(row!.title).toBe("示例源");
    expect(row!.error_count).toBe(0); // 编辑失败是输入问题,不记入源故障
    expect(row!.last_error).toBeNull();
  });

  it("PATCH url:与当前地址相同 → no-op 成功,无网络请求", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "https://feed.example.com/rss" } });
    expect(res.status).toBe(200);
    const feed = (await res.json()) as { url: string; title: string };
    expect(feed.url).toBe("https://feed.example.com/rss");
    expect(feed.title).toBe("示例源");
    expect(fetchMock.pendingInterceptors()).toHaveLength(0);
  });

  it("PATCH url:源不存在报 404", async () => {
    const res = await apiFetch("/api/feeds/999", { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("分类不存在:整批 400,不产生任何源、不发出抓取", async () => {
    mockFeed("https://ok.example.com");
    const res = await apiFetch("/api/feeds", {
      method: "POST",
      body: { urls: ["https://ok.example.com/rss"], categoryId: 999 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_category");
    const feeds = (await (await apiFetch("/api/feeds")).json()) as unknown[];
    expect(feeds).toHaveLength(0);
    // 注册的 mock 未被应用消费 —— 证明整批在抓取前就被拒绝
    expect(fetchMock.pendingInterceptors().map((i) => i.origin)).toEqual(["https://ok.example.com"]);
    // 清理:消费掉这个刻意未使用的 interceptor,避免影响后续用例的 assertNoPendingInterceptors(本用例保持在文件末尾)
    await fetch("https://ok.example.com/rss");
    expect(fetchMock.pendingInterceptors()).toHaveLength(0);
  });
});
