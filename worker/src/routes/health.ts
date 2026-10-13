import { Hono } from "hono";
import type { Env } from "../env";
import { ok } from "../respond";

const health = new Hono<{ Bindings: Env }>();

health.get("/health", (c) => ok(c, { ok: true, time: new Date().toISOString() }));

export default health;
