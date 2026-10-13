import { Hono } from "hono";
import type { Stats } from "@readly/shared";
import type { Env } from "../env";
import { ok } from "../respond";

const stats = new Hono<{ Bindings: Env }>();

stats.get("/stats", async (c) => {
  const db = c.env.DB;
  const [unread, starred, later, perFeed, perCategory] = await Promise.all([
    db.prepare("SELECT COUNT(*) c FROM articles a LEFT JOIN article_states s ON s.article_id = a.id WHERE COALESCE(s.is_read, 0) = 0").first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) c FROM article_states WHERE is_starred = 1").first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) c FROM article_states WHERE is_later = 1").first<{ c: number }>(),
    db.prepare(
      "SELECT a.feed_id, COUNT(*) c FROM articles a LEFT JOIN article_states s ON s.article_id = a.id WHERE COALESCE(s.is_read, 0) = 0 GROUP BY a.feed_id"
    ).all<{ feed_id: number; c: number }>(),
    db.prepare(
      `SELECT f.category_id, COUNT(*) c FROM articles a JOIN feeds f ON f.id = a.feed_id
       LEFT JOIN article_states s ON s.article_id = a.id
       WHERE COALESCE(s.is_read, 0) = 0 AND f.category_id IS NOT NULL GROUP BY f.category_id`
    ).all<{ category_id: number; c: number }>(),
  ]);

  const result: Stats = {
    unreadTotal: unread?.c ?? 0,
    starredTotal: starred?.c ?? 0,
    laterTotal: later?.c ?? 0,
    perFeed: Object.fromEntries(perFeed.results.map((r) => [r.feed_id, r.c])),
    perCategory: Object.fromEntries(perCategory.results.map((r) => [r.category_id, r.c])),
  };
  return ok(c, result);
});

export default stats;
