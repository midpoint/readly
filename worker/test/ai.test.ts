import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";

beforeAll(() => fetchMock.activate());
afterAll(() => fetchMock.deactivate());
beforeEach(() => fetchMock.assertNoPendingInterceptors());

const BODY = {
  baseUrl: "https://api.ai.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
};

describe("POST /api/ai/chat", () => {
  it("透传上游 SSE,并转发 Authorization 与 model", async () => {
    fetchMock
      .get("https://api.ai.example.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    const res = await apiFetch("/api/ai/chat", { method: "POST", body: BODY });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toContain("你好");
  });

  it("私网 baseUrl 被 SSRF 拒绝 400", async () => {
    const res = await apiFetch("/api/ai/chat", { method: "POST", body: { ...BODY, baseUrl: "http://127.0.0.1/v1" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("内网");
  });

  it("上游 401 → 502 且 message 含状态码", async () => {
    fetchMock.get("https://api.ai.example.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(401, '{"error":{"message":"bad key"}}');
    const res = await apiFetch("/api/ai/chat", { method: "POST", body: BODY });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ai_upstream_error");
    expect(body.error.message).toContain("401");
  });

  it("缺 model / messages 为空 → 400", async () => {
    expect((await apiFetch("/api/ai/chat", { method: "POST", body: { ...BODY, model: "" } })).status).toBe(400);
    expect((await apiFetch("/api/ai/chat", { method: "POST", body: { ...BODY, messages: [] } })).status).toBe(400);
  });

  it("上游重定向一律拒绝(防 302 绕过 SSRF)", async () => {
    fetchMock
      .get("https://api.ai.example.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(302, "", { headers: { Location: "http://127.0.0.1/steal" } });
    const res = await apiFetch("/api/ai/chat", { method: "POST", body: BODY });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("重定向");
  });
});
