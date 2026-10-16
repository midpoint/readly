import { Hono } from "hono";
import type { ArticlesPage } from "@readly/shared";
import type { Env } from "../env";
import { fail, ok } from "../respond";
import { toArticleDetail, toArticleListItem, type ArticleRow } from "../lib/article-mapper";

const articles = new Hono<{ Bindings: Env }>();

const BASE_SELECT = `
  SELECT a.id, a.feed_id, f.title AS feed_title, f.icon_url AS feed_icon_url,
         a.title, a.url, a.author, a.published_at, a.excerpt, a.image_url,
         (a.content_full IS NOT NULL) AS has_full_text,
         COALESCE(s.is_read, 0) AS is_read,
         COALESCE(s.is_starred, 0) AS is_starred,
         COALESCE(s.is_later, 0) AS is_later
  FROM articles a
  JOIN feeds f ON f.id = a.feed_id
  LEFT JOIN article_states s ON s.article_id = a.id`;

const DETAIL_SELECT = `
  SELECT a.id, a.feed_id, f.title AS feed_title, f.icon_url AS feed_icon_url,
         a.title, a.url, a.author, a.published_at, a.excerpt, a.image_url,
         a.content, a.content_full, a.ai_summary, a.ai_translation, a.extracted_at,
         (a.content_full IS NOT NULL) AS has_full_text,
         COALESCE(s.is_read, 0) AS is_read,
         COALESCE(s.is_starred, 0) AS is_starred,
         COALESCE(s.is_later, 0) AS is_later
  FROM articles a
  JOIN feeds f ON f.id = a.feed_id
  LEFT JOIN article_states s ON s.article_id = a.id`;

const VALID_VIEWS = new Set(["all", "unread", "starred", "later"]);

function parseCursor(cursor: string | undefined): { publishedAt: string; id: number } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf("|");
  if (sep <= 0) return null;
  const id = Number(cursor.slice(sep + 1));
  const publishedAt = cursor.slice(0, sep);
  if (!Number.isFinite(id) || Number.isNaN(new Date(publishedAt).getTime())) return null;
  return { publishedAt, id };
}

articles.get("/articles", async (c) => {
  const view = c.req.query("view") ?? "all";
  if (!VALID_VIEWS.has(view)) return fail(c, 400, "invalid_view", "view 参数非法");
  const limitRaw = Number(c.req.query("limit") ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 30;

  const where: string[] = [];
  const binds: (string | number)[] = [];

  if (view === "unread") where.push("COALESCE(s.is_read, 0) = 0");
  if (view === "starred") where.push("COALESCE(s.is_starred, 0) = 1");
  if (view === "later") where.push("COALESCE(s.is_later, 0) = 1");

  const unreadParam = c.req.query("unread");
  if (unreadParam === "1" || unreadParam === "true") where.push("COALESCE(s.is_read, 0) = 0");

  const feedId = c.req.query("feed_id");
  if (feedId !== undefined && feedId !== "") {
    binds.push(Number(feedId));
    where.push("a.feed_id = ?");
  }
  const categoryId = c.req.query("category_id");
  if (categoryId !== undefined && categoryId !== "") {
    binds.push(Number(categoryId));
    where.push("f.category_id = ?");
  }

  const cursor = parseCursor(c.req.query("cursor"));
  if (c.req.query("cursor") && !cursor) return fail(c, 400, "invalid_cursor", "游标格式非法");
  if (cursor) {
    where.push("(a.published_at < ? OR (a.published_at = ? AND a.id < ?))");
    binds.push(cursor.publishedAt, cursor.publishedAt, cursor.id);
  }

  const sql = `${BASE_SELECT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.published_at DESC, a.id DESC
    LIMIT ?`;
  const rows = await c.env.DB.prepare(sql).bind(...binds, limit + 1).all<ArticleRow>();
  const hasMore = rows.results.length > limit;
  const pageRows = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = pageRows[pageRows.length - 1];
  const page: ArticlesPage = {
    items: pageRows.map(toArticleListItem),
    nextCursor: hasMore && last ? `${last.published_at}|${last.id}` : null,
  };
  return ok(c, page);
});

articles.get("/articles/mirror", async (c) => {
  const limitRaw = Number(c.req.query("limit") ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 200;
  const cursorId = c.req.query("cursor_id");
  let maxId: number;
  if (cursorId !== undefined && cursorId !== "") {
    maxId = Number(cursorId);
    if (!Number.isFinite(maxId)) return fail(c, 400, "invalid_cursor", "游标非法");
  } else {
    const max = await c.env.DB.prepare("SELECT COALESCE(MAX(id), 0) m FROM articles").first<{ m: number }>();
    maxId = max?.m ?? 0;
  }
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.feed_id, f.title AS feed_title, a.title, a.url, a.published_at, a.excerpt, a.content
     FROM articles a JOIN feeds f ON f.id = a.feed_id
     WHERE a.id <= ? ORDER BY a.id DESC LIMIT ?`
  )
    .bind(maxId, limit)
    .all<{ id: number; feed_id: number; feed_title: string; title: string; url: string | null; published_at: string; excerpt: string | null; content: string | null }>();
  const last = rows.results[rows.results.length - 1];
  return ok(c, {
    items: rows.results.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      feedTitle: r.feed_title,
      title: r.title,
      url: r.url,
      publishedAt: r.published_at,
      excerpt: r.excerpt,
      content: r.content,
    })),
    // 游标为「已返回的最小 id - 1」:WHERE 用 <= 保证不重不漏(见任务报告 Step 3 调整说明)
    nextCursorId: rows.results.length === limit && last ? last.id - 1 : null,
  });
});

articles.get("/articles/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(`${DETAIL_SELECT} WHERE a.id = ?`)
    .bind(id)
    .first<ArticleRow>();
  if (!row) return fail(c, 404, "not_found", "文章不存在");
  return ok(c, toArticleDetail(row));
});

articles.patch("/articles/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const exists = await c.env.DB.prepare("SELECT id FROM articles WHERE id = ?").bind(id).first<{ id: number }>();
  if (!exists) return fail(c, 404, "not_found", "文章不存在");
  const body = await c.req
    .json<{ is_read?: unknown; is_starred?: unknown; is_later?: unknown }>()
    .catch(() => ({}) as { is_read?: unknown; is_starred?: unknown; is_later?: unknown });

  const current = await c.env.DB.prepare("SELECT * FROM article_states WHERE article_id = ?")
    .bind(id)
    .first<{ is_read: number; is_starred: number; is_later: number; read_at: string | null; starred_at: string | null; later_at: string | null }>();
  const now = new Date().toISOString();
  const next = {
    is_read: typeof body.is_read === "boolean" ? (body.is_read ? 1 : 0) : (current?.is_read ?? 0),
    is_starred: typeof body.is_starred === "boolean" ? (body.is_starred ? 1 : 0) : (current?.is_starred ?? 0),
    is_later: typeof body.is_later === "boolean" ? (body.is_later ? 1 : 0) : (current?.is_later ?? 0),
  };
  const readAt = next.is_read ? (current?.read_at ?? now) : null;
  const starredAt = next.is_starred ? (current?.starred_at ?? now) : null;
  const laterAt = next.is_later ? (current?.later_at ?? now) : null;

  await c.env.DB.prepare(
    `INSERT INTO article_states (article_id, is_read, is_starred, is_later, read_at, starred_at, later_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       is_read = excluded.is_read, is_starred = excluded.is_starred, is_later = excluded.is_later,
       read_at = excluded.read_at, starred_at = excluded.starred_at, later_at = excluded.later_at,
       updated_at = excluded.updated_at`
  )
    .bind(id, next.is_read, next.is_starred, next.is_later, readAt, starredAt, laterAt, now)
    .run();

  return ok(c, { isRead: next.is_read === 1, isStarred: next.is_starred === 1, isLater: next.is_later === 1 });
});

articles.post("/articles/mark-all-read", async (c) => {
  const body = await c.req
    .json<{ scope?: { type?: unknown; id?: unknown }; olderThanDays?: unknown }>()
    .catch(() => ({}) as { scope?: { type?: unknown; id?: unknown }; olderThanDays?: unknown });
  const scope = body.scope;
  if (!scope || typeof scope.type !== "string" || !["all", "feed", "category"].includes(scope.type)) {
    return fail(c, 400, "invalid_scope", "scope 非法");
  }
  // 可选时间档:仅置读发布时间早于 now - N 天的未读文章;缺省不限(行为与既往逐字节一致)
  let ageClause = "";
  let cutoff: string | null = null;
  if (body.olderThanDays !== undefined) {
    const d = body.olderThanDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 36500) {
      return fail(c, 400, "invalid_days", "天数非法");
    }
    cutoff = new Date(Date.now() - d * 86400000).toISOString();
    ageClause = " AND a.published_at < ?";
  }
  const now = new Date().toISOString();
  let sql: string;
  let binds: (string | number)[] = [now, now];
  if (scope.type === "all") {
    sql = `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
           SELECT a.id, 1, ?, ? FROM articles a WHERE COALESCE((SELECT is_read FROM article_states WHERE article_id = a.id), 0) = 0${ageClause}
           ON CONFLICT(article_id) DO UPDATE SET is_read = 1, read_at = excluded.read_at, updated_at = excluded.updated_at`;
    if (cutoff !== null) binds.push(cutoff);
  } else {
    if (typeof scope.id !== "number") return fail(c, 400, "invalid_scope", "缺少 id");
    const join = scope.type === "feed" ? "a.feed_id = ?" : "f.category_id = ?";
    sql = `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
           SELECT a.id, 1, ?, ? FROM articles a JOIN feeds f ON f.id = a.feed_id
           WHERE ${join} AND COALESCE((SELECT is_read FROM article_states WHERE article_id = a.id), 0) = 0${ageClause}
           ON CONFLICT(article_id) DO UPDATE SET is_read = 1, read_at = excluded.read_at, updated_at = excluded.updated_at`;
    binds = [now, now, scope.id];
    if (cutoff !== null) binds.push(cutoff);
  }
  const res = await c.env.DB.prepare(sql).bind(...binds).run();
  return ok(c, { updated: res.meta.changes ?? 0 });
});

articles.post("/articles/:id/fulltext", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ content_full?: unknown }>().catch(() => ({}) as { content_full?: unknown });
  if (typeof body.content_full !== "string" || !body.content_full.trim()) {
    return fail(c, 400, "invalid_content", "content_full 不能为空");
  }
  if (body.content_full.length > 512 * 1024) {
    return fail(c, 413, "too_large", "全文内容超过 512KB 限制");
  }
  const res = await c.env.DB.prepare("UPDATE articles SET content_full = ?, extracted_at = ? WHERE id = ?")
    .bind(body.content_full, new Date().toISOString(), id)
    .run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "文章不存在");
  return ok(c, { ok: true });
});

articles.post("/articles/:id/ai-summary", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ summary?: unknown }>().catch(() => ({}) as { summary?: unknown });
  const s = body.summary;
  let serialized: string | null = null;
  if (s !== null && s !== undefined) {
    if (
      typeof s !== "object" ||
      typeof (s as { oneLiner?: unknown }).oneLiner !== "string" ||
      !Array.isArray((s as { points?: unknown }).points) ||
      (s as { points: unknown[] }).points.some((p) => typeof p !== "string")
    ) {
      return fail(c, 400, "invalid_summary", "summary 形状非法");
    }
    serialized = JSON.stringify({
      oneLiner: (s as { oneLiner: string }).oneLiner.slice(0, 500),
      points: (s as { points: string[] }).points.slice(0, 8).map((p) => p.slice(0, 500)),
    });
    // 经裁剪后不可达(上限 1×500 + 8×500 字符),保留为防御
    if (serialized.length > 32 * 1024) return fail(c, 413, "too_large", "摘要内容过大");
  }
  const res = await c.env.DB.prepare("UPDATE articles SET ai_summary = ? WHERE id = ?").bind(serialized, id).run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "文章不存在");
  return ok(c, { ok: true });
});

export default articles;
