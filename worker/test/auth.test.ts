import { SELF } from "cloudflare:test";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware, timingSafeEqualStr } from "../src/auth";

describe("timingSafeEqualStr", () => {
  it("相等返回 true", () => {
    expect(timingSafeEqualStr("abc123", "abc123")).toBe(true);
  });
  it("不等/长度不同返回 false", () => {
    expect(timingSafeEqualStr("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualStr("abc", "abc123")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });
});

describe("auth middleware", () => {
  it("无令牌返回 401", async () => {
    const res = await SELF.fetch("http://example.com/api/health");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });
  it("错误令牌返回 401", async () => {
    const res = await SELF.fetch("http://example.com/api/health", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });
  it("正确令牌返回 200", async () => {
    const res = await SELF.fetch("http://example.com/api/health", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("authMiddleware AUTH_TOKEN 未配置", () => {
  it("AUTH_TOKEN 未配置时放行", async () => {
    let called = false;
    const c = { env: {}, req: { header: () => undefined } } as unknown as Context;
    await authMiddleware(c as never, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe("GET /api/auth/check", () => {
  it("无令牌返回 401", async () => {
    const res = await SELF.fetch("http://example.com/api/auth/check");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });
  it("正确令牌返回 200 且 body 为 {ok:true}", async () => {
    const res = await SELF.fetch("http://example.com/api/auth/check", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
