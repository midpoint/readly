# Readly AI 摘要(计划 06 / M6a)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 AI 摘要:自选 OpenAI 兼容服务商(预设 + 自定义),流式生成「一句话总结 + 3-5 条要点」,结果缓存进 `articles.ai_summary`、可重新生成;失败/非 JSON 输出降级为纯文本展示;`/settings` 设置页首次落地(AI 服务商管理 + 密钥本地/云端存储选择)。

**Architecture:** 两条调用路径——**浏览器直连**(默认)与 **Worker 代理**(`POST /api/ai/chat`,SSE 透传,解决 CORS 被拦的供应商,复用 SSRF 闸门);客户端 `modules/sse.ts` 解析 SSE 增量,`modules/ai.ts` 组装摘要提示词并解析严格 JSON;服务商配置与 `activeId`、`syncKeys` 一起构成 `ai` store 的持久化切片(本地键 `readly_ai`,D1 键 `ai_providers`;密钥默认**只存本地**,开启云同步才随 D1 保存);摘要缓存写入新增的 `POST /api/articles/:id/ai-summary`。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- **密钥安全**:`apiKey` 默认只存 localStorage(`readly_ai`);D1 副本在 `syncKeys=false` 时**必须剥离 apiKey**(测试断言);设置页开启云同步时显示明确警示(密钥将写入你的 D1);Worker 代理**从不持久化密钥**(仅请求内透传)。
- Worker 代理安全:`baseUrl` 过 `assertSafeUrl`(SSRF);仅转发 `{model, messages, stream}` 与 `Authorization: Bearer <apiKey>`;上游非 2xx → `502 ai_upstream_error`,message 含上游状态与 ≤300 字片段;请求体 ≤512KB;`AbortSignal.timeout(120_000)`;流式以 `Response(upstream.body)` 原样透传。
- 冻结类型:`AiProvider { id; name; baseUrl; model; apiKey?; useProxy }`、`AiSummary { oneLiner; points }`、`SETTING_KEYS.aiProviders`(`"ai_providers"`)——原样使用(本计划不改 shared;`ai_translation` 留计划 07)。
- 摘要口径:提示词要求**严格 JSON** `{"one_liner","points"(3-5 条)}`,语言=文章语言(本地 CJK 占比粗判 → 「中文/英文」);正文纯文本截 **6000** 字(复用 `htmlToText` 再截);解析失败 → `{summary:null, raw:<原文>}`,UI 以纯文本降级展示;结果写缓存,可重新生成(覆盖)。
- 预设(可改):OpenAI `https://api.openai.com/v1`/`gpt-4o-mini`;DeepSeek `https://api.deepseek.com/v1`/`deepseek-chat`;Kimi `https://api.moonshot.cn/v1`/`moonshot-v1-8k`;智谱 `https://open.bigmodel.cn/api/paas/v4`/`glm-4-flash`;硅基流动 `https://api.siliconflow.cn/v1`/`deepseek-ai/DeepSeek-V3`。
- selector 契约:`[data-provider-row]`、`[data-provider-active]`、`[data-provider-edit]`、`[data-provider-delete]`、`[data-new-provider]`、`[data-provider-preset]`、`[data-provider-baseurl]`、`[data-provider-model]`、`[data-provider-key]`、`[data-provider-proxy]`、`[data-provider-save]`、`[data-sync-keys]`、`[data-ai-button]`、`[data-ai-card]`、`[data-ai-stream]`、`[data-ai-regenerate]`、`[data-ai-error]`。
- 视觉验收必须实测(headless Chrome,独立端口 4799,勿动用户 5173/8787),浅色+深色;新增 UI 深色配对;文案中文;TypeScript strict;禁止 any;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付;worker 测试前先 `pnpm build`。

---

### Task 1: worker AI 代理与摘要缓存路由

**Files:**
- Create: `worker/src/routes/ai.ts`(`POST /api/ai/chat` SSE 透传)
- Modify: `worker/src/routes/articles.ts`(新增 `POST /articles/:id/ai-summary`)
- Modify: `worker/src/index.ts`(挂载 ai 路由)
- Create: `worker/test/ai.test.ts`
- Modify: `worker/test/articles.test.ts`(追加 1 用例)

**Interfaces:**
- Consumes: `assertSafeUrl`(SSRF)、`fail/ok`、`AiSummary`(shared)
- Produces(冻结):
  - `POST /api/ai/chat` body `{ baseUrl: string; apiKey?: string; model: string; messages: {role,content}[]; stream?: boolean }` → 2xx 原样透传上游(含 `text/event-stream`);错误:`400 invalid_*`、`502 ai_upstream_error`
  - `POST /api/articles/:id/ai-summary` body `{ summary: AiSummary | null }` → `{ok:true}`(≤32KB;null 清除)

- [ ] **Step 1: 失败测试**

`worker/test/ai.test.ts`:

```ts
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
```

`worker/test/articles.test.ts` 追加:

```ts
  it("ai-summary 写入与清除", async () => {
    const { ids } = await seed();
    const put = await apiFetch(`/api/articles/${ids[0]}/ai-summary`, {
      method: "POST",
      body: { summary: { oneLiner: "一句话", points: ["a", "b"] } },
    });
    expect(put.status).toBe(200);
    const detail = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { aiSummary: { oneLiner: string } | null };
    expect(detail.aiSummary?.oneLiner).toBe("一句话");
    await apiFetch(`/api/articles/${ids[0]}/ai-summary`, { method: "POST", body: { summary: null } });
    const cleared = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { aiSummary: null };
    expect(cleared.aiSummary).toBeNull();
  });
```

Run: `pnpm --filter @readly/worker test test/ai.test.ts test/articles.test.ts`
Expected: FAIL。

- [ ] **Step 2: 实现**

`worker/src/routes/ai.ts`:

```ts
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
```

`worker/src/routes/articles.ts` 在 fulltext 路由后追加:

```ts
articles.post("/articles/:id/ai-summary", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ summary?: unknown }>().catch(() => ({}) as { summary?: unknown });
  const s = body.summary;
  let serialized: string | null = null;
  if (s !== null && s !== undefined) {
    if (
      typeof s !== "object" ||
      typeof (s as { oneLiner?: unknown }).oneLiner !== "string" ||
      !Array.isArray((s as { points?: unknown }).points) ||
      (s as { points: unknown[] }).points.some((p) => typeof p !== "string")
    ) {
      return fail(c, 400, "invalid_summary", "summary 形状非法");
    }
    serialized = JSON.stringify({
      oneLiner: (s as { oneLiner: string }).oneLiner.slice(0, 500),
      points: (s as { points: string[] }).points.slice(0, 8).map((p) => p.slice(0, 500)),
    });
    if (serialized.length > 32 * 1024) return fail(c, 413, "too_large", "摘要内容过大");
  }
  const res = await c.env.DB.prepare("UPDATE articles SET ai_summary = ? WHERE id = ?").bind(serialized, id).run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "文章不存在");
  return ok(c, { ok: true });
});
```

`worker/src/index.ts`:import `ai` 并 `app.route("/api", ai);`。

Run: `pnpm --filter @readly/worker test`
Expected: 全绿(122 → ~128)。

- [ ] **Step 3: 提交**

```bash
git add worker
git commit -m "feat(worker): /api/ai/chat SSE 透传代理与 ai-summary 缓存路由

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: web AI 基础模块(SSE 解析 / 提示词 / 流式客户端)

**Files:**
- Create: `web/src/modules/sse.ts`
- Create: `web/src/modules/ai.ts`
- Create: `web/src/modules/__tests__/sse.test.ts`
- Create: `web/src/modules/__tests__/ai.test.ts`

**Interfaces:**
- Consumes: `AiProvider/AiSummary`(shared)、`htmlToText`(`@/modules/keywords`)、`getToken`(`@/api/client`)
- Produces(冻结):
  - `parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string>`(逐 `data:` 载荷;跳过 `[DONE]`;跨 chunk 拆行安全)
  - `normalizeBaseUrl(url: string): string`
  - `PROVIDER_PRESETS: { name: string; baseUrl: string; model: string }[]`(5 个)
  - `detectTextLang(text: string): "zh" | "en" | null`
  - `buildSummaryMessages(input: { title: string; text: string; lang: "zh" | "en" | null }): { role; content }[]`
  - `parseSummary(out: string): { summary: AiSummary | null; raw: string }`
  - `chatStream(opts: { provider: AiProvider; messages: { role; content }[]; signal?: AbortSignal }): AsyncGenerator<string>`
  - `aiTextOf(html: string | null | undefined): string`(=`htmlToText(...).slice(0, 6000)`)

- [ ] **Step 1: 失败测试**

`web/src/modules/__tests__/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSseStream } from "@/modules/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of parseSseStream(s)) out.push(d);
  return out;
}

describe("parseSseStream", () => {
  it("解析 data 行、跳过 [DONE]、忽略非 data 行", async () => {
    const got = await collect(streamOf(["data: {\"a\":1}\n\n", "event: ping\n", "data: [DONE]\n\n"]));
    expect(got).toEqual(['{"a":1}']);
  });
  it("跨 chunk 拆行安全", async () => {
    const got = await collect(streamOf(["data: {\"a\"", ":1}\n\ndata: x\n\n"]));
    expect(got).toEqual(['{"a":1}', "x"]);
  });
  it("\\r\\n 行尾兼容", async () => {
    const got = await collect(streamOf(["data: a\r\ndata: b\r\n"]));
    expect(got).toEqual(["a", "b"]);
  });
});
```

`web/src/modules/__tests__/ai.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSummaryMessages, detectTextLang, normalizeBaseUrl, parseSummary, PROVIDER_PRESETS } from "@/modules/ai";

describe("normalizeBaseUrl", () => {
  it("去尾斜杠与空白", () => {
    expect(normalizeBaseUrl(" https://api.x.com/v1/ ")).toBe("https://api.x.com/v1");
  });
});

describe("PROVIDER_PRESETS", () => {
  it("5 个预设且字段齐全", () => {
    expect(PROVIDER_PRESETS).toHaveLength(5);
    expect(PROVIDER_PRESETS.every((p) => p.name && p.baseUrl.startsWith("https://") && p.model)).toBe(true);
  });
});

describe("detectTextLang", () => {
  it("CJK 占比判定", () => {
    expect(detectTextLang("人工智能新闻")).toBe("zh");
    expect(detectTextLang("AI news update")).toBe("en");
    expect(detectTextLang("12345")).toBeNull();
  });
});

describe("buildSummaryMessages", () => {
  it("系统提示要求严格 JSON 且含语言,用户消息含标题与 6000 字正文", () => {
    const msgs = buildSummaryMessages({ title: "T", text: "文".repeat(7000), lang: "zh" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toContain("JSON");
    expect(msgs[0]!.content).toContain("中文");
    expect(msgs[1]!.content).toContain("T");
    expect(msgs[1]!.content).toContain("文".repeat(100));
    expect(msgs[1]!.content.length).toBeLessThan(6200);
  });
});

describe("parseSummary", () => {
  it("严格 JSON 解析成功并裁剪", () => {
    const r = parseSummary('前缀{"one_liner":"总结","points":["p1","p2","p3"]}后缀');
    expect(r.summary?.oneLiner).toBe("总结");
    expect(r.summary?.points).toEqual(["p1", "p2", "p3"]);
  });
  it("非法/不完整 JSON 降级 raw", () => {
    expect(parseSummary("这是一段普通文字").summary).toBeNull();
    expect(parseSummary("这是一段普通文字").raw).toBe("这是一段普通文字");
    expect(parseSummary('{"one_liner":1}').summary).toBeNull();
  });
});
```

Run: 两文件 Expected: FAIL。

- [ ] **Step 2: 实现**

`web/src/modules/sse.ts`:

```ts
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") yield data;
      }
    }
  }
}
```

`web/src/modules/ai.ts`(要点;完整按此):

```ts
import type { AiProvider, AiSummary } from "@readly/shared";
import { getToken } from "@/api/client";
import { htmlToText } from "./keywords";
import { parseSseStream } from "./sse";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export const PROVIDER_PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
];

export function detectTextLang(text: string): "zh" | "en" | null {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return null;
  return cjk > 0 && cjk >= latin / 2 ? "zh" : "en";
}

export function aiTextOf(html: string | null | undefined): string {
  return htmlToText(html).slice(0, 6000);
}

export function buildSummaryMessages(input: { title: string; text: string; lang: "zh" | "en" | null }): ChatMessage[] {
  const langName = input.lang === "en" ? "英文" : "中文";
  return [
    {
      role: "system",
      content: `你是专业的新闻编辑。请用${langName}输出严格 JSON,格式为 {"one_liner":"一句话总结","points":["要点1","要点2","要点3"]},points 为 3-5 条。只输出 JSON,不要任何其他文字、不要 Markdown 代码块。`,
    },
    { role: "user", content: `标题:${input.title}\n\n正文:\n${input.text}` },
  ];
}

export function parseSummary(out: string): { summary: AiSummary | null; raw: string } {
  const raw = out.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { one_liner?: unknown; points?: unknown };
      if (typeof obj.one_liner === "string" && Array.isArray(obj.points) && obj.points.every((p) => typeof p === "string")) {
        return {
          summary: {
            oneLiner: obj.one_liner.slice(0, 500),
            points: (obj.points as string[]).slice(0, 8).map((p) => p.slice(0, 500)),
          },
          raw,
        };
      }
    } catch {
      /* 降级 */
    }
  }
  return { summary: null, raw };
}

export async function* chatStream(opts: { provider: AiProvider; messages: ChatMessage[]; signal?: AbortSignal }): AsyncGenerator<string> {
  const { provider } = opts;
  const payload = JSON.stringify({
    baseUrl: normalizeBaseUrl(provider.baseUrl),
    apiKey: provider.apiKey ?? "",
    model: provider.model,
    messages: opts.messages,
    stream: true,
  });

  let res: Response;
  if (provider.useProxy) {
    const token = getToken();
    res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: payload,
      signal: opts.signal,
    });
  } else {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: provider.model, messages: opts.messages, stream: true }),
      signal: opts.signal,
    });
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`服务商返回错误(HTTP ${res.status})${snippet ? `: ${snippet}` : ""}`);
  }
  const ctype = res.headers.get("Content-Type") ?? "";
  if (!res.body || !ctype.includes("event-stream")) {
    // 非流式回退:整段 JSON
    const text = await res.text();
    try {
      const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (content) yield content;
      return;
    } catch {
      throw new Error("无法解析 AI 响应");
    }
  }
  for await (const data of parseSseStream(res.body)) {
    try {
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      /* 忽略坏帧 */
    }
  }
}
```

Run: 全量 + typecheck。

- [ ] **Step 3: 提交**

```bash
git add web/src/modules
git commit -m "feat(web): AI 基础模块(SSE 解析/提示词/流式客户端/预设)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: ai store + /settings 设置页 + 入口

**Files:**
- Create: `web/src/stores/ai.ts`
- Create: `web/src/views/Settings.vue`
- Create: `web/src/components/ProviderEditor.vue`
- Modify: `web/src/router.ts`(`/settings`)
- Modify: `web/src/components/Sidebar.vue`(底部「设置」入口)
- Create: `web/src/stores/__tests__/ai.test.ts`
- Create: `web/src/views/__tests__/settings-mount.test.ts`

**Interfaces:**
- Produces(冻结):
  - `useAiStore`:`{ providers: Ref<AiProvider[]>; activeId: Ref<string | null>; syncKeys: Ref<boolean>; active: ComputedRef<AiProvider | null>; configured: ComputedRef<boolean>; addProvider(patch?: Partial<AiProvider>): string; updateProvider(id, patch): void; removeProvider(id): void; setActive(id | null): void; updateSyncKeys(v: boolean): void; init(): void; sanitizeAi(raw: unknown): { providers: AiProvider[]; activeId: string | null; syncKeys: boolean }(导出) }`
  - 本地键 `readly_ai`(含密钥);D1 键 `SETTING_KEYS.aiProviders`(syncKeys=false 时**剥离密钥**)

- [ ] **Step 1: 失败测试(store)**

`web/src/stores/__tests__/ai.test.ts`(沿用 vi.mock api 模式):

关键用例:
1. `sanitizeAi` 矩阵(非法形状丢弃、≤20、activeId 悬空置 null、syncKeys boolean);
2. `addProvider 预设填充 + 唯一 id;setActive/updateProvider/removeProvider`;
3. **密钥剥离**:`updateSyncKeys(false)` 后防抖 PUT 的 `kv.ai_providers.providers[*]` 无 `apiKey` 字段;`updateSyncKeys(true)` 后含;
4. LS 始终含密钥(`readly_ai` 内容断言);
5. 服务端采用:本地无 `readly_ai` 时 `init` 后采用服务端(无可采用则默认空)。

Run: Expected FAIL。

- [ ] **Step 2: 实现 ai store**

要点(与既有切片同风格):`interface AiState { providers: AiProvider[]; activeId: string | null; syncKeys: boolean }`;`sanitizeAi` 逐字段;`redact(state, syncKeys)` 生成 D1 副本;`init()`:LS 读 → 后台 GET 采用(仅当无 LS)→ 双 watch(状态序列化写 LS + 防抖 PUT);`addProvider` 默认填预设第一条并生成 `id = "ai_" + Date.now().toString(36) + random`。

- [ ] **Step 3: 失败测试(设置页挂载)**

`web/src/views/__tests__/settings-mount.test.ts`:
1. 空态 → 点 `[data-new-provider]` 打开 ProviderEditor → 选预设(`[data-provider-preset]`)→ 字段被填充 → 保存 → 列表出现 `[data-provider-row]`;
2. `[data-provider-active]` 点击 → store.activeId 变更;
3. `[data-provider-edit]` → 改 model → 保存 → 行内文本更新;
4. `[data-provider-delete]` → 行消失;
5. `[data-sync-keys]` 切换 → store.syncKeys 变更 + 警示文案出现/消失;
6. 无效 baseUrl(填 `ftp://x`)保存被挡(`[data-provider-error]`)。

Run: Expected FAIL。

- [ ] **Step 4: 实现 Settings.vue / ProviderEditor.vue / 路由 / 侧栏入口**

`Settings.vue` 结构:根容器(全页外壳,含 `bg-white dark:bg-neutral-950 dark:text-neutral-100`);返回阅读器按钮;标题「设置」;「AI 服务商」节:说明文案(用途:AI 摘要/翻译;密钥默认只存本机)、provider 列表(行:`[data-provider-row]` 名称 + baseUrl/model 摘要 + 激活单选 `[data-provider-active]` + useProxy 徽标 + 编辑/删除)、`[data-new-provider]`、密钥存储卡:`[data-sync-keys]` checkbox + 开时显示红字警示「密钥将写入你的 D1 数据库,请确认部署环境可信」。

`ProviderEditor.vue`:props `{ initial?: AiProvider }`,emits `{ close; save: [Omit<AiProvider,"id">] }`;字段:预设下拉(`[data-provider-preset]`,选择后填充 baseUrl/model/name)、name、baseUrl(`[data-provider-baseurl]`)、model(`[data-provider-model]`)、apiKey(`[data-provider-key]`,type=password)、useProxy(`[data-provider-proxy]`);校验:baseUrl 必须 `/^https?:\/\//`(否则 `[data-provider-error]`「baseUrl 需为 http(s) 地址」)、model 非空;`[data-provider-save]` 置灰逻辑。

`router.ts`:`{ path: "/settings", name: "settings", component: () => import("@/views/Settings.vue") }`。
`Sidebar.vue` 底部按钮区(快捷键之后)加「设置」→ `router.push("/settings")`。

- [ ] **Step 5: 全量验证并提交**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build`
Expected: 全绿。

```bash
git add web
git commit -m "feat(web): AI 服务商 store 与 /settings 设置页(密钥本地/云端选择)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 摘要接线(流式卡片/缓存/降级)+ 实测

**Files:**
- Modify: `web/src/stores/ai.ts`(摘要生成状态与动作)
- Modify: `web/src/components/ReaderPane.vue`(AI 按钮 + 摘要卡 + 引导)
- Modify: `web/src/stores/__tests__/ai.test.ts`(追加用例)
- Create: `web/src/components/__tests__/ai-summary.test.ts`
- Modify: `README.md`(功能 8 更新为已交付)
- Create(验后删): `web/scripts/verify-ai.mjs`

**Interfaces:**
- Produces(冻结):
  - ai store 追加:`summaryState: Ref<"idle"|"loading"|"done"|"error">`、`summaryStream: Ref<string>`、`summaryError: Ref<string|null>`、`generateSummary(input: { id: number; title: string; text: string; lang }): Promise<void>`、`cancelSummary(): void`
  - ReaderPane 选择器:`[data-ai-button]`、`[data-ai-card]`、`[data-ai-stream]`、`[data-ai-regenerate]`、`[data-ai-error]`

- [ ] **Step 1: 失败测试(store 摘要流程)**

用例:
1. **流式生成 + 缓存写回**:mock `@/modules/ai` 的 `chatStream` 为依次 yield `'{"one_liner":"总'`、`'"结","points":["a"]}'` 的异步生成器 → `generateSummary` 后 `summaryStream` 逐段累计、`summaryState==="done"`、调用 `POST /api/articles/:id/ai-summary` 且 body.summary.oneLiner==="总结";同时 `reader`?不耦合——缓存写回由调用方(ReaderPane)更新 `reader.article.aiSummary`,store 只负责请求与状态(并在成功后 `onDone(summary)` 回传;实现为 `generateSummary` 返回值 `AiSummary | null` 更简单——**采用返回值方案**,不做回调);
2. **非 JSON 降级**:chatStream yield 纯文本 → 状态 done、返回 `{summary:null}` 且 `summaryStream` 保有原文(UI 降级展示);
3. **取消**:生成中 `cancelSummary()` → fetch signal abort(mock 里断言 signal.aborted true)→ 状态 idle;
4. **未配置**:无 active provider → `generateSummary` 立即 reject `"请先在设置中配置 AI 服务商"`。

Run: Expected FAIL。

- [ ] **Step 2: 实现 store 动作与 ReaderPane UI**

store 追加(要点):`generateSummary` 前置检查 `active`;`AbortController`;循环 `for await (const delta of chatStream({provider, messages, signal}))` 累计到 `summaryStream`;完成后 `parseSummary`;`POST /api/articles/:id/ai-summary`(失败静默,返回 summary 仍给 UI);`cancelSummary` abort。

ReaderPane:
- 工具栏(`Aa 主题` 之前)加:

```vue
            <button data-ai-button :class="[btn, 'disabled:opacity-50']" :disabled="ai.summaryState === 'loading'" @click="onAiClick">
              {{ ai.summaryState === "loading" ? "生成中…" : reader.article.aiSummary ? "AI 摘要" : "AI 摘要" }}
            </button>
```

- 点击逻辑:

```ts
async function onAiClick(): Promise<void> {
  const a = reader.article;
  if (!a) return;
  if (a.aiSummary) {
    // 已有缓存:切换卡片显示
    showAiCard.value = !showAiCard.value;
    return;
  }
  if (!ai.configured) {
    showAiGuide.value = true;
    return;
  }
  showAiCard.value = true;
  const outcome = await ai.generateSummary({ id: a.id, title: a.title, text: aiTextOf(a.contentFull ?? a.content ?? a.excerpt), lang: detectTextLang(a.title) }).catch((e) => {
    aiError display…
    return null;
  });
  if (outcome?.summary) a.aiSummary = outcome.summary;
}
```

- 摘要卡(滚动容器内、来源条之后、`<article>` 之前):

```vue
          <div v-if="showAiCard && reader.article.aiSummary" data-ai-card class="mx-auto mt-3 w-full max-w-[var(--reader-width,720px)] rounded-xl border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
            <p class="font-medium">{{ reader.article.aiSummary.oneLiner }}</p>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-300">
              <li v-for="(p, i) in reader.article.aiSummary.points" :key="i">{{ p }}</li>
            </ul>
            <div class="mt-2 flex justify-end gap-2">
              <button data-ai-regenerate class="text-xs text-neutral-500 hover:underline dark:text-neutral-400" @click="regenerate">重新生成</button>
            </div>
          </div>
          <div v-else-if="showAiCard && ai.summaryState !== 'idle'" class="…card 同容器…" >
            <p data-ai-stream class="whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300">{{ ai.summaryStream }}<span v-if="ai.summaryState === 'loading'">▍</span></p>
            <p v-if="ai.summaryState === 'done' && !reader.article.aiSummary" class="mt-1 text-xs text-neutral-400">模型未按 JSON 输出,以上为原始回复</p>
          </div>
          <div v-else-if="showAiGuide && !ai.configured" data-ai-guide class="…card…">
            <p class="text-sm text-neutral-600 dark:text-neutral-300">尚未配置 AI 服务商。</p>
            <RouterLink to="/settings" class="text-sm text-[var(--accent)] hover:underline">前往设置 →</RouterLink>
          </div>
          <p v-if="ai.summaryError" data-ai-error class="mx-auto mt-2 w-full max-w-[var(--reader-width,720px)] text-xs text-red-600 dark:text-red-400">{{ ai.summaryError }}</p>
```

- 切文复位:`watch(() => reader.article?.id, () => { showAiCard 保持规则:文章有 aiSummary 时不自动弹,用户点按钮展开;showAiGuide=false; ai.resetSummary(); })`(store 加 `resetSummary()`)。

- [ ] **Step 3: README 与实测**

`README.md` 功能 8 改为:

```markdown
8. AI 摘要 / 翻译:自选 OpenAI 兼容服务商(国内模型可直连),流式生成要点摘要;密钥默认只存本机
```

`web/scripts/verify-ai.mjs`(一次性):构建产物 + 独立端口 4799 桩(`/api/ai/chat` 以 chunked 分三段发送 SSE fixture:两个 delta 帧含 JSON 片段 + `[DONE]`;`/api/articles/:id/ai-summary` 记录调用;预置 LS `readly_ai` 含 useProxy provider),CDP:
1. 打开文章 → 点 `[data-ai-button]` → `[data-ai-stream]` 出现且文本增长(两阶段截图/文本采样);
2. 完成后 `[data-ai-card]` 显示 oneLiner 与要点列表;`ai-summary` 桩收到 POST;
3. 点 `[data-ai-regenerate]` → 再次发起(桩计数 2);
4. 清掉 LS provider 后重载 → 点击按钮 → `[data-ai-guide]` 出现且链到 /settings;
5. 切暗色重测 2 的 DOM 断言;记录卡片/流文本对比度(≥4.5);
6. 截图 `/tmp/readly-ai-light.png`、`/tmp/readly-ai-dark.png`、引导态 `/tmp/readly-ai-guide.png`。

Run: `pnpm build && node web/scripts/verify-ai.mjs`
Expected: 全过;数值与截图名记入报告;验后删脚本。

- [ ] **Step 4: 提交**

```bash
git add web README.md
git commit -m "feat(web): AI 摘要接线(流式卡片/缓存/降级/未配置引导)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 后续计划索引

- **计划 07 — AI 翻译(M6b)**:段落切分/批量编号翻译/三态(原文/译文/对照)/缓存(含源哈希一致性)。复用本计划的 ai store、chatStream 与 /settings。
- **计划 08 — 收尾(M7)**:残留清理(移动端入口、README 终审、台账 Minor 清账)、最终全分支评审。

## 自检记录(writing-plans self-review)

- **规格覆盖**:设计 §8.8 服务商配置(多套+预设+可改)→ T3;直连/代理双路径 → T1(代理)+ T2(客户端);SSE 流式与中止 → T2/T4;摘要 JSON 口径与语言判定、6000 字、降级、缓存、重新生成 → T2/T4;密钥默认本地+可选云端+警示 → T3;无配置引导 → T4;翻译留计划 07(明确标注)。
- **冻结口径**:`AiProvider/AiSummary/SETTING_KEYS.aiProviders` 原样;`chatStream` 直连与代理的报文形状以 OpenAI 兼容契约为准。
- **有意决策**:①`generateSummary` 返回值为唯一结果通道(不做回调),缓存写回由 ReaderPane 负责(store 无 reader 依赖);②D1 副本剥离密钥的判定在推送时进行(本地始终全量);③非流式响应回退整段解析(T2);④摘要卡采用与来源条同层级的正文上方卡片而非工具栏浮层(复用既有布局模式)。
- **类型一致性**:`ChatMessage/SummaryOutcome/PROVIDER_PRESETS`(T2)→ store(T3/T4)→ UI(T4)同名;selector 契约贯穿测试与实测。
- **无占位符**:T3 的 store 实现描述为「要点+与既有切片同风格」并给出全部行为断言;T4 给出关键代码块与完整验收。
