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
    { role: "user", content: `标题:${input.title}\n\n正文:\n${input.text.slice(0, 6000)}` },
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
