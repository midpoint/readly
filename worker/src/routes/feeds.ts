import { Hono } from "hono";
import type { Feed } from "@readly/shared";
import type { Env } from "../env";
import { fail, ok } from "../respond";
import { assertSafeUrl } from "../lib/ssrf";
import { discoverFeeds } from "../lib/discover";
import { fetchFeedIntoDb } from "../lib/refresh";

const feeds = new Hono<{ Bindings: Env }>();

interface Row {
  id: number;
  url: string;
  site_url: string | null;
  title: string;
  description: string | null;
  icon_url: string | null;
  category_id: number | null;
  sort_order: number;
  last_fetched_at: string | null;
  error_count: number;
  last_error: string | null;
  created_at: string;
  unread_count?: number;
}

function toFeed(row: Row): Feed {
  return {
    id: row.id,
    url: row.url,
    siteUrl: row.site_url,
    title: row.title,
    description: row.description,
    iconUrl: row.icon_url,
    categoryId: row.category_id,
    sortOrder: row.sort_order,
    lastFetchedAt: row.last_fetched_at,
    errorCount: row.error_count,
    lastError: row.last_error,
    unreadCount: row.unread_count ?? 0,
    createdAt: row.created_at,
  };
}

const FEED_SELECT = `
  SELECT f.*, (
    SELECT COUNT(*) FROM articles a
    LEFT JOIN article_states s ON s.article_id = a.id
    WHERE a.feed_id = f.id AND COALESCE(s.is_read, 0) = 0
  ) AS unread_count
  FROM feeds f`;

feeds.get("/feeds", async (c) => {
  const rows = await c.env.DB.prepare(`${FEED_SELECT} ORDER BY f.sort_order, f.id`).all<Row>();
  return ok(c, rows.results.map(toFeed));
});

async function categoryExists(db: D1Database, id: number): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM categories WHERE id = ?").bind(id).first<{ id: number }>();
  return row !== null;
}

async function subscribeOne(
  db: D1Database,
  rawUrl: string,
  categoryId: number | null
): Promise<{ ok: true; id: number; url: string; title: string; itemCount: number } | { ok: false; url: string; error: string }> {
  let url: string;
  try {
    url = assertSafeUrl(rawUrl.trim()).toString();
  } catch (e) {
    return { ok: false, url: rawUrl, error: e instanceof Error ? e.message : "地址无效" };
  }
  const existing = await db.prepare("SELECT id, title FROM feeds WHERE url = ?").bind(url).first<{ id: number; title: string }>();
  if (existing) return { ok: false, url, error: "已订阅该源" };

  let id: number;
  try {
    const res = await db.prepare("INSERT INTO feeds (url, title, category_id) VALUES (?, ?, ?)").bind(url, url, categoryId).run();
    id = Number(res.meta.last_row_id);
  } catch (e) {
    // 并发重复订阅撞 url UNIQUE、或残余约束错误:优雅报告而非整批 500
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, url, error: /UNIQUE|constraint/i.test(msg) ? "已订阅该源" : "订阅写入失败" };
  }
  try {
    const r = await fetchFeedIntoDb(db, { id, url, lastEtag: null, lastModified: null }, { initialLimit: 50 });
    const title = r.title ?? url;
    await db
      .prepare("UPDATE feeds SET title = ?, site_url = ?, icon_url = ?, description = ?, last_fetched_at = ?, next_refresh_at = ?, last_etag = ?, last_modified = ? WHERE id = ?")
      .bind(
        title,
        r.siteUrl ?? null,
        r.iconUrl ?? null,
        r.description ?? null,
        new Date().toISOString(),
        new Date(Date.now() + 30 * 60_000).toISOString(),
        r.etag ?? null,
        r.lastModified ?? null,
        id
      )
      .run();
    return { ok: true, id, url, title, itemCount: r.inserted };
  } catch (e) {
    await db.prepare("DELETE FROM feeds WHERE id = ?").bind(id).run();
    return { ok: false, url, error: e instanceof Error ? e.message : "抓取失败" };
  }
}

feeds.post("/feeds", async (c) => {
  const body = await c.req
    .json<{ url?: unknown; urls?: unknown; categoryId?: unknown }>()
    .catch(() => ({}) as { url?: unknown; urls?: unknown; categoryId?: unknown });
  const urls: string[] = [];
  if (typeof body.url === "string") urls.push(body.url);
  if (Array.isArray(body.urls)) urls.push(...body.urls.filter((u): u is string => typeof u === "string"));
  if (urls.length === 0) return fail(c, 400, "invalid_urls", "请提供 url 或 urls");
  if (urls.length > 100) return fail(c, 400, "too_many", "单次最多 100 个地址");
  if (urls.every((u) => !u.trim())) return fail(c, 400, "invalid_urls", "请提供 url 或 urls");
  const categoryId = typeof body.categoryId === "number" ? body.categoryId : null;
  // 先校验分类存在性,整批拒绝;避免外键约束错误逃出逐条循环导致整批 500
  if (categoryId !== null && !(await categoryExists(c.env.DB, categoryId))) {
    return fail(c, 400, "invalid_category", "分类不存在");
  }

  const created: { id: number; url: string; title: string; itemCount: number }[] = [];
  const failed: { url: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const r = await subscribeOne(c.env.DB, key, categoryId);
    if (r.ok) created.push({ id: r.id, url: r.url, title: r.title, itemCount: r.itemCount });
    else failed.push({ url: r.url, error: r.error });
  }
  return ok(c, { created, failed });
});

feeds.post("/feeds/discover", async (c) => {
  const body = await c.req.json<{ url?: unknown }>().catch(() => ({}) as { url?: unknown });
  if (typeof body.url !== "string" || !body.url.trim()) return fail(c, 400, "invalid_url", "请提供网址");
  try {
    return ok(c, await discoverFeeds(body.url.trim()));
  } catch (e) {
    return fail(c, 400, "discover_failed", e instanceof Error ? e.message : "发现失败");
  }
});

feeds.post("/feeds/:id/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  const feed = await c.env.DB.prepare("SELECT id, url, last_etag, last_modified FROM feeds WHERE id = ?")
    .bind(id)
    .first<{ id: number; url: string; last_etag: string | null; last_modified: string | null }>();
  if (!feed) return fail(c, 404, "not_found", "订阅不存在");
  try {
    const r = await fetchFeedIntoDb(c.env.DB, { id: feed.id, url: feed.url, lastEtag: feed.last_etag, lastModified: feed.last_modified });
    await c.env.DB.prepare(
      "UPDATE feeds SET last_fetched_at = ?, error_count = 0, last_error = NULL, last_etag = COALESCE(?, last_etag), last_modified = COALESCE(?, last_modified) WHERE id = ?"
    )
      .bind(new Date().toISOString(), r.etag ?? null, r.lastModified ?? null, id)
      .run();
    return ok(c, { inserted: r.inserted, notModified: r.notModified });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "抓取失败";
    await c.env.DB.prepare("UPDATE feeds SET error_count = error_count + 1, last_error = ? WHERE id = ?").bind(msg, id).run();
    return fail(c, 502, "fetch_failed", msg);
  }
});

feeds.patch("/feeds/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ title?: unknown; categoryId?: unknown; sortOrder?: unknown }>()
    .catch(() => ({}) as { title?: unknown; categoryId?: unknown; sortOrder?: unknown });
  // 先校验分类存在性再执行 UPDATE,避免外键约束错误 500(categoryId 为 null 表示移到未分类,合法)
  if (typeof body.categoryId === "number" && !(await categoryExists(c.env.DB, body.categoryId))) {
    return fail(c, 400, "invalid_category", "分类不存在");
  }
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (typeof body.title === "string" && body.title.trim()) {
    sets.push("title = ?");
    values.push(body.title.trim());
  }
  if (body.categoryId === null || typeof body.categoryId === "number") {
    sets.push("category_id = ?");
    values.push(body.categoryId as number | null);
  }
  if (typeof body.sortOrder === "number") {
    sets.push("sort_order = ?");
    values.push(body.sortOrder);
  }
  if (sets.length === 0) return fail(c, 400, "nothing_to_update", "没有可更新字段");
  values.push(id);
  let changes = 0;
  try {
    const res = await c.env.DB.prepare(`UPDATE feeds SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
    changes = res.meta.changes ?? 0;
  } catch {
    // 残余约束错误(如分类在存在性检查后被并发删除)兜底为 400 而非 500
    return fail(c, 400, "invalid_category", "分类不存在");
  }
  if (!changes) return fail(c, 404, "not_found", "订阅不存在");
  const row = await c.env.DB.prepare(`${FEED_SELECT} WHERE f.id = ?`).bind(id).first<Row>();
  return ok(c, toFeed(row!));
});

feeds.delete("/feeds/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "订阅不存在");
  return ok(c, { ok: true });
});

export default feeds;
