import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GREADER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { READ_TAG, STARRED_TAG, deriveToken } from "../src/lib/greader";
import { putSetting } from "../src/lib/settings";

const PASSWORD = "0123456789abcdef0123456789abcdef";
let token = "";

async function enable(): Promise<string> {
  await putSetting(env.DB, SETTING_KEYS.greaderAuth, { username: GREADER_USERNAME, password: PASSWORD });
  token = await deriveToken({ username: GREADER_USERNAME, password: PASSWORD });
  return token;
}

function loginBody(output?: string): URLSearchParams {
  const body = new URLSearchParams({ Email: GREADER_USERNAME, Passwd: PASSWORD });
  if (output) body.set("output", output);
  return body;
}

async function clientLogin(body: URLSearchParams): Promise<Response> {
  return SELF.fetch("http://example.com/accounts/ClientLogin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function authed(path: string, opts: { method?: string; body?: URLSearchParams } = {}): Promise<Response> {
  return SELF.fetch(`http://example.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `GoogleLogin auth=${token}`,
      ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: opts.body?.toString(),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
  token = "";
});

describe("ClientLogin", () => {
  it("正确凭据返回三行文本令牌", async () => {
    const expected = await enable();
    const res = await clientLogin(loginBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe(`SID=${expected}\nLSID=${expected}\nAuth=${expected}\n`);
  });

  it("output=json 返回 JSON 令牌", async () => {
    const expected = await enable();
    const res = await clientLogin(loginBody("json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ SID: expected, LSID: expected, Auth: expected });
  });

  it("GET 查询参数同样可用", async () => {
    const expected = await enable();
    const url = new URL("http://example.com/accounts/ClientLogin");
    url.search = loginBody().toString();
    const res = await SELF.fetch(url.toString());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Auth=${expected}`);
  });

  it("错误密码与未配置均 401", async () => {
    await enable();
    const wrong = new URLSearchParams({ Email: GREADER_USERNAME, Passwd: "wrong" });
    expect((await clientLogin(wrong)).status).toBe(401);
    await env.DB.exec("DELETE FROM settings");
    expect((await clientLogin(loginBody())).status).toBe(401);
  });
});

describe("令牌与用户信息", () => {
  it("token 端点返回同一令牌", async () => {
    const expected = await enable();
    const res = await authed("/reader/api/0/token");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expected);
  });

  it("user-info 返回标准字段", async () => {
    await enable();
    const res = await authed("/reader/api/0/user-info");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: "1",
      userName: GREADER_USERNAME,
      userProfileId: "1",
      userEmail: GREADER_USERNAME,
    });
  });

  it("缺失/错误 / 非 GoogleLogin 头均 401", async () => {
    await enable();
    expect((await SELF.fetch("http://example.com/reader/api/0/user-info")).status).toBe(401);
    const wrong = await SELF.fetch("http://example.com/reader/api/0/user-info", {
      headers: { Authorization: "GoogleLogin auth=readly/deadbeef" },
    });
    expect(wrong.status).toBe(401);
    const bearer = await SELF.fetch("http://example.com/reader/api/0/user-info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bearer.status).toBe(401);
  });

  it("/api/* 仍受 AUTH_TOKEN 保护", async () => {
    await enable();
    expect((await SELF.fetch("http://example.com/api/articles")).status).toBe(401);
  });
});

async function seedLibrary(): Promise<{ categoryId: number; emptyCategoryId: number; feedA: number; feedB: number; feedC: number }> {
  const category = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES ('科技', 1)").run();
  const empty = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES ('空分类', 2)").run();
  const categoryId = Number(category.meta.last_row_id);
  const feedA = await env.DB.prepare(
    "INSERT INTO feeds (url, title, site_url, icon_url, category_id, sort_order, last_fetched_at) VALUES ('https://a.example.com/rss', '源A', 'https://a.example.com', 'https://a.example.com/icon.png', ?, 1, '2026-10-01T00:00:00.000Z')"
  ).bind(categoryId).run();
  const feedB = await env.DB.prepare(
    "INSERT INTO feeds (url, title, category_id, sort_order) VALUES ('https://b.example.com/rss', '源B', ?, 2)"
  ).bind(categoryId).run();
  const feedC = await env.DB.prepare(
    "INSERT INTO feeds (url, title, sort_order) VALUES ('https://c.example.com/rss', '源C', 3)"
  ).run();
  return {
    categoryId,
    emptyCategoryId: Number(empty.meta.last_row_id),
    feedA: Number(feedA.meta.last_row_id),
    feedB: Number(feedB.meta.last_row_id),
    feedC: Number(feedC.meta.last_row_id),
  };
}

async function insertArticle(feedId: number, guid: string, publishedAt: string): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO articles (feed_id, guid, title, published_at) VALUES (?, ?, ?, ?)"
  ).bind(feedId, guid, `文章 ${guid}`, publishedAt).run();
  return Number(result.meta.last_row_id);
}

describe("订阅列表、标签与未读计数", () => {
  it("subscription/list 含分类与未分类", async () => {
    await enable();
    const ids = await seedLibrary();
    const res = await authed("/reader/api/0/subscription/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: Record<string, unknown>[] };
    expect(body.subscriptions).toEqual([
      {
        id: `feed/${ids.feedA}`,
        title: "源A",
        url: "https://a.example.com/rss",
        htmlUrl: "https://a.example.com",
        iconUrl: "https://a.example.com/icon.png",
        categories: [{ id: "user/-/label/科技", label: "科技", type: "folder" }],
      },
      {
        id: `feed/${ids.feedB}`,
        title: "源B",
        url: "https://b.example.com/rss",
        htmlUrl: "",
        iconUrl: "",
        categories: [{ id: "user/-/label/科技", label: "科技", type: "folder" }],
      },
      {
        id: `feed/${ids.feedC}`,
        title: "源C",
        url: "https://c.example.com/rss",
        htmlUrl: "",
        iconUrl: "",
        categories: [],
      },
    ]);
  });

  it("tag/list 含四个系统标签与分类 label", async () => {
    await enable();
    await seedLibrary();
    const body = (await (await authed("/reader/api/0/tag/list")).json()) as { tags: Record<string, unknown>[] };
    expect(body.tags).toEqual([
      { id: "user/-/state/com.google/starred" },
      { id: "user/-/state/com.google/read" },
      { id: "user/-/state/com.google/reading-list" },
      { id: "user/-/state/com.google/kept-unread" },
      { id: "user/-/label/科技", label: "科技", type: "folder" },
      { id: "user/-/label/空分类", label: "空分类", type: "folder" },
    ]);
  });

  it("unread-count 统计 feed/label/reading-list,all=1 含零未读", async () => {
    await enable();
    const ids = await seedLibrary();
    const a1 = await insertArticle(ids.feedA, "a1", "2026-10-01T00:00:01.000Z");
    const a2 = await insertArticle(ids.feedA, "a2", "2026-10-01T00:00:02.000Z");
    await insertArticle(ids.feedB, "b1", "2026-10-01T00:00:03.000Z");
    await insertArticle(ids.feedC, "c1", "2026-10-01T00:00:04.000Z");
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read) VALUES (?, 1)").bind(a1).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read) VALUES (?, 1)").bind(a2).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read) VALUES (?, 1)").bind(
      (await env.DB.prepare("SELECT id FROM articles WHERE guid = 'b1'").first<{ id: number }>())!.id
    ).run();

    const normal = (await (await authed("/reader/api/0/unread-count")).json()) as {
      max: number;
      unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[];
    };
    expect(normal.max).toBe(1);
    expect(normal.unreadcounts).toEqual([
      { id: `feed/${ids.feedC}`, count: 1, newestItemTimestampUsec: "1790812804000000" },
      { id: "user/-/state/com.google/reading-list", count: 1, newestItemTimestampUsec: "1790812804000000" },
    ]);

    const withAll = (await (await authed("/reader/api/0/unread-count?all=1")).json()) as {
      unreadcounts: { id: string; count: number }[];
    };
    expect(withAll.unreadcounts).toEqual([
      { id: `feed/${ids.feedA}`, count: 0, newestItemTimestampUsec: "1790812802000000" },
      { id: `feed/${ids.feedB}`, count: 0, newestItemTimestampUsec: "1790812803000000" },
      { id: `feed/${ids.feedC}`, count: 1, newestItemTimestampUsec: "1790812804000000" },
      { id: "user/-/label/科技", count: 0, newestItemTimestampUsec: "1790812803000000" },
      { id: "user/-/label/空分类", count: 0, newestItemTimestampUsec: "0" },
      { id: "user/-/state/com.google/reading-list", count: 1, newestItemTimestampUsec: "1790812804000000" },
    ]);
  });
});

async function seedManyArticles(count = 120): Promise<{ feedId: number; ids: number[] }> {
  const feed = await env.DB.prepare(
    "INSERT INTO feeds (url, title) VALUES ('https://many.example.com/rss', '批量源')"
  ).run();
  const feedId = Number(feed.meta.last_row_id);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i += 1) {
    const publishedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    statements.push(
      env.DB.prepare(
        "INSERT INTO articles (feed_id, guid, title, url, author, published_at, excerpt, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        feedId,
        `g${i}`,
        `文章${i}`,
        `https://many.example.com/${i}`,
        i === 0 ? null : `作者${i}`,
        publishedAt,
        `摘要${i}`,
        `<p>正文${i}</p>`
      )
    );
  }
  const results: D1Result<unknown>[] = [];
  for (let start = 0; start < statements.length; start += 50) {
    results.push(...(await env.DB.batch(statements.slice(start, start + 50))));
  }
  return { feedId, ids: results.map((result) => Number(result.meta.last_row_id)) };
}

describe("文章流", () => {
  it("items/ids:默认最新优先、r=o 升序、n 上限、continuation 往返", async () => {
    await enable();
    const { feedId, ids } = await seedManyArticles();
    const page1 = (await (
      await authed(`/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=10`)
    ).json()) as { itemRefs: { id: string }[]; continuation?: string };
    expect(page1.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(-10).reverse());
    expect(page1.continuation).toBeTruthy();

    const page2 = (await (
      await authed(
        `/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=10&c=${encodeURIComponent(page1.continuation!)}`
      )
    ).json()) as { itemRefs: { id: string }[] };
    expect(page2.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(-20, -10).reverse());

    const oldest = (await (
      await authed(`/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=5&r=o`)
    ).json()) as { itemRefs: { id: string }[] };
    expect(oldest.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(0, 5));

    const feedStream = (await (
      await authed(`/reader/api/0/stream/items/ids?s=feed/${feedId}&n=3`)
    ).json()) as { itemRefs: { id: string }[] };
    expect(feedStream.itemRefs).toHaveLength(3);
  });

  it("items/ids:xt/it/ot/nt 过滤与未知流", async () => {
    await enable();
    const { ids } = await seedManyArticles(5);
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 1, 1)").bind(ids[0]).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 0, 1)").bind(ids[1]).run();

    const unread = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&xt=user/-/state/com.google/read&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(unread.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(1));

    const starred = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/starred&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(starred.itemRefs.map((ref) => Number(ref.id))).toEqual([ids[0], ids[1]]);

    const readOnly = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&it=user/-/state/com.google/read&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(readOnly.itemRefs.map((ref) => Number(ref.id))).toEqual([ids[0]]);

    const since = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&ot=1767225603&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(since.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(3));

    const until = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&nt=1767225603&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(until.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(0, 4));

    const window = (await (
      await authed(
        "/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&ot=1767225602&nt=1767225603&r=o"
      )
    ).json()) as { itemRefs: { id: string }[] };
    expect(window.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(2, 4));

    const usecWindow = (await (
      await authed(
        "/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&ot=1767225602000000&nt=1767225603000000&r=o"
      )
    ).json()) as { itemRefs: { id: string }[] };
    expect(usecWindow.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(2, 4));

    const unknown = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/broadcast")
    ).json()) as { itemRefs: unknown[] };
    expect(unknown.itemRefs).toEqual([]);
  });

  it("stream/contents 路径流、item 形状与分页", async () => {
    await enable();
    const { feedId, ids } = await seedManyArticles(3);
    await env.DB.prepare("UPDATE articles SET content_full = '<p>全文0</p>' WHERE id = ?").bind(ids[0]).run();
    await env.DB.prepare("UPDATE articles SET content = NULL WHERE id = ?").bind(ids[1]).run();

    const body = (await (
      await authed("/reader/api/0/stream/contents/feed/" + feedId + "?r=o")
    ).json()) as { id: string; updated: number; items: Record<string, unknown>[] };
    expect(body.id).toBe(`feed/${feedId}`);
    expect(typeof body.updated).toBe("number");
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({
      id: "tag:google.com,2005:reader/item/" + ids[0]!.toString(16).padStart(16, "0"),
      title: "文章0",
      author: "",
      published: 1767225600,
      updated: 1767225600,
      crawlTimeMsec: "1767225600000",
      timestampUsec: "1767225600000000",
      alternate: [{ href: "https://many.example.com/0", type: "text/html" }],
      canonical: [{ href: "https://many.example.com/0" }],
      summary: { direction: "ltr", content: "摘要0" },
      content: { direction: "ltr", content: "<p>全文0</p>" },
      categories: ["user/-/state/com.google/reading-list"],
      origin: { streamId: `feed/${feedId}`, title: "批量源", htmlUrl: "" },
    });
    expect((body.items[1]!.content as { content: string }).content).toBe("摘要1");

    const page1 = (await (
      await authed(`/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=2`)
    ).json()) as { items: Record<string, unknown>[]; continuation?: string };
    expect(page1.items).toHaveLength(2);
    expect(page1.continuation).toBeTruthy();
    const page2 = (await (
      await authed(
        `/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=2&c=${encodeURIComponent(page1.continuation!)}`
      )
    ).json()) as { items: Record<string, unknown>[] };
    expect(page2.items).toHaveLength(1);

    const bounded = (await (
      await authed(
        "/reader/api/0/stream/contents/user/-/state/com.google/reading-list?ot=1767225601&nt=1767225602&r=o"
      )
    ).json()) as { items: Record<string, unknown>[] };
    expect(bounded.items.map((item) => item.title)).toEqual(["文章1", "文章2"]);

    const viaFormStream = new URLSearchParams({
      s: "user/-/state/com.google/reading-list",
      n: "2",
      r: "o",
    });
    const viaForm = (await (
      await authed("/reader/api/0/stream/contents/", { method: "POST", body: viaFormStream })
    ).json()) as { items: Record<string, unknown>[] };
    expect(viaForm.items.map((item) => item.title)).toEqual(["文章0", "文章1"]);
  });

  it("stream/items/contents 支持长格式与十进制、保持顺序", async () => {
    await enable();
    const { ids } = await seedManyArticles(3);
    const long = `tag:google.com,2005:reader/item/${ids[2]!.toString(16).padStart(16, "0")}`;
    const body = new URLSearchParams();
    body.append("i", long);
    body.append("i", String(ids[1]));
    body.append("i", String(ids[0]));
    body.append("i", "999999");
    const res = await authed("/reader/api/0/stream/items/contents", { method: "POST", body });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { items: { id: string; title: string }[] };
    expect(payload.items.map((item) => item.title)).toEqual(["文章2", "文章1", "文章0"]);
  });
});

async function stateOf(id: number): Promise<{ is_read: number; is_starred: number } | null> {
  return env.DB.prepare("SELECT is_read, is_starred FROM article_states WHERE article_id = ?")
    .bind(id)
    .first<{ is_read: number; is_starred: number }>();
}

describe("写操作", () => {
  it("edit-tag 批量已读/未读,保留收藏", async () => {
    await enable();
    const { ids } = await seedManyArticles(3);
    await env.DB.prepare("INSERT INTO article_states (article_id, is_starred, starred_at) VALUES (?, 1, '2026-10-01T00:00:00.000Z')")
      .bind(ids[0])
      .run();

    const readBody = new URLSearchParams();
    readBody.append("i", String(ids[0]));
    readBody.append("i", String(ids[1]));
    readBody.set("a", READ_TAG);
    let res = await authed("/reader/api/0/edit-tag", { method: "POST", body: readBody });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 1, is_starred: 1 });
    expect(await stateOf(ids[1]!)).toEqual({ is_read: 1, is_starred: 0 });

    const unreadBody = new URLSearchParams();
    unreadBody.set("i", String(ids[0]));
    unreadBody.set("r", READ_TAG);
    await authed("/reader/api/0/edit-tag", { method: "POST", body: unreadBody });
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 0, is_starred: 1 });
  });

  it("edit-tag 收藏/取消收藏并忽略 label", async () => {
    await enable();
    const { ids } = await seedManyArticles(1);
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, read_at) VALUES (?, 1, '2026-10-01T00:00:00.000Z')")
      .bind(ids[0])
      .run();

    const save = new URLSearchParams();
    save.set("i", String(ids[0]));
    save.append("a", STARRED_TAG);
    save.append("a", "user/-/label/科技");
    await authed("/reader/api/0/edit-tag", { method: "POST", body: save });
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 1, is_starred: 1 });

    const unsave = new URLSearchParams();
    unsave.set("i", String(ids[0]));
    unsave.set("r", STARRED_TAG);
    await authed("/reader/api/0/edit-tag", { method: "POST", body: unsave });
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 1, is_starred: 0 });
  });

  it("edit-tag 支持长格式 ID 与不存在的 id", async () => {
    await enable();
    const { ids } = await seedManyArticles(1);
    const body = new URLSearchParams();
    body.set("i", `tag:google.com,2005:reader/item/${ids[0]!.toString(16).padStart(16, "0")}`);
    body.set("a", READ_TAG);
    const res = await authed("/reader/api/0/edit-tag", { method: "POST", body });
    expect(await res.text()).toBe("OK");
    expect((await stateOf(ids[0]!))?.is_read).toBe(1);

    const missing = new URLSearchParams();
    missing.set("i", "999999");
    missing.set("a", READ_TAG);
    expect((await authed("/reader/api/0/edit-tag", { method: "POST", body: missing })).status).toBe(200);
  });

  it("edit-tag 批量超过 100 条(验证不触 D1 绑定参数上限)", async () => {
    await enable();
    const { ids } = await seedManyArticles(120);
    const body = new URLSearchParams();
    for (const id of ids) body.append("i", String(id));
    body.set("a", READ_TAG);
    const res = await authed("/reader/api/0/edit-tag", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM article_states WHERE is_read = 1").first<{ n: number }>();
    expect(count?.n).toBe(120);
  });

  it("mark-all-as-read 按 feed/分类/全部/starred 与 ts 过滤", async () => {
    await enable();
    const category = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES ('科技', 1)").run();
    const categoryId = Number(category.meta.last_row_id);
    const feed1 = await env.DB.prepare(
      "INSERT INTO feeds (url, title, category_id, sort_order) VALUES ('https://f1.example.com/rss', '源1', ?, 1)"
    ).bind(categoryId).run();
    const feed2 = await env.DB.prepare(
      "INSERT INTO feeds (url, title, sort_order) VALUES ('https://f2.example.com/rss', '源2', 2)"
    ).run();
    const feed1Id = Number(feed1.meta.last_row_id);
    const feed2Id = Number(feed2.meta.last_row_id);
    const a1 = await insertArticle(feed1Id, "a1", "2026-10-01T00:00:01.000Z");
    const a2 = await insertArticle(feed1Id, "a2", "2026-10-01T00:00:02.000Z");
    const b1 = await insertArticle(feed2Id, "b1", "2026-10-01T00:00:03.000Z");
    const b2 = await insertArticle(feed2Id, "b2", "2026-10-01T00:00:04.000Z");
    await env.DB.prepare("INSERT INTO article_states (article_id, is_starred) VALUES (?, 1)").bind(b2).run();

    const feedBody = new URLSearchParams({
      s: `feed/${feed1Id}`,
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:02.000Z") / 1000)),
    });
    let res = await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: feedBody });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect((await stateOf(a1))?.is_read).toBe(1);
    expect((await stateOf(a2))?.is_read ?? 0).toBe(0); // published_at == ts,不早于
    expect((await stateOf(b1))?.is_read ?? 0).toBe(0);

    const labelBody = new URLSearchParams({
      s: "user/-/label/科技",
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:03.000Z") / 1000)),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: labelBody });
    expect((await stateOf(a2))?.is_read).toBe(1);

    const starBody = new URLSearchParams({
      s: "user/-/state/com.google/starred",
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:05.000Z") / 1000)),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: starBody });
    expect((await stateOf(b2))?.is_read).toBe(1);

    const allBody = new URLSearchParams({
      s: "user/-/state/com.google/reading-list",
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:06.000Z") / 1000)),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: allBody });
    expect((await stateOf(b1))?.is_read).toBe(1);

    const invalid = new URLSearchParams({ s: "user/-/state/com.google/broadcast", ts: "1" });
    const invalidRes = await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: invalid });
    expect(invalidRes.status).toBe(200);
    expect(await invalidRes.text()).toBe("OK");
  });

  it("mark-all-as-read 接受毫秒与微秒时间戳", async () => {
    await enable();
    const feed = await env.DB.prepare(
      "INSERT INTO feeds (url, title) VALUES ('https://ms.example.com/rss', '毫秒源')"
    ).run();
    const feedId = Number(feed.meta.last_row_id);
    const id = await insertArticle(feedId, "m1", "2026-10-01T00:00:01.000Z");
    const body = new URLSearchParams({
      s: `feed/${feedId}`,
      ts: String(Date.parse("2026-10-01T00:00:02.000Z")),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body });
    expect((await stateOf(id))?.is_read).toBe(1);

    const usecId = await insertArticle(feedId, "m2", "2026-10-01T00:00:03.000Z");
    const usecBody = new URLSearchParams({
      s: `feed/${feedId}`,
      ts: String(Date.parse("2026-10-01T00:00:04.000Z") * 1000),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: usecBody });
    expect((await stateOf(usecId))?.is_read).toBe(1);
  });
});
