import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProvider } from "@readly/shared";
import {
  buildSummaryMessages,
  chatStream,
  detectTextLang,
  mergedAbortSignal,
  normalizeBaseUrl,
  parseSummary,
  PROVIDER_PRESETS,
  type ChatMessage,
} from "@/modules/ai";

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

function providerOf(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: "p1",
    name: "Test",
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "sk-test",
    useProxy: false,
    ...overrides,
  };
}

const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

async function collectChat(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("chatStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  // Fix wave 2:两条路径都带 120s 超时,并与调用方 signal 合并(任一 abort 即中止)
  it("mergedAbortSignal:无调用方 signal 用超时信号;两者合并,caller abort 传导到 fetch", async () => {
    const timeoutOnly = mergedAbortSignal(undefined);
    expect(timeoutOnly).toBeInstanceOf(AbortSignal);
    expect(timeoutOnly.aborted).toBe(false);
    expect(timeoutOnly).not.toBe(AbortSignal.timeout(1));

    const ctrl = new AbortController();
    const merged = mergedAbortSignal(ctrl.signal);
    expect(merged.aborted).toBe(false);
    ctrl.abort(new DOMException("Aborted", "AbortError"));
    expect(merged.aborted).toBe(true);
  });

  it("直连与代理 fetch 都收到合并信号:调用方 abort 即中止请求", async () => {
    for (const useProxy of [false, true]) {
      const ctrl = new AbortController();
      const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
      vi.stubGlobal("fetch", fetchMock);
      const gen = chatStream({ provider: providerOf({ useProxy }), messages: MSGS, signal: ctrl.signal });
      await collectChat(gen);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal).not.toBe(ctrl.signal);
      expect(init.signal!.aborted).toBe(false);
      ctrl.abort();
      expect(init.signal!.aborted).toBe(true);
    }
  });

  it("直连非流式回退:JSON 整段产出,URL 与 Bearer 鉴权正确", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "整段" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const got = await collectChat(chatStream({ provider: providerOf(), messages: MSGS }));
    expect(got).toEqual(["整段"]);
    const url = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("代理 SSE:目标 /api/ai/chat、Bearer 令牌、逐帧产出 delta;非 200 抛错含状态码", async () => {
    localStorage.setItem("readly_token", "tok-1");
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    vi.stubGlobal("fetch", fetchMock);
    const got = await collectChat(chatStream({ provider: providerOf({ useProxy: true, apiKey: "" }), messages: MSGS }));
    expect(got).toEqual(["你", "好"]);
    const url = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(url).toBe("/api/ai/chat");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 502 })));
    await expect(
      collectChat(chatStream({ provider: providerOf({ useProxy: true }), messages: MSGS }))
    ).rejects.toThrow(/502/);
  });

  // 控制者追加:代理 401 即全局未授权(令牌失效),就地清令牌并派发 readly:unauthorized
  // (与 api/client 的 401 口径一致);直连 401 是服务商自身鉴权失败,不动本地令牌
  it("代理 401:抛错含 401、清除 readly_token 并派发 readly:unauthorized", async () => {
    localStorage.setItem("readly_token", "tok-old");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    let fired = 0;
    const onUnauthorized = (): void => {
      fired += 1;
    };
    window.addEventListener("readly:unauthorized", onUnauthorized);
    try {
      await expect(
        collectChat(chatStream({ provider: providerOf({ useProxy: true, apiKey: "" }), messages: MSGS }))
      ).rejects.toThrow(/401/);
      expect(localStorage.getItem("readly_token")).toBeNull();
      expect(fired).toBe(1);

      // 直连 401:仅抛服务商错误,不清令牌、不派发全局事件
      localStorage.setItem("readly_token", "tok-keep");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
      await expect(collectChat(chatStream({ provider: providerOf(), messages: MSGS }))).rejects.toThrow(/401/);
      expect(localStorage.getItem("readly_token")).toBe("tok-keep");
      expect(fired).toBe(1);
    } finally {
      window.removeEventListener("readly:unauthorized", onUnauthorized);
    }
  });
});
