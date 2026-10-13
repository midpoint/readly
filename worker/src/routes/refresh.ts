import { Hono } from "hono";
import type { Env } from "../env";
import { ok } from "../respond";
import { refreshDueFeeds } from "../lib/refresh";

const refresh = new Hono<{ Bindings: Env }>();

refresh.post("/refresh", async (c) => {
  const batchRaw = Number(c.req.query("batch") ?? NaN);
  const limit = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(Math.trunc(batchRaw), 10) : undefined;
  const result = await refreshDueFeeds(c.env.DB, { limit });
  return ok(c, result);
});

export default refresh;
