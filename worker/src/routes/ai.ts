import { Hono } from "hono";
import type { Env } from "../env";
import { fail } from "../respond";
import { assertSafeUrl } from "../lib/ssrf";

const ai = new Hono<{ Bindings: Env }>();

interface ChatBody {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
}

ai.post("/ai/chat", async (c) => {
  const body = await c.req.json<ChatBody>().catch(() => ({}) as ChatBody);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!baseUrl) return fail(c, 400, "invalid_base_url", "缺少 baseUrl");
  if (!model) return fail(c, 400, "invalid_model", "缺少 model");
  if (messages.length === 0) return fail(c, 400, "invalid_messages", "messages 不能为空");
  const payload = JSON.stringify({ model, messages, stream: body.stream !== false });
  if (payload.length > 512 * 1024) return fail(c, 413, "too_large", "请求体过大");

  let upstream: string;
  try {
    upstream = assertSafeUrl(baseUrl).toString().replace(/\/+$/, "") + "/chat/completions";
  } catch (e) {
    return fail(c, 400, "invalid_base_url", e instanceof Error ? e.message : "baseUrl 无效");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof body.apiKey === "string" && body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;

  let res: Response;
  try {
    // redirect: "manual" —— 不跟随重定向,防止 302 到内网绕过 SSRF 校验
    res = await fetch(upstream, { method: "POST", headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  } catch {
    return fail(c, 502, "ai_upstream_error", "无法连接 AI 服务商");
  }
  if (res.status >= 300 && res.status < 400) {
    return fail(c, 502, "ai_upstream_error", "服务商响应重定向,已按安全策略拒绝");
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    return fail(c, 502, "ai_upstream_error", `服务商返回错误(HTTP ${res.status})${snippet ? `: ${snippet}` : ""}`);
  }
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "text/event-stream", "Cache-Control": "no-store" },
  });
});

export default ai;
