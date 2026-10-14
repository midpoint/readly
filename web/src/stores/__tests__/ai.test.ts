import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_KEYS, type AiProvider, type AiSummary } from "@readly/shared";
import { api } from "@/api/client";
import { chatStream, PROVIDER_PRESETS } from "@/modules/ai";
import { sanitizeAi, useAiStore } from "@/stores/ai";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// chatStream 打桩:摘要流程只关心「取流 + 状态机 + 缓存写回」,SSE 解析已由 modules 层单测覆盖
vi.mock("@/modules/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/ai")>();
  return { ...actual, chatStream: vi.fn() };
});

const LS_KEY = "readly_ai";

function validProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: "p1",
    name: "服务商一",
    baseUrl: "https://a.example.com/v1",
    model: "model-a",
    apiKey: "sk-a",
    useProxy: false,
    ...overrides,
  };
}

// 最近一次 /api/settings PUT 的 kv.ai_providers 载荷(未发过则 undefined)
function lastAiPayload(): { providers: AiProvider[]; activeId: string | null; syncKeys: boolean } | undefined {
  const put = vi
    .mocked(api)
    .mock.calls.filter(([path, opts]) => path === "/api/settings" && opts?.method === "PUT")
    .at(-1);
  if (!put) return undefined;
  const kv = (put[1]!.body as { kv: Record<string, unknown> }).kv;
  return kv[SETTING_KEYS.aiProviders] as { providers: AiProvider[]; activeId: string | null; syncKeys: boolean };
}

function putCount(): number {
  return vi.mocked(api).mock.calls.filter(([path, opts]) => path === "/api/settings" && opts?.method === "PUT").length;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
  vi.mocked(chatStream).mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeAi", () => {
  it("非对象/非法形状输入 → 空集默认", () => {
    expect(sanitizeAi(null)).toEqual({ providers: [], activeId: null, syncKeys: false });
    expect(sanitizeAi("junk")).toEqual({ providers: [], activeId: null, syncKeys: false });
    expect(sanitizeAi({ providers: "junk" })).toEqual({ providers: [], activeId: null, syncKeys: false });
  });

  it("逐字段清洗:非法条目丢弃、重复 id 丢弃、apiKey 仅非空字符串保留", () => {
    const s = sanitizeAi({
      providers: [
        { id: "a", name: "A", baseUrl: "https://a.example.com/v1", model: "m", apiKey: "sk-a", useProxy: true },
        null,
        "junk",
        { id: "", baseUrl: "https://x.example.com/v1", model: "m" },
        { id: "b", name: "B", baseUrl: "", model: "m" },
        { id: "c", name: "C", baseUrl: "https://c.example.com/v1", model: "" },
        { id: "a", name: "重复", baseUrl: "https://dup.example.com/v1", model: "m" },
        { id: "d", name: "D", baseUrl: "https://d.example.com/v1", model: "m4", apiKey: 123, useProxy: "yes" },
        { id: "e", name: "E", baseUrl: " https://e.example.com/v1 ", model: " m5 ", apiKey: "" },
      ],
      activeId: "a",
      syncKeys: "yes",
    });
    expect(s.providers.map((p) => p.id)).toEqual(["a", "d", "e"]);
    expect(s.providers[0]).toEqual({
      id: "a",
      name: "A",
      baseUrl: "https://a.example.com/v1",
      model: "m",
      apiKey: "sk-a",
      useProxy: true,
    });
    // baseUrl/model 去空白
    expect(s.providers[2]!.baseUrl).toBe("https://e.example.com/v1");
    expect(s.providers[2]!.model).toBe("m5");
    // apiKey 非字符串或空串 → 字段不落地
    expect("apiKey" in s.providers[1]!).toBe(false);
    expect("apiKey" in s.providers[2]!).toBe(false);
    // useProxy 仅严格 true 为真
    expect(s.providers[1]!.useProxy).toBe(false);
    expect(s.activeId).toBe("a");
    expect(s.syncKeys).toBe(false);
  });

  it("providers 上限 20,超出截断;activeId 悬空/非字符串置 null", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      baseUrl: `https://p${i}.example.com/v1`,
      model: "m",
    }));
    const s = sanitizeAi({ providers: many, activeId: "p23" });
    expect(s.providers).toHaveLength(20);
    expect(s.providers[19]!.id).toBe("p19");
    expect(s.activeId).toBeNull();
    expect(sanitizeAi({ providers: [], activeId: "ghost" }).activeId).toBeNull();
    expect(sanitizeAi({ providers: [], activeId: 42 }).activeId).toBeNull();
  });

  it("name 缺省回退 model;syncKeys 严格布尔", () => {
    const s = sanitizeAi({ providers: [{ id: "a", baseUrl: "https://a.example.com/v1", model: "m1" }], syncKeys: true });
    expect(s.providers[0]!.name).toBe("m1");
    expect(s.syncKeys).toBe(true);
    expect(sanitizeAi({ syncKeys: 1 }).syncKeys).toBe(false);
  });
});

describe("ai store 服务商 CRUD", () => {
  it("addProvider 预设填充 + 唯一 id;setActive/updateProvider/removeProvider", () => {
    const store = useAiStore();
    store.init();

    const id1 = store.addProvider();
    expect(id1.startsWith("ai_")).toBe(true);
    expect(store.providers).toHaveLength(1);
    expect(store.providers[0]).toEqual({
      id: id1,
      name: PROVIDER_PRESETS[0]!.name,
      baseUrl: PROVIDER_PRESETS[0]!.baseUrl,
      model: PROVIDER_PRESETS[0]!.model,
      useProxy: false,
    });

    const id2 = store.addProvider({ name: "自定义", baseUrl: "https://x.example.com/v1", model: "m2", apiKey: "sk-2", useProxy: true });
    expect(id2).not.toBe(id1);
    expect(store.providers).toHaveLength(2);
    expect(store.providers[1]!.apiKey).toBe("sk-2");
    expect(store.providers[1]!.useProxy).toBe(true);

    store.setActive(id2);
    expect(store.activeId).toBe(id2);
    expect(store.active?.id).toBe(id2);
    expect(store.configured).toBe(true);
    // 悬空 id → null
    store.setActive("ghost");
    expect(store.activeId).toBeNull();
    expect(store.configured).toBe(false);
    store.setActive(id2);

    store.updateProvider(id2, { model: "m3" });
    expect(store.providers[1]!.model).toBe("m3");
    store.updateProvider(id1, { apiKey: "" });
    expect("apiKey" in store.providers[0]!).toBe(false);

    store.removeProvider(id1);
    expect(store.providers.map((p) => p.id)).toEqual([id2]);
    // 删除激活项 → activeId 清空
    store.removeProvider(id2);
    expect(store.providers).toEqual([]);
    expect(store.activeId).toBeNull();
  });

  // 控制者追加 1:首条服务商自动激活(空 store 添加即成为 active;已有 active 时新增不顶掉)
  it("addProvider 首条自动激活;已有 active 时新增不改变 activeId", () => {
    const store = useAiStore();
    store.init();
    const id1 = store.addProvider();
    expect(store.activeId).toBe(id1);
    expect(store.configured).toBe(true);

    const id2 = store.addProvider({ name: "第二条" });
    expect(store.activeId).toBe(id1);

    store.setActive(id2);
    store.addProvider({ name: "第三条" });
    expect(store.activeId).toBe(id2);
  });

  // 控制者追加 2:updateProvider 后 sanitize 丢弃该条(如 model 置空)→ activeId 悬空自愈为 null
  it("updateProvider 被 sanitize 丢弃该条 → activeId 置 null(悬空自愈)", () => {
    const store = useAiStore();
    store.init();
    const id = store.addProvider();
    expect(store.activeId).toBe(id);

    store.updateProvider(id, { model: "" });
    expect(store.providers).toEqual([]);
    expect(store.activeId).toBeNull();
    expect(store.configured).toBe(false);
  });
});

describe("ai store 持久化与密钥口径", () => {
  it("密钥剥离:syncKeys=false 的 D1 副本无 apiKey 字段;true 时含", async () => {
    const store = useAiStore();
    store.init();
    const id = store.addProvider({ apiKey: "sk-secret" });
    store.setActive(id);

    store.updateSyncKeys(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(putCount()).toBe(1);
    let payload = lastAiPayload()!;
    expect(payload.syncKeys).toBe(false);
    expect(payload.activeId).toBe(id);
    expect(payload.providers).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(payload.providers[0], "apiKey")).toBe(false);
    expect(payload.providers[0]).toEqual({
      id,
      name: PROVIDER_PRESETS[0]!.name,
      baseUrl: PROVIDER_PRESETS[0]!.baseUrl,
      model: PROVIDER_PRESETS[0]!.model,
      useProxy: false,
    });

    store.updateSyncKeys(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(putCount()).toBe(2);
    payload = lastAiPayload()!;
    expect(payload.syncKeys).toBe(true);
    expect(payload.providers[0]!.apiKey).toBe("sk-secret");

    // 一键回切:云端副本再次剥离,本地不丢
    store.updateSyncKeys(false);
    await vi.advanceTimersByTimeAsync(1100);
    payload = lastAiPayload()!;
    expect(Object.prototype.hasOwnProperty.call(payload.providers[0], "apiKey")).toBe(false);
    expect(JSON.parse(localStorage.getItem(LS_KEY)!).providers[0].apiKey).toBe("sk-secret");
  });

  it("readly_ai 始终含密钥(本地全量,与 syncKeys 无关)", () => {
    const store = useAiStore();
    store.init();
    store.addProvider({ apiKey: "sk-ls" });

    let saved = JSON.parse(localStorage.getItem(LS_KEY)!) as { providers: AiProvider[]; activeId: string | null; syncKeys: boolean };
    expect(saved.providers[0]!.apiKey).toBe("sk-ls");
    expect(saved.providers[0]!.id).toBe(store.providers[0]!.id);
    expect(saved.syncKeys).toBe(false);

    store.updateSyncKeys(true);
    saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(saved.providers[0]!.apiKey).toBe("sk-ls");
    expect(saved.syncKeys).toBe(true);

    store.setActive(store.providers[0]!.id);
    expect(JSON.parse(localStorage.getItem(LS_KEY)!).activeId).toBe(store.providers[0]!.id);
  });

  it("本地无 readly_ai 时 init 后采用服务端副本(含 activeId/syncKeys)", async () => {
    vi.mocked(api).mockResolvedValue({
      [SETTING_KEYS.aiProviders]: {
        providers: [{ id: "s1", name: "Server", baseUrl: "https://s.example.com/v1", model: "sm", useProxy: true }],
        activeId: "s1",
        syncKeys: false,
      },
    });
    const store = useAiStore();
    store.init();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.providers.map((p) => p.id)).toEqual(["s1"]);
    expect(store.activeId).toBe("s1");
    expect(store.configured).toBe(true);
    // 采用后本地与 D1 基线一致:不产生多余回写
    await vi.advanceTimersByTimeAsync(1100);
    expect(putCount()).toBe(0);
  });

  it("服务端无可采用内容时 init 保持默认空且不回写", async () => {
    vi.mocked(api).mockResolvedValue({});
    const store = useAiStore();
    store.init();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.providers).toEqual([]);
    expect(store.activeId).toBeNull();
    expect(store.syncKeys).toBe(false);
    expect(store.configured).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(putCount()).toBe(0);
  });

  it("本地已有 readly_ai 时 init 不采用服务端(本地为真源,并回写 D1)", async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ providers: [validProvider({ id: "local1" })], activeId: "local1", syncKeys: false })
    );
    vi.mocked(api).mockResolvedValue({
      [SETTING_KEYS.aiProviders]: {
        providers: [{ id: "s1", name: "Server", baseUrl: "https://s.example.com/v1", model: "sm", useProxy: false }],
        activeId: "s1",
        syncKeys: true,
      },
    });
    const store = useAiStore();
    store.init();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.providers.map((p) => p.id)).toEqual(["local1"]);
    expect(store.activeId).toBe("local1");
    expect(store.syncKeys).toBe(false);

    // 本地内容与 D1 基线不同 → 防抖回写(剥离密钥)
    await vi.advanceTimersByTimeAsync(1100);
    expect(putCount()).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(lastAiPayload()!.providers[0], "apiKey")).toBe(false);
  });
});

// 摘要写回缓存的目标(store 负责请求,ReaderPane 负责把返回值落到 reader.article.aiSummary)
function summaryPosts(): { id: string; body: unknown }[] {
  return vi
    .mocked(api)
    .mock.calls.filter(([path, opts]) => /^\/api\/articles\/\d+\/ai-summary$/.test(path) && opts?.method === "POST")
    .map(([path, opts]) => ({ id: path.split("/")[3]!, body: opts!.body }));
}

describe("ai store 摘要流程", () => {
  const INPUT = { id: 7, title: "标题", text: "正文内容", lang: "zh" as const };

  // 让出控制权时,上一段已被 store 消费计入(用于断言「逐段累计」)
  function chunkedStream(chunks: string[]): (opts: { signal?: AbortSignal }) => AsyncGenerator<string> {
    return () => {
      const store = useAiStore();
      return (async function* () {
        for (const c of chunks) {
          yield c;
          seen.push(store.summaryStream);
        }
      })();
    };
  }
  let seen: string[] = [];

  beforeEach(() => {
    seen = [];
  });

  it("流式生成:逐段累计、状态 done、POST 缓存写回、返回值携带 summary", async () => {
    const store = useAiStore();
    store.init();
    const id = store.addProvider({ apiKey: "sk-1" });
    vi.mocked(chatStream).mockImplementation(chunkedStream(['{"one_liner":"总', '结","points":["a"]}']));

    const outcome = await store.generateSummary(INPUT);

    expect(outcome.summary).toEqual({ oneLiner: "总结", points: ["a"] });
    expect(store.summaryStream).toBe('{"one_liner":"总结","points":["a"]}');
    expect(seen).toEqual(['{"one_liner":"总', '{"one_liner":"总结","points":["a"]}']);
    expect(store.summaryState).toBe("done");
    expect(store.summaryError).toBeNull();
    // 传给 chatStream 的是当前激活服务商
    expect(vi.mocked(chatStream).mock.calls[0]![0].provider.id).toBe(id);

    const posts = summaryPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.id).toBe("7");
    expect((posts[0]!.body as { summary: AiSummary }).summary.oneLiner).toBe("总结");
  });

  it("非 JSON 降级:状态 done、返回 summary:null 且原文留存(不写缓存)", async () => {
    const store = useAiStore();
    store.init();
    store.addProvider({ apiKey: "sk-1" });
    vi.mocked(chatStream).mockImplementation(chunkedStream(["这是一段普通文字"]));

    const outcome = await store.generateSummary(INPUT);

    expect(outcome.summary).toBeNull();
    expect(outcome.raw).toBe("这是一段普通文字");
    expect(store.summaryState).toBe("done");
    expect(store.summaryStream).toBe("这是一段普通文字");
    expect(summaryPosts()).toHaveLength(0);
  });

  it("取消:abort 传给 chatStream 的 signal,状态回 idle,不写缓存", async () => {
    const store = useAiStore();
    store.init();
    store.addProvider({ apiKey: "sk-1" });
    let signal: AbortSignal | undefined;
    vi.mocked(chatStream).mockImplementation((opts) => {
      signal = opts.signal;
      return (async function* () {
        yield '{"one_liner":"总';
        await new Promise((_, reject) => {
          opts.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      })();
    });

    const pending = store.generateSummary(INPUT);
    await vi.advanceTimersByTimeAsync(0); // 让首段入流
    expect(store.summaryStream).toBe('{"one_liner":"总');
    expect(store.summaryState).toBe("loading");

    store.cancelSummary();
    const outcome = await pending;
    expect(signal!.aborted).toBe(true);
    expect(store.summaryState).toBe("idle");
    expect(outcome.summary).toBeNull();
    expect(summaryPosts()).toHaveLength(0);
  });

  it("未配置:立即 reject,不发请求、状态仍 idle", async () => {
    const store = useAiStore();
    store.init();

    await expect(store.generateSummary(INPUT)).rejects.toThrow("请先在设置中配置 AI 服务商");
    expect(vi.mocked(chatStream)).not.toHaveBeenCalled();
    expect(store.summaryState).toBe("idle");
  });
});
