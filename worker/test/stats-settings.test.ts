import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
});

describe("stats", () => {
  it("汇总未读/收藏/稍后与分组计数", async () => {
    const cat = await env.DB.prepare("INSERT INTO categories (name) VALUES ('科技')").run();
    const catId = Number(cat.meta.last_row_id);
    const f1 = await env.DB.prepare("INSERT INTO feeds (url, title, category_id) VALUES ('https://f1.example.com/rss', 'F1', ?)").bind(catId).run();
    const f2 = await env.DB.prepare("INSERT INTO feeds (url, title) VALUES ('https://f2.example.com/rss', 'F2')").run();
    const f1Id = Number(f1.meta.last_row_id);
    const f2Id = Number(f2.meta.last_row_id);
    const a1 = await env.DB.prepare("INSERT INTO articles (feed_id, guid, title, published_at) VALUES (?, 'g1', 't1', '2025-10-13T00:00:00.000Z')").bind(f1Id).run();
    await env.DB.prepare("INSERT INTO articles (feed_id, guid, title, published_at) VALUES (?, 'g2', 't2', '2025-10-13T01:00:00.000Z')").bind(f2Id).run();
    await env.DB.prepare("INSERT INTO articles (feed_id, guid, title, published_at) VALUES (?, 'g3', 't3', '2025-10-13T02:00:00.000Z')").bind(f2Id).run();
    await apiFetch(`/api/articles/${a1.meta.last_row_id}`, { method: "PATCH", body: { is_read: true, is_starred: true, is_later: true } });

    const stats = (await (await apiFetch("/api/stats")).json()) as {
      unreadTotal: number; starredTotal: number; laterTotal: number;
      perFeed: Record<string, number>; perCategory: Record<string, number>;
    };
    expect(stats.unreadTotal).toBe(2);
    expect(stats.starredTotal).toBe(1);
    expect(stats.laterTotal).toBe(1);
    expect(stats.perFeed[String(f2Id)]).toBe(2);
    expect(stats.perFeed[String(f1Id)]).toBeUndefined();
    expect(stats.perCategory[String(catId)]).toBeUndefined();
  });
});

describe("settings", () => {
  it("PUT 后 GET 可读回;坏 JSON 写入被拒", async () => {
    const put = await apiFetch("/api/settings", { method: "PUT", body: { kv: { reader_prefs: { fontSize: 18 } } } });
    expect(put.status).toBe(200);
    const all = (await (await apiFetch("/api/settings")).json()) as Record<string, unknown>;
    expect(all.reader_prefs).toEqual({ fontSize: 18 });

    const badType = await apiFetch("/api/settings", { method: "PUT", body: { kv: [] } });
    expect(badType.status).toBe(400);
    const tooBig = await apiFetch("/api/settings", { method: "PUT", body: { kv: { big: "x".repeat(600 * 1024) } } });
    expect(tooBig.status).toBe(413);
  });
});

describe("refresh route", () => {
  it("无到期源时 done=true", async () => {
    const r = await apiFetch("/api/refresh", { method: "POST" });
    const body = (await r.json()) as { done: boolean; processed: number; remaining: number };
    expect(body.done).toBe(true);
    expect(body.processed).toBe(0);
  });
});
