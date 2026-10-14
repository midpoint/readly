// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { api } from "@/api/client";
import ReaderPane from "@/components/ReaderPane.vue";
import { chatStream } from "@/modules/ai";
import { useAiStore } from "@/stores/ai";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});
// 只打桩流式客户端;aiTextOf/detectTextLang 等保持真实
vi.mock("@/modules/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/ai")>();
  return { ...actual, chatStream: vi.fn() };
});

const BASE = {
  id: 1, feedId: 1, feedTitle: "F", feedIconUrl: null, title: "标题", url: "https://n.example.com/a",
  author: null, publishedAt: "2026-01-01T00:00:00.000Z", excerpt: "短摘要", imageUrl: null,
  isRead: true, isStarred: false, isLater: false, hasFullText: false,
  content: "<p>订阅摘要正文</p>", contentFull: null, aiSummary: null, aiTranslation: null, extractedAt: null,
};

let app: App | null = null;
let host: HTMLElement | null = null;
let router: Router | null = null;
let release: () => void = () => undefined;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(chatStream).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  router = null;
});

// 两阶段流:首段入流后停在 gate,由测试 release 释放第二段
function phasedJsonStream(): void {
  const gate = new Promise<void>((r) => (release = r));
  vi.mocked(chatStream).mockImplementation(() =>
    (async function* () {
      yield '{"one_liner":"总';
      await gate;
      yield '结","points":["要点一","要点二"]}';
    })()
  );
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
  await nextTick();
}

async function mountReader(article: Record<string, unknown> = {}, opts: { configureAi?: boolean } = {}): Promise<void> {
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/articles/1") return Promise.resolve({ ...BASE, ...article });
    if (path === "/api/articles/2") return Promise.resolve({ ...BASE, id: 2, title: "第二篇", aiSummary: null });
    return Promise.resolve({});
  });
  app?.unmount();
  app = null;
  host!.innerHTML = "";
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.initLocal();
  settings.updateFetchPrefs({ auto: false });
  const ai = useAiStore();
  ai.init();
  if (opts.configureAi !== false) ai.addProvider({ apiKey: "sk-1", useProxy: true });
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/settings", component: { template: "<div />" } },
    ],
  });
  await router.push("/");
  await router.isReady();
  app = createApp(ReaderPane);
  app.use(pinia);
  app.use(router);
  setActivePinia(pinia);
  app.mount(host!);
  await useReaderStore().open(1);
  await nextTick();
}

function aiButton(): HTMLButtonElement {
  const btn = host!.querySelector<HTMLButtonElement>("[data-ai-button]");
  expect(btn).not.toBeNull();
  return btn!;
}

describe("ReaderPane AI 摘要", () => {
  it("未配置服务商:点击按钮显示引导卡并链到 /settings,不发请求", async () => {
    await mountReader({}, { configureAi: false });
    aiButton().click();
    await nextTick();

    const guide = host!.querySelector("[data-ai-guide]");
    expect(guide).not.toBeNull();
    expect(guide!.textContent).toContain("尚未配置 AI 服务商");
    expect(guide!.querySelector("a")!.getAttribute("href")).toBe("/settings");
    expect(guide!.querySelector("a")!.textContent).toContain("前往设置");
    expect(vi.mocked(chatStream)).not.toHaveBeenCalled();
    expect(host!.querySelector("[data-ai-stream]")).toBeNull();
    expect(host!.querySelector("[data-ai-card]")).toBeNull();
  });

  it("已配置:点击后流式卡片出现且文本增长,完成后展示 oneLiner 与要点并写入缓存", async () => {
    await mountReader({});
    phasedJsonStream();
    aiButton().click();
    await flush();

    const streamEl = host!.querySelector("[data-ai-stream]");
    expect(streamEl).not.toBeNull();
    expect(streamEl!.textContent).toContain('{"one_liner":"总');
    expect(aiButton().disabled).toBe(true);
    expect(aiButton().textContent).toContain("生成中…");

    release();
    await vi.waitFor(() => expect(host!.querySelector("[data-ai-card]")).not.toBeNull());
    const card = host!.querySelector("[data-ai-card]")!;
    expect(card.textContent).toContain("总结");
    expect(card.querySelectorAll("li")).toHaveLength(2);
    expect(card.querySelector("li")!.textContent).toBe("要点一");
    expect(useReaderStore().article!.aiSummary).toEqual({ oneLiner: "总结", points: ["要点一", "要点二"] });
    // 缓存写回(POST 由 store 发起,失败静默)
    const post = vi.mocked(api).mock.calls.find(([p, o]) => p === "/api/articles/1/ai-summary" && o?.method === "POST");
    expect(post).toBeTruthy();
    expect((post![1]!.body as { summary: { oneLiner: string } }).summary.oneLiner).toBe("总结");
  });

  it("模型未按 JSON 输出:降级卡片保留原始回复并给出说明,不写缓存", async () => {
    await mountReader({});
    vi.mocked(chatStream).mockImplementation(() =>
      (async function* () {
        yield "这是一段普通文字";
      })()
    );
    aiButton().click();
    await vi.waitFor(() => expect(host!.textContent).toContain("模型未按 JSON 输出,以上为原始回复"));

    expect(host!.querySelector("[data-ai-stream]")!.textContent).toContain("这是一段普通文字");
    expect(useReaderStore().article!.aiSummary).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).endsWith("/ai-summary"))).toBe(false);
    expect(aiButton().disabled).toBe(false);
  });

  it("已有缓存:点击按钮切换卡片显隐,不重新生成", async () => {
    await mountReader({ aiSummary: { oneLiner: "缓存总结", points: ["x"] } });
    expect(host!.querySelector("[data-ai-card]")).toBeNull();

    aiButton().click();
    await nextTick();
    expect(host!.querySelector("[data-ai-card]")!.textContent).toContain("缓存总结");

    aiButton().click();
    await nextTick();
    expect(host!.querySelector("[data-ai-card]")).toBeNull();
    expect(vi.mocked(chatStream)).not.toHaveBeenCalled();
  });

  it("重新生成:再次流式生成并替换卡片内容", async () => {
    await mountReader({ aiSummary: { oneLiner: "旧总结", points: ["旧"] } });
    aiButton().click();
    await nextTick();
    expect(host!.querySelector("[data-ai-card]")!.textContent).toContain("旧总结");

    vi.mocked(chatStream).mockImplementation(() =>
      (async function* () {
        yield '{"one_liner":"新总结","points":["新要点"]}';
      })()
    );
    host!.querySelector<HTMLButtonElement>("[data-ai-regenerate]")!.click();
    await vi.waitFor(() => expect(host!.querySelector("[data-ai-card]")!.textContent).toContain("新总结"));

    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(1);
    expect(useReaderStore().article!.aiSummary).toEqual({ oneLiner: "新总结", points: ["新要点"] });
  });

  it("切文复位:在途生成作废,卡片/引导收起、摘要状态清空", async () => {
    await mountReader({});
    phasedJsonStream();
    aiButton().click();
    await flush();
    expect(host!.querySelector("[data-ai-stream]")).not.toBeNull();

    await useReaderStore().open(2);
    await nextTick();

    expect(host!.querySelector("[data-ai-stream]")).toBeNull();
    expect(host!.querySelector("[data-ai-card]")).toBeNull();
    const ai = useAiStore();
    expect(ai.summaryState).toBe("idle");
    expect(ai.summaryStream).toBe("");
    expect(useReaderStore().article!.aiSummary).toBeNull();
  });
});
