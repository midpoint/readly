import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FEVER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { md5Hex } from "../src/lib/md5";
import { putSetting } from "../src/lib/settings";

const PASSWORD = "0123456789abcdef0123456789abcdef";
const API_KEY = md5Hex(`${FEVER_USERNAME}:${PASSWORD}`);

interface BaseResponse {
  api_version: number;
  auth: number;
  last_refreshed_on_time?: number;
}

interface FeverItem {
  id: number;
  feed_id: number;
  title: string;
  author: string;
  html: string;
  url: string;
  is_saved: number;
  is_read: number;
  created_on_time: number;
}

interface FeverItemsResponse extends BaseResponse {
  items: FeverItem[];
  total_items: number;
}

async function enable(): Promise<void> {
  await putSetting(env.DB, SETTING_KEYS.feverAuth, { username: FEVER_USERNAME, password: PASSWORD });
}

function feverGet(query = "api"): Promise<Response> {
  const url = new URL("http://example.com/fever/");
  url.search = query;
  if (!url.searchParams.has("api_key")) url.searchParams.set("api_key", API_KEY);
  return SELF.fetch(url.toString());
}

function feverPost(fields: Record<string, string>, query = "api"): Promise<Response> {
  return SELF.fetch(`http://example.com/fever/?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function insertCategory(name: string, sortOrder: number): Promise<number> {
  const result = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES (?, ?)").bind(name, sortOrder).run();
  return Number(result.meta.last_row_id);
}

async function insertFeed(
  url: string,
  title: string,
  opts: { categoryId?: number | null; siteUrl?: string | null; lastFetchedAt?: string | null; sortOrder?: number } = {}
): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO feeds (url, title, site_url, category_id, sort_order, last_fetched_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(url, title, opts.siteUrl ?? null, opts.categoryId ?? null, opts.sortOrder ?? 0, opts.lastFetchedAt ?? null)
    .run();
  return Number(result.meta.last_row_id);
}

async function insertArticle(
  feedId: number,
  guid: string,
  publishedAt: string,
  fields: { title?: string; author?: string | null; url?: string | null; excerpt?: string | null; content?: string | null; contentFull?: string | null } = {}
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO articles (feed_id, guid, title, author, url, published_at, excerpt, content, content_full)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      feedId,
      guid,
      fields.title ?? `文章 ${guid}`,
      fields.author ?? null,
      fields.url ?? null,
      publishedAt,
      fields.excerpt ?? null,
      fields.content ?? null,
      fields.contentFull ?? null
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function seedLibrary(): Promise<{
  techId: number;
  emptyId: number;
  feedA: number;
  feedB: number;
  feedC: number;
  lastFetched: string;
}> {
  const techId = await insertCategory("科技", 1);
  const emptyId = await insertCategory("空分类", 2);
  const lastFetched = "2026-10-01T00:00:00.000Z";
  const feedA = await insertFeed("https://a.example.com/rss", "源A", {
    categoryId: techId,
    siteUrl: "https://a.example.com",
    lastFetchedAt: lastFetched,
    sortOrder: 1,
  });
  const feedB = await insertFeed("https://b.example.com/rss", "源B", { categoryId: techId, sortOrder: 2 });
  const feedC = await insertFeed("https://c.example.com/rss", "源C", { sortOrder: 3 });
  return { techId, emptyId, feedA, feedB, feedC, lastFetched };
}

async function seedManyArticles(count = 120): Promise<{ feedId: number; ids: number[] }> {
  const feedId = await insertFeed("https://many.example.com/rss", "批量源");
  const ids: number[] = [];
  for (let start = 0; start < count; start += 50) {
    const end = Math.min(start + 50, count);
    const statements: D1PreparedStatement[] = [];
    for (let i = start; i < end; i += 1) {
      const publishedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      statements.push(
        env.DB.prepare(
          "INSERT INTO articles (feed_id, guid, title, published_at, excerpt, content) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(feedId, `g${i}`, `文章${i}`, publishedAt, `摘要${i}`, `<p>正文${i}</p>`)
      );
    }
    const results = await env.DB.batch(statements);
    ids.push(...results.map((result) => Number(result.meta.last_row_id)));
  }
  return { feedId, ids };
}

function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

async function stateOf(articleId: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM article_states WHERE article_id = ?").bind(articleId).first<Record<string, unknown>>();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
});

describe("Fever 认证与路径", () => {
  it("未配置返回 HTTP 200 auth 0，且只含两个字段", async () => {
    const res = await feverGet("api");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await json<BaseResponse>(res)).toEqual({ api_version: 3, auth: 0 });
  });

  it("配置为 null / 字段非法时 auth 0", async () => {
    await putSetting(env.DB, SETTING_KEYS.feverAuth, null);
    expect(await json<BaseResponse>(await feverGet("api"))).toEqual({ api_version: 3, auth: 0 });
    await putSetting(env.DB, SETTING_KEYS.feverAuth, { username: "", password: PASSWORD });
    expect(await json<BaseResponse>(await feverPost({ api_key: API_KEY }))).toEqual({ api_version: 3, auth: 0 });
    await putSetting(env.DB, SETTING_KEYS.feverAuth, { username: FEVER_USERNAME, password: "" });
    expect(await json<BaseResponse>(await feverPost({ api_key: API_KEY }))).toEqual({ api_version: 3, auth: 0 });
  });

  it("正确 key 返回基线，last_refreshed_on_time 取最近抓取时间", async () => {
    await enable();
    const { lastFetched } = await seedLibrary();
    const res = await feverPost({ api_key: API_KEY });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await json<BaseResponse>(res)).toEqual({
      api_version: 3,
      auth: 1,
      last_refreshed_on_time: seconds(lastFetched),
    });
  });

  it("错误 key 与缺失 key 均 auth 0", async () => {
    await enable();
    expect(await json<BaseResponse>(await feverPost({ api_key: "deadbeef" }))).toEqual({ api_version: 3, auth: 0 });
    expect(await json<BaseResponse>(await feverPost({}))).toEqual({ api_version: 3, auth: 0 });
    expect(await json<BaseResponse>(await feverGet("api&api_key=bad"))).toEqual({ api_version: 3, auth: 0 });
  });

  it("api_key 大小写均可，查询串与表单均可", async () => {
    await enable();
    const upper = await feverPost({ api_key: API_KEY.toUpperCase() });
    expect((await json<BaseResponse>(upper)).auth).toBe(1);
    const query = await feverGet(`api&api_key=${API_KEY}`);
    expect((await json<BaseResponse>(query)).auth).toBe(1);
  });

  it("三条兼容路径、GET 与 POST 都可访问", async () => {
    await enable();
    for (const path of ["/fever", "/fever/", "/fever.php"]) {
      const res = await SELF.fetch(`http://example.com${path}?api&api_key=${API_KEY}`);
      expect(res.status).toBe(200);
      expect((await json<BaseResponse>(res)).auth).toBe(1);
    }
    const res = await SELF.fetch("http://example.com/fever.php?api", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: API_KEY }).toString(),
    });
    expect((await json<BaseResponse>(res)).auth).toBe(1);

    const multipart = new FormData();
    multipart.set("api_key", API_KEY);
    const upload = await SELF.fetch("http://example.com/fever/?api", { method: "POST", body: multipart });
    expect((await json<BaseResponse>(upload)).auth).toBe(1);
  });

  it("Fever 不需要 Bearer；/api/* 仍受 AUTH_TOKEN 保护", async () => {
    await enable();
    expect((await feverGet("api")).status).toBe(200);
    expect((await SELF.fetch("http://example.com/api/articles")).status).toBe(401);
  });
});

describe("groups / feeds / favicons / links", () => {
  it("groups 返回分类与仅含非空分类的关系", async () => {
    await enable();
    const { techId, emptyId, feedA, feedB } = await seedLibrary();
    const body = await json<{
      groups: { id: number; title: string }[];
      feeds_groups: { group_id: number; feed_ids: string }[];
    }>(await feverGet("api&groups"));
    expect(body.groups).toEqual([
      { id: techId, title: "科技" },
      { id: emptyId, title: "空分类" },
    ]);
    expect(body.feeds_groups).toEqual([{ group_id: techId, feed_ids: `${feedA},${feedB}` }]);
    expect(body).not.toHaveProperty("feeds");
  });

  it("feeds 返回完整字段与 feeds_groups", async () => {
    await enable();
    const { techId, feedA, feedB, feedC, lastFetched } = await seedLibrary();
    const body = await json<{
      feeds: Record<string, unknown>[];
      feeds_groups: { group_id: number; feed_ids: string }[];
    }>(await feverGet("api&feeds"));
    expect(body.feeds).toEqual([
      {
        id: feedA,
        favicon_id: 0,
        title: "源A",
        url: "https://a.example.com/rss",
        site_url: "https://a.example.com",
        is_spark: 0,
        last_updated_on_time: seconds(lastFetched),
      },
      {
        id: feedB,
        favicon_id: 0,
        title: "源B",
        url: "https://b.example.com/rss",
        site_url: "",
        is_spark: 0,
        last_updated_on_time: 0,
      },
      {
        id: feedC,
        favicon_id: 0,
        title: "源C",
        url: "https://c.example.com/rss",
        site_url: "",
        is_spark: 0,
        last_updated_on_time: 0,
      },
    ]);
    expect(body.feeds_groups).toEqual([{ group_id: techId, feed_ids: `${feedA},${feedB}` }]);
    expect(body).not.toHaveProperty("groups");
  });

  it("favicons 与 links 为空数组；空值动作键同样生效", async () => {
    await enable();
    const body = await json<{ favicons: unknown[]; links: unknown[] }>(await feverGet("api&favicons&links"));
    expect(body.favicons).toEqual([]);
    expect(body.links).toEqual([]);
    const post = await json<{ groups: unknown[] }>(await feverPost({ api_key: API_KEY, groups: "" }));
    expect(Array.isArray(post.groups)).toBe(true);
  });
});

describe("items", () => {
  it("max_id=0 返回最新 50 条降序，total_items 为全量", async () => {
    await enable();
    const { feedId, ids } = await seedManyArticles();
    const body = await json<FeverItemsResponse>(await feverGet("api&items&max_id=0"));
    expect(body.total_items).toBe(120);
    expect(body.items.map((item) => item.id)).toEqual(ids.slice(-50).reverse());
    expect(body.items[0]?.feed_id).toBe(feedId);
  });

  it("max_id=N 返回更早的 50 条降序；since_id 返回之后的 50 条升序", async () => {
    await enable();
    const { ids } = await seedManyArticles();
    const older = await json<FeverItemsResponse>(await feverGet(`api&items&max_id=${ids[70]}`));
    expect(older.items.map((item) => item.id)).toEqual(ids.slice(20, 70).reverse());
    const newer = await json<FeverItemsResponse>(await feverGet(`api&items&since_id=${ids[49]}`));
    expect(newer.items.map((item) => item.id)).toEqual(ids.slice(50, 100));
  });

  it("全缺省返回最旧 50 条升序；with_ids 去重、忽略非法值并升序", async () => {
    await enable();
    const { ids } = await seedManyArticles();
    const oldest = await json<FeverItemsResponse>(await feverGet("api&items"));
    expect(oldest.items.map((item) => item.id)).toEqual(ids.slice(0, 50));
    const picked = await json<FeverItemsResponse>(
      await feverGet(`api&items&with_ids=${ids[4]},${ids[2]},${ids[2]},-1,x,${ids[3]}`)
    );
    expect(picked.items.map((item) => item.id)).toEqual([ids[2], ids[3], ids[4]]);
  });

  it("max_id 非法时回退；with_ids 全非法时为空但仍带 total_items", async () => {
    await enable();
    const { ids } = await seedManyArticles();
    const fallback = await json<FeverItemsResponse>(await feverGet(`api&items&max_id=abc&with_ids=${ids[5]}`));
    expect(fallback.items.map((item) => item.id)).toEqual([ids[5]]);
    const since = await json<FeverItemsResponse>(await feverGet(`api&items&max_id=-3&since_id=${ids[100]}`));
    expect(since.items.map((item) => item.id)).toEqual(ids.slice(101));
    const invalid = await json<FeverItemsResponse>(await feverGet("api&items&with_ids=-1,0,x"));
    expect(invalid.items).toEqual([]);
    expect(invalid.total_items).toBe(120);
  });

  it("选择器优先级 max_id > with_ids > since_id", async () => {
    await enable();
    const { ids } = await seedManyArticles();
    const maxWins = await json<FeverItemsResponse>(await feverGet(`api&items&max_id=0&with_ids=${ids[0]}`));
    expect(maxWins.items.map((item) => item.id)).toEqual(ids.slice(-50).reverse());
    const withIdsWins = await json<FeverItemsResponse>(
      await feverGet(`api&items&with_ids=${ids[0]}&since_id=${ids[50]}`)
    );
    expect(withIdsWins.items.map((item) => item.id)).toEqual([ids[0]]);
  });

  it("item 字段与 html 三级回退、状态、created_on_time", async () => {
    await enable();
    const feedId = await insertFeed("https://fields.example.com/rss", "字段源");
    const full = await insertArticle(feedId, "full", "2026-01-02T03:04:05.000Z", {
      contentFull: "<p>全文</p>",
      content: "<p>正文</p>",
      excerpt: "摘要",
    });
    const bodyOnly = await insertArticle(feedId, "body", "2026-01-02T03:04:06.000Z", {
      content: "<p>只有正文</p>",
      excerpt: "摘要2",
    });
    const excerptOnly = await insertArticle(feedId, "excerpt", "2026-01-02T03:04:07.000Z", { excerpt: "只有摘要" });
    const empty = await insertArticle(feedId, "empty", "2026-01-02T03:04:08.000Z");
    await env.DB.prepare(
      "INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 1, 1)"
    ).bind(full).run();

    const res = await json<FeverItemsResponse>(
      await feverGet(`api&items&with_ids=${full},${bodyOnly},${excerptOnly},${empty}`)
    );
    expect(res.items).toEqual([
      {
        id: full,
        feed_id: feedId,
        title: "文章 full",
        author: "",
        html: "<p>全文</p>",
        url: "",
        is_saved: 1,
        is_read: 1,
        created_on_time: seconds("2026-01-02T03:04:05.000Z"),
      },
      {
        id: bodyOnly,
        feed_id: feedId,
        title: "文章 body",
        author: "",
        html: "<p>只有正文</p>",
        url: "",
        is_saved: 0,
        is_read: 0,
        created_on_time: seconds("2026-01-02T03:04:06.000Z"),
      },
      {
        id: excerptOnly,
        feed_id: feedId,
        title: "文章 excerpt",
        author: "",
        html: "只有摘要",
        url: "",
        is_saved: 0,
        is_read: 0,
        created_on_time: seconds("2026-01-02T03:04:07.000Z"),
      },
      {
        id: empty,
        feed_id: feedId,
        title: "文章 empty",
        author: "",
        html: "",
        url: "",
        is_saved: 0,
        is_read: 0,
        created_on_time: seconds("2026-01-02T03:04:08.000Z"),
      },
    ]);
  });
});

describe("unread_item_ids / saved_item_ids", () => {
  it("升序 CSV，含无状态行，空集为空串", async () => {
    await enable();
    const feedId = await insertFeed("https://sync.example.com/rss", "同步源");
    const a = await insertArticle(feedId, "a", "2026-01-01T00:00:01.000Z");
    const b = await insertArticle(feedId, "b", "2026-01-01T00:00:02.000Z");
    const c = await insertArticle(feedId, "c", "2026-01-01T00:00:03.000Z");
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 1, 0)").bind(a).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 0, 1)").bind(c).run();

    const unread = await json<{ unread_item_ids: string }>(await feverGet("api&unread_item_ids"));
    expect(unread.unread_item_ids).toBe(`${b},${c}`);
    const saved = await json<{ saved_item_ids: string }>(await feverGet("api&saved_item_ids"));
    expect(saved.saved_item_ids).toBe(`${c}`);

    await env.DB.prepare("UPDATE article_states SET is_read = 1").run();
    await env.DB.prepare(
      "INSERT INTO article_states (article_id, is_read) VALUES (?, 1) ON CONFLICT(article_id) DO UPDATE SET is_read = 1"
    )
      .bind(b)
      .run();
    const empty = await json<{ unread_item_ids: string }>(await feverGet("api&unread_item_ids"));
    expect(empty.unread_item_ids).toBe("");
  });
});

describe("mark item", () => {
  it("read/unread/saved/unsaved 保留其他标记与首次时间", async () => {
    await enable();
    const feedId = await insertFeed("https://mark.example.com/rss", "标记源");
    const a = await insertArticle(feedId, "a", "2026-01-01T00:00:01.000Z");
    const b = await insertArticle(feedId, "b", "2026-01-01T00:00:02.000Z");
    const c = await insertArticle(feedId, "c", "2026-01-01T00:00:03.000Z");
    await env.DB.prepare(
      "INSERT INTO article_states (article_id, is_read, is_starred, is_later) VALUES (?, 0, 0, 1)"
    ).bind(a).run();
    await env.DB.prepare(
      "INSERT INTO article_states (article_id, is_read, read_at, is_starred, starred_at) VALUES (?, 1, ?, 1, ?)"
    )
      .bind(b, "2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z")
      .run();

    const read = await json<{ unread_item_ids: string }>(
      await feverPost({ api_key: API_KEY, mark: "item", as: "read", id: String(a) })
    );
    expect(read.unread_item_ids).toBe(`${c}`);
    let state = await stateOf(a);
    expect(state?.is_read).toBe(1);
    expect(state?.is_later).toBe(1);
    expect(typeof state?.read_at).toBe("string");

    const unread = await json<{ unread_item_ids: string }>(
      await feverPost({ api_key: API_KEY, mark: "item", as: "unread", id: String(a) })
    );
    expect(unread.unread_item_ids).toBe(`${a},${c}`);
    state = await stateOf(a);
    expect(state?.is_read).toBe(0);
    expect(state?.read_at).toBeNull();
    expect(state?.is_later).toBe(1);

    await feverPost({ api_key: API_KEY, mark: "item", as: "read", id: String(b) });
    state = await stateOf(b);
    expect(state?.read_at).toBe("2020-01-01T00:00:00.000Z");

    const saved = await json<{ saved_item_ids: string }>(
      await feverPost({ api_key: API_KEY, mark: "item", as: "saved", id: String(c) })
    );
    expect(saved.saved_item_ids).toBe(`${b},${c}`);
    state = await stateOf(c);
    expect(state?.is_starred).toBe(1);
    expect(typeof state?.starred_at).toBe("string");

    const unsaved = await json<{ saved_item_ids: string }>(
      await feverPost({ api_key: API_KEY, mark: "item", as: "unsaved", id: String(c) })
    );
    expect(unsaved.saved_item_ids).toBe(`${b}`);
    state = await stateOf(c);
    expect(state?.is_starred).toBe(0);
    expect(state?.starred_at).toBeNull();
  });

  it("批量 id 去重并忽略非法值", async () => {
    await enable();
    const feedId = await insertFeed("https://batch.example.com/rss", "批量标记源");
    const a = await insertArticle(feedId, "a", "2026-01-01T00:00:01.000Z");
    const b = await insertArticle(feedId, "b", "2026-01-01T00:00:02.000Z");
    await feverPost({ api_key: API_KEY, mark: "item", as: "read", id: `${a},${a},${b},-1,x` });
    expect((await stateOf(a))?.is_read).toBe(1);
    expect((await stateOf(b))?.is_read).toBe(1);
  });

  it("非法 as / mark 不落库", async () => {
    await enable();
    const feedId = await insertFeed("https://noop.example.com/rss", "无操作源");
    const a = await insertArticle(feedId, "a", "2026-01-01T00:00:01.000Z");
    await feverPost({ api_key: API_KEY, mark: "item", as: "later", id: String(a) });
    await feverPost({ api_key: API_KEY, mark: "other", as: "read", id: String(a) });
    await feverPost({ api_key: API_KEY, mark: "item", as: "read", id: "99999999" });
    expect(await stateOf(a)).toBeNull();
  });

  it("写操作与读参数同一请求：先写后读", async () => {
    await enable();
    const feedId = await insertFeed("https://combo.example.com/rss", "组合源");
    const a = await insertArticle(feedId, "a", "2026-01-01T00:00:01.000Z");
    const body = await json<FeverItemsResponse & { unread_item_ids: string }>(
      await feverPost(
        { api_key: API_KEY, mark: "item", as: "read", id: String(a) },
        "api&items&unread_item_ids"
      )
    );
    expect(body.items.map((item) => item.id)).toEqual([a]);
    expect(body.items[0]?.is_read).toBe(1);
    expect(body.unread_item_ids).toBe("");
  });
});

describe("mark feed / group", () => {
  async function seedBefore(): Promise<{
    techId: number;
    feedA: number;
    feedB: number;
    times: string[];
    ids: { a1: number; a2: number; a3: number; b1: number; b2: number };
  }> {
    const techId = await insertCategory("科技", 1);
    const feedA = await insertFeed("https://fa.example.com/rss", "源A", { categoryId: techId });
    const feedB = await insertFeed("https://fb.example.com/rss", "源B");
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"];
    const ids = {
      a1: await insertArticle(feedA, "a1", times[0]!),
      a2: await insertArticle(feedA, "a2", times[1]!),
      a3: await insertArticle(feedA, "a3", times[2]!),
      b1: await insertArticle(feedB, "b1", times[0]!),
      b2: await insertArticle(feedB, "b2", times[2]!),
    };
    return { techId, feedA, feedB, times, ids };
  }

  it("feed before 只标该源严格早于截止时间的未读", async () => {
    await enable();
    const { feedA, times, ids } = await seedBefore();
    const body = await json<{ unread_item_ids: string }>(
      await feverPost({
        api_key: API_KEY,
        mark: "feed",
        as: "read",
        id: String(feedA),
        before: String(seconds(times[1]!)),
      })
    );
    expect(body.unread_item_ids).toBe(`${ids.a2},${ids.a3},${ids.b1},${ids.b2}`);
    expect((await stateOf(ids.a1))?.is_read).toBe(1);
    expect((await stateOf(ids.a2))?.is_read).toBeUndefined();
    expect((await stateOf(ids.a3))?.is_read).toBeUndefined();
    expect((await stateOf(ids.b1))?.is_read).toBeUndefined();
  });

  it("group 分类 / id=0 全部 / id=-1 无操作", async () => {
    await enable();
    const { techId, times, ids } = await seedBefore();
    await feverPost({
      api_key: API_KEY,
      mark: "group",
      as: "read",
      id: String(techId),
      before: String(seconds(times[2]!)),
    });
    expect((await stateOf(ids.a1))?.is_read).toBe(1);
    expect((await stateOf(ids.a2))?.is_read).toBe(1);
    expect((await stateOf(ids.a3))?.is_read).toBeUndefined();
    expect((await stateOf(ids.b1))?.is_read).toBeUndefined();

    await feverPost({
      api_key: API_KEY,
      mark: "group",
      as: "read",
      id: "-1",
      before: String(seconds("2030-01-01T00:00:00.000Z")),
    });
    expect((await stateOf(ids.b1))?.is_read).toBeUndefined();

    const all = await json<{ unread_item_ids: string }>(
      await feverPost({
        api_key: API_KEY,
        mark: "group",
        as: "read",
        id: "0",
        before: String(seconds("2030-01-01T00:00:00.000Z")),
      })
    );
    expect(all.unread_item_ids).toBe("");
    expect((await stateOf(ids.a3))?.is_read).toBe(1);
    expect((await stateOf(ids.b1))?.is_read).toBe(1);
    expect((await stateOf(ids.b2))?.is_read).toBe(1);
  });

  it("before 支持毫秒/微秒；缺失/非法取当前时间", async () => {
    await enable();
    const { feedA, times, ids } = await seedBefore();
    await feverPost({
      api_key: API_KEY,
      mark: "feed",
      as: "read",
      id: String(feedA),
      before: String(seconds(times[1]!) * 1000),
    });
    expect((await stateOf(ids.a1))?.is_read).toBe(1);
    expect((await stateOf(ids.a2))?.is_read).toBeUndefined();

    await feverPost({
      api_key: API_KEY,
      mark: "feed",
      as: "read",
      id: String(feedA),
      before: String(seconds(times[2]!) * 1000000),
    });
    expect((await stateOf(ids.a2))?.is_read).toBe(1);
    expect((await stateOf(ids.a3))?.is_read).toBeUndefined();

    await feverPost({ api_key: API_KEY, mark: "feed", as: "read", id: String(feedA) });
    expect((await stateOf(ids.a3))?.is_read).toBe(1);
  });
});
