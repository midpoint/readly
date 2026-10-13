import { Hono } from "hono";
import type { Category } from "@readly/shared";
import type { Env } from "../env";
import { fail, ok } from "../respond";

const categories = new Hono<{ Bindings: Env }>();

interface Row {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

function toCategory(row: Row): Category {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at };
}

categories.get("/categories", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM categories ORDER BY sort_order, id").all<Row>();
  return ok(c, rows.results.map(toCategory));
});

categories.post("/categories", async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail(c, 400, "invalid_name", "分类名称不能为空");
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) m FROM categories").first<{ m: number }>();
  const res = await c.env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES (?, ?)").bind(name, (max?.m ?? 0) + 1).run();
  const row = await c.env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(res.meta.last_row_id).first<Row>();
  return ok(c, toCategory(row!), 201);
});

categories.patch("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail(c, 400, "invalid_name", "分类名称不能为空");
  const res = await c.env.DB.prepare("UPDATE categories SET name = ? WHERE id = ?").bind(name, id).run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "分类不存在");
  const row = await c.env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<Row>();
  return ok(c, toCategory(row!));
});

categories.delete("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "分类不存在");
  return ok(c, { ok: true });
});

categories.post("/categories/reorder", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== "number")) {
    return fail(c, 400, "invalid_ids", "ids 必须为数字数组");
  }
  await c.env.DB.batch(
    (body.ids as number[]).map((id, index) => c.env.DB.prepare("UPDATE categories SET sort_order = ? WHERE id = ?").bind(index, id))
  );
  return ok(c, { ok: true });
});

export default categories;
