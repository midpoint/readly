import { Hono } from "hono";
import type { Env } from "../env";
import { fail, ok } from "../respond";
import { putSetting } from "../lib/settings";

const settings = new Hono<{ Bindings: Env }>();

settings.get("/settings", async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Record<string, unknown> = {};
  for (const row of rows.results) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = null;
    }
  }
  return ok(c, out);
});

settings.put("/settings", async (c) => {
  const body = await c.req.json<{ kv?: unknown }>().catch(() => ({}) as { kv?: unknown });
  if (!body.kv || typeof body.kv !== "object" || Array.isArray(body.kv)) {
    return fail(c, 400, "invalid_kv", "kv 必须为对象");
  }
  const entries = Object.entries(body.kv as Record<string, unknown>);
  for (const [key, value] of entries) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return fail(c, 400, "invalid_value", `键 ${key} 的值无法序列化`);
    }
    if (serialized === undefined) return fail(c, 400, "invalid_value", `键 ${key} 的值无法序列化`);
    if (serialized.length > 512 * 1024) return fail(c, 413, "too_large", `键 ${key} 的值超过 512KB`);
  }
  for (const [key, value] of entries) {
    await putSetting(c.env.DB, key, value);
  }
  return ok(c, { ok: true });
});

export default settings;
