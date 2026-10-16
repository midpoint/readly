import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";

async function seed(): Promise<{ feedId: number; ids: number[] }> {
  const feed = await env.DB.prepare("INSERT INTO feeds (url, title) VALUES ('https://f.example.com/rss', '测试源')").run();
  const feedId = Number(feed.meta.last_row_id);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await env.DB.prepare(
      "INSERT INTO articles (feed_id, guid, title, url, published_at, excerpt, content) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(feedId, `g${i}`, `文章 ${i}`, `https://f.example.com/${i}`, `2025-10-1${i}T08:00:00.000Z`, `摘要 ${i}`, `<p>正文 ${i}</p>`)
      .run();
    ids.push(Number(r.meta.last_row_id));
  }
  return { feedId, ids };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
});

describe("articles API", () => {
  it("分页游标:每页 2 条,顺序倒序且不重复", async () => {
    await seed();
    const p1 = (await (await apiFetch("/api/articles?limit=2")).json()) as { items: { id: number }[]; nextCursor: string | null };
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]!.id).toBeGreaterThan(p1.items[1]!.id);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await (await apiFetch(`/api/articles?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)).json()) as { items: { id: number }[]; nextCursor: string | null };
    expect(p2.items).toHaveLength(2);
    expect(p2.items[0]!.id).toBeLessThan(p1.items[1]!.id);
    const p3 = (await (await apiFetch(`/api/articles?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`)).json()) as { items: { id: number }[]; nextCursor: string | null };
    expect(p3.items).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();
  });

  it("view=unread 过滤与 PATCH 状态切换", async () => {
    const { ids } = await seed();
    const before = (await (await apiFetch("/api/articles?view=unread")).json()) as { items: unknown[] };
    expect(before.items).toHaveLength(5);
    const patch = await apiFetch(`/api/articles/${ids[0]}`, { method: "PATCH", body: { is_read: true, is_starred: true } });
    const state = (await patch.json()) as { isRead: boolean; isStarred: boolean; isLater: boolean };
    expect(state).toEqual({ isRead: true, isStarred: true, isLater: false });
    const after = (await (await apiFetch("/api/articles?view=unread")).json()) as { items: unknown[] };
    expect(after.items).toHaveLength(4);
    const starred = (await (await apiFetch("/api/articles?view=starred")).json()) as { items: unknown[] };
    expect(starred.items).toHaveLength(1);
    // 部分更新不覆盖其他字段
    await apiFetch(`/api/articles/${ids[0]}`, { method: "PATCH", body: { is_later: true } });
    const detail = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { isStarred: boolean; isLater: boolean };
    expect(detail.isStarred).toBe(true);
    expect(detail.isLater).toBe(true);
  });

  it("unread=1 与 view 组合过滤", async () => {
    const { ids } = await seed();
    await apiFetch(`/api/articles/${ids[0]}`, { method: "PATCH", body: { is_starred: true } });
    await apiFetch(`/api/articles/${ids[1]}`, { method: "PATCH", body: { is_starred: true } });
    await apiFetch(`/api/articles/${ids[1]}`, { method: "PATCH", body: { is_read: true } });
    const starred = (await (await apiFetch("/api/articles?view=starred")).json()) as { items: unknown[] };
    expect(starred.items).toHaveLength(2);
    const starredUnread = (await (await apiFetch("/api/articles?view=starred&unread=1")).json()) as { items: unknown[] };
    expect(starredUnread.items).toHaveLength(1);
    const allUnread = (await (await apiFetch("/api/articles?unread=1")).json()) as { items: unknown[] };
    expect(allUnread.items).toHaveLength(4);
  });

  it("标全部已读(按源),保留已有收藏", async () => {
    const { feedId, ids } = await seed();
    await apiFetch(`/api/articles/${ids[0]}`, { method: "PATCH", body: { is_starred: true } });
    const r = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "feed", id: feedId } } });
    expect(((await r.json()) as { updated: number }).updated).toBe(5);
    const detail = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { isRead: boolean; isStarred: boolean };
    expect(detail.isRead).toBe(true);
    expect(detail.isStarred).toBe(true);
  });

  it("标已读时间档:仅置读距今天数超过档位的未读文章", async () => {
    const { feedId, ids } = await seed();
    // ids[0..1] 改近(1 天前),ids[2..4] 保持 2025 旧日期(远超 30 天)
    const recent = new Date(Date.now() - 86400000).toISOString();
    await env.DB.prepare("UPDATE articles SET published_at = ? WHERE id = ?").bind(recent, ids[0]!).run();
    await env.DB.prepare("UPDATE articles SET published_at = ? WHERE id = ?").bind(recent, ids[1]!).run();

    // all scope + 30 天档
    const r1 = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "all" }, olderThanDays: 30 } });
    expect(((await r1.json()) as { updated: number }).updated).toBe(3);
    const near = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { isRead: boolean };
    expect(near.isRead).toBe(false); // 近文保持未读
    const old = (await (await apiFetch(`/api/articles/${ids[2]}`)).json()) as { isRead: boolean };
    expect(old.isRead).toBe(true); // 旧文已置读
  });

  it("标已读时间档:feed 分支同样生效且不影响近文", async () => {
    const { feedId, ids } = await seed();
    const recent = new Date(Date.now() - 86400000).toISOString();
    for (const id of [ids[0]!, ids[1]!]) {
      await env.DB.prepare("UPDATE articles SET published_at = ? WHERE id = ?").bind(recent, id).run();
    }
    const r = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "feed", id: feedId }, olderThanDays: 30 } });
    expect(((await r.json()) as { updated: number }).updated).toBe(3);
    const near = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { isRead: boolean };
    expect(near.isRead).toBe(false);
  });

  it("标已读时间档:天数非法报 400 invalid_days,库内不变", async () => {
    await seed();
    for (const bad of [0, -1, 1.5, "3"] as unknown[]) {
      const r = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "all" }, olderThanDays: bad } });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("invalid_days");
    }
    const states = await env.DB.prepare("SELECT COUNT(*) c FROM article_states").first<{ c: number }>();
    expect(states!.c).toBe(0);
  });

  it("全文持久化与详情读取", async () => {
    const { ids } = await seed();
    await apiFetch(`/api/articles/${ids[0]}/fulltext`, { method: "POST", body: { content_full: "<p>提取的全文</p>" } });
    const detail = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { contentFull: string | null; hasFullText: boolean; extractedAt: string | null };
    expect(detail.contentFull).toBe("<p>提取的全文</p>");
    expect(detail.hasFullText).toBe(true);
    expect(detail.extractedAt).toBeTruthy();
  });

  it("ai-summary 写入与清除", async () => {
    const { ids } = await seed();
    const put = await apiFetch(`/api/articles/${ids[0]}/ai-summary`, {
      method: "POST",
      body: { summary: { oneLiner: "一句话", points: ["a", "b"] } },
    });
    expect(put.status).toBe(200);
    const detail = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { aiSummary: { oneLiner: string } | null };
    expect(detail.aiSummary?.oneLiner).toBe("一句话");
    await apiFetch(`/api/articles/${ids[0]}/ai-summary`, { method: "POST", body: { summary: null } });
    const cleared = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { aiSummary: null };
    expect(cleared.aiSummary).toBeNull();
  });

  it("镜像接口翻页且不含 ai 字段", async () => {
    await seed();
    const page = (await (await apiFetch("/api/articles/mirror?limit=3")).json()) as { items: { id: number }[]; nextCursorId: number | null };
    expect(page.items).toHaveLength(3);
    expect(page.nextCursorId).toBeTruthy();
    const next = (await (await apiFetch(`/api/articles/mirror?limit=3&cursor_id=${page.nextCursorId}`)).json()) as { items: { id: number }[] };
    expect(next.items).toHaveLength(2);
  });

  it("不存在的文章 404", async () => {
    expect((await apiFetch("/api/articles/999")).status).toBe(404);
    expect((await apiFetch("/api/articles/999", { method: "PATCH", body: { is_read: true } })).status).toBe(404);
  });
});
