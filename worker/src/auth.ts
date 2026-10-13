import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { fail } from "./respond";

export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = c.env.AUTH_TOKEN;
  if (!token) return next();
  const header = c.req.header("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !timingSafeEqualStr(provided, token)) {
    return fail(c, 401, "unauthorized", "访问令牌无效,请重新登录");
  }
  return next();
};
