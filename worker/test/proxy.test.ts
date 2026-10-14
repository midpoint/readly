import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";
import { decodeWithCharset } from "../src/routes/proxy";

beforeAll(() => fetchMock.activate());
afterAll(() => fetchMock.deactivate());

beforeEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe("decodeWithCharset", () => {
  it("声明 utf-8 直接解码", () => {
    const bytes = new TextEncoder().encode("你好");
    expect(decodeWithCharset(bytes, "text/html; charset=utf-8")).toBe("你好");
  });
  it("未知编码名回落 UTF-8 不抛错", () => {
    const bytes = new TextEncoder().encode("ok");
    expect(decodeWithCharset(bytes, "text/html; charset=x-mystery")).toBe("ok");
  });
});

describe("GET /api/proxy/html", () => {
  it("正常回传 HTML 与 finalUrl", async () => {
    fetchMock.get("https://page.example.com").intercept({ path: "/article" }).reply(200, "<html><body><p>正文</p></body></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("https://page.example.com/article"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; finalUrl: string; truncated: boolean };
    expect(body.html).toContain("<p>正文</p>");
    expect(body.finalUrl).toBe("https://page.example.com/article");
    expect(body.truncated).toBe(false);
  });
  it("非网页类型 400", async () => {
    fetchMock.get("https://cdn.example.com").intercept({ path: "/a.pdf" }).reply(200, "%PDF-", { headers: { "Content-Type": "application/pdf" } });
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("https://cdn.example.com/a.pdf"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_type");
  });
  it("私网地址被 SSRF 闸门拒绝为 400", async () => {
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("http://127.0.0.1/x"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("内网");
  });
  it("上游 404 → 502", async () => {
    fetchMock.get("https://gone.example.com").intercept({ path: "/x" }).reply(404, "nope");
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("https://gone.example.com/x"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_error");
  });
  it("缺少 url 参数 400", async () => {
    const res = await apiFetch("/api/proxy/html");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_url");
  });
});
