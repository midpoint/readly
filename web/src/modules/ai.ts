import type { AiProvider, AiSummary } from "@readly/shared";
import { clearToken, getToken } from "@/api/client";
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

// 摘要解析结果:summary 为 null 表示模型未按 JSON 输出,raw 为原始回复(UI 降级展示)
export interface SummaryOutcome {
  summary: AiSummary | null;
  raw: string;
}

export function parseSummary(out: string): SummaryOutcome {
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

// 直连/代理统一 120s 超时(Worker 代理侧同款,两端一致);与调用方 signal 合并,任一 abort 即中止
const STREAM_TIMEOUT_MS = 120_000;

// 合并调用方 signal 与约束 signal(如超时):任一 abort 即传导;AbortSignal.any 缺失时走兼容回退
export function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(a ? [a, b] : [b]);
  // 兼容回退(Chrome <116 / Safari <17.4 等):任一 abort 传导到合并信号,并清理另一侧监听
  const controller = new AbortController();
  const sources = a ? [a, b] : [b];
  const forward = (from: AbortSignal): void => {
    for (const s of sources) s.removeEventListener("abort", onAbort);
    controller.abort(from.reason);
  };
  const onAbort = (ev: Event): void => forward(ev.target as AbortSignal);
  const alreadyAborted = sources.find((s) => s.aborted);
  if (alreadyAborted) controller.abort(alreadyAborted.reason);
  else for (const s of sources) s.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function mergedAbortSignal(caller: AbortSignal | undefined, timeoutMs = STREAM_TIMEOUT_MS): AbortSignal {
  return mergeSignals(caller, AbortSignal.timeout(timeoutMs));
}

// fetch 的超时(浏览器以 TimeoutError DOMException 拒绝)统一映射为中文文案;
// 取消(caller abort)reason 为 AbortError,原样抛出——store 依 controller.signal.aborted 静默收束,语义不变
function throwMappedFetchError(e: unknown): never {
  if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("请求超时");
  throw e;
}

export async function* chatStream(opts: {
  provider: AiProvider;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** 超时毫秒数(默认 120s;测试可缩短以验证超时文案) */
  timeoutMs?: number;
}): AsyncGenerator<string> {
  const { provider } = opts;
  const signal = mergeSignals(opts.signal, AbortSignal.timeout(opts.timeoutMs ?? STREAM_TIMEOUT_MS));
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
    try {
      res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: payload,
        signal,
      });
    } catch (e) {
      throwMappedFetchError(e);
    }
  } else {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    try {
      res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: provider.model, messages: opts.messages, stream: true }),
        signal,
      });
    } catch (e) {
      throwMappedFetchError(e);
    }
  }

  if (!res.ok) {
    // 代理路径 401 = 本站令牌失效(与 api/client 口径一致):就地补全局未授权流,再抛服务商错误
    if (provider.useProxy && res.status === 401) {
      clearToken();
      window.dispatchEvent(new CustomEvent("readly:unauthorized"));
    }
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
