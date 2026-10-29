import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GREADER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { deriveToken } from "../src/lib/greader";
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
