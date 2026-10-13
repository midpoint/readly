import { Hono } from "hono";
import type { Env } from "../env";
import { ok } from "../respond";

const auth = new Hono<{ Bindings: Env }>();

auth.get("/auth/check", (c) => ok(c, { ok: true }));

export default auth;
