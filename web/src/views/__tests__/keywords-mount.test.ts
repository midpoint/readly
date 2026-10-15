// @vitest-environment jsdom
import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeywordRule } from "@readly/shared";
import { api } from "@/api/client";
import { MemoryMirror, createMirror, syncMirror } from "@/modules/idb";
import { createAnalysisWorker } from "@/modules/worker-factory";
import { useAnalysisStore, type HitArticle } from "@/stores/analysis";
import KeywordDetail from "@/views/KeywordDetail.vue";
import Keywords from "@/views/Keywords.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// 真实 MemoryMirror 保留(测试直接构造),仅把 createMirror/syncMirror 换成桩
vi.mock("@/modules/idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/idb")>();
  return { ...actual, createMirror: vi.fn(), syncMirror: vi.fn() };
});

const hoisted = vi.hoisted(() => ({ worker: null as FakeWorker | null }));

vi.mock("@/modules/worker-factory", () => ({
  createAnalysisWorker: vi.fn(() => hoisted.worker),
}));

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {}
  emit(msg: unknown): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}

const RULES_LS_KEY = "readly_keyword_rules";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

const R1: KeywordRule = {
  id: "r1",
  name: "OpenAI",
  keyword: "openai",
  isRegex: false,
  caseSensitive: false,
  color: "#3b82f6",
  enabled: true,
};
const R2: KeywordRule = {
  id: "r2",
  name: "坏正则",
  keyword: "([",
  isRegex: true,
  caseSensitive: false,
  color: "#ef4444",
  enabled: true,
};

const HITS: Record<string, HitArticle[]> = {
  r1: [
    { id: 1, title: "OpenAI 发布新模型", feedTitle: "源A", publishedAt: T1, count: 3 },
    { id: 2, title: "OpenAI 跟进报道", feedTitle: "源B", publishedAt: T2, count: 1 },
  ],
};

let mounted: { app: App; container: HTMLElement } | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

interface MountResult {
  router: Router;
  container: HTMLElement;
  store: ReturnType<typeof useAnalysisStore>;
}

// 直接赋值 store state 造数(R1/R2 与命中都绕过 UI),再挂载视图
async function mountKeywords(
  rules: KeywordRule[],
  hitsByRule: Record<string, HitArticle[]> = HITS
): Promise<MountResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>inbox</div>" } },
      { path: "/keywords", component: Keywords },
      { path: "/keywords/:id", component: KeywordDetail },
    ],
  });
  await router.push("/keywords");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const pinia = createPinia();
  const store = useAnalysisStore(pinia);
  store.rules = rules.map((r) => ({ ...r }));
  store.hitsByRule = { ...hitsByRule };
  const app = createApp(Keywords);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return { router, container, store };
}

// 详情页挂载:同一路由表,推入 /keywords/:id 后直接挂 KeywordDetail
async function mountDetail(ruleId: string, rules: KeywordRule[] = [R1]): Promise<MountResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>inbox</div>" } },
      { path: "/keywords", component: Keywords },
      { path: "/keywords/:id", component: KeywordDetail },
    ],
  });
  await router.push(`/keywords/${ruleId}`);
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const pinia = createPinia();
  const store = useAnalysisStore(pinia);
  store.rules = rules.map((r) => ({ ...r }));
  store.hitsByRule = { ...HITS };
  const app = createApp(KeywordDetail);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return { router, container, store };
}

// 模拟键入:设值 + input 事件(v-model)
function setInput(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
  vi.mocked(createMirror).mockReset();
  vi.mocked(createMirror).mockResolvedValue(new MemoryMirror());
  vi.mocked(syncMirror).mockReset();
  vi.mocked(syncMirror).mockResolvedValue({ synced: 0, total: 0, exhausted: true });
  vi.mocked(createAnalysisWorker).mockClear();
  hoisted.worker = new FakeWorker();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
});

describe("Keywords 挂载", () => {
  it("规则列表渲染:两行,坏正则行内标「正则无效」,命中数取 hitsByRule", async () => {
    const { container } = await mountKeywords([R1, R2]);

    const rows = container.querySelectorAll("[data-rule-row]");
    expect(rows).toHaveLength(2);

    expect(rows[0]!.textContent).toContain("OpenAI");
    expect(rows[0]!.textContent).toContain("2 篇命中");
    expect(rows[0]!.textContent).not.toContain("正则无效");
    expect(rows[0]!.querySelector("[data-rule-detail]")).toBeTruthy();

    expect(rows[1]!.textContent).toContain("坏正则");
    expect(rows[1]!.textContent).toContain("正则无效");
    expect(rows[1]!.textContent).toContain("0 篇命中");
  });

  it("开关:点 r1 的 data-rule-toggle → enabled 置 false 且已写入 localStorage", async () => {
    const { container, store } = await mountKeywords([R1, R2]);

    const toggle = container.querySelectorAll<HTMLInputElement>("[data-rule-toggle]")[0]!;
    expect(toggle.checked).toBe(true);
    toggle.click();
    await nextTick();

    expect(store.rules[0]!.enabled).toBe(false);
    expect(store.rules[1]!.enabled).toBe(true);
    const saved = JSON.parse(localStorage.getItem(RULES_LS_KEY) ?? "[]") as KeywordRule[];
    expect(saved.find((r) => r.id === "r1")?.enabled).toBe(false);
  });

  it("新建:点 data-new-rule 弹出编辑器,填名称/关键词后保存 → 规则 +1", async () => {
    const { container, store } = await mountKeywords([R1]);

    container.querySelector<HTMLButtonElement>("[data-new-rule]")!.click();
    await nextTick();
    expect(container.querySelector("[data-rule-name]")).toBeTruthy();

    setInput(container.querySelector<HTMLInputElement>("[data-rule-name]")!, "Anthropic");
    setInput(container.querySelector<HTMLInputElement>("[data-rule-keyword]")!, "claude");
    await nextTick();

    const save = container.querySelector<HTMLButtonElement>("[data-rule-save]")!;
    expect(save.disabled).toBe(false);
    save.click();
    await nextTick();

    expect(store.rules).toHaveLength(2);
    expect(store.rules[1]!.name).toBe("Anthropic");
    expect(store.rules[1]!.keyword).toBe("claude");
    // 保存后编辑器关闭
    expect(container.querySelector("[data-rule-name]")).toBeNull();
  });

  it("无效正则:编辑器内勾选正则并输入 \"([\" → 「正则表达式无效」且保存置灰", async () => {
    const { container } = await mountKeywords([R1]);

    container.querySelector<HTMLButtonElement>("[data-new-rule]")!.click();
    await nextTick();

    const regexBox = container.querySelector<HTMLInputElement>("[data-rule-regex]")!;
    regexBox.click();
    await nextTick();
    expect(regexBox.checked).toBe(true);

    setInput(container.querySelector<HTMLInputElement>("[data-rule-keyword]")!, "([");
    await nextTick();

    const error = container.querySelector("[data-rule-error]");
    expect(error).toBeTruthy();
    expect(error!.textContent).toContain("正则表达式无效");
    expect(container.querySelector<HTMLButtonElement>("[data-rule-save]")!.disabled).toBe(true);
  });

  it("删除:点 data-rule-delete → 规则 -1", async () => {
    const { container, store } = await mountKeywords([R1, R2]);

    container.querySelectorAll<HTMLButtonElement>("[data-rule-delete]")[0]!.click();
    await nextTick();

    expect(store.rules).toHaveLength(1);
    expect(store.rules[0]!.id).toBe("r2");
  });

  // 补充断言(context 明示边界:updateRule(id, { keyword: "" }) 会静默删掉该规则,UI 层必须挡住)
  it("空关键词不允许保存", async () => {
    const { container, store } = await mountKeywords([R1]);

    container.querySelector<HTMLButtonElement>("[data-new-rule]")!.click();
    await nextTick();
    const save = container.querySelector<HTMLButtonElement>("[data-rule-save]")!;
    expect(save.disabled).toBe(true);

    setInput(container.querySelector<HTMLInputElement>("[data-rule-keyword]")!, "  ");
    await nextTick();
    expect(save.disabled).toBe(true);
    save.click();
    await nextTick();
    expect(store.rules).toHaveLength(1);
  });
});

describe("KeywordDetail 挂载", () => {
  it("hitsState=computing 时列表头部出现 [data-hits-computing]「本地匹配中…」,落地后消失", async () => {
    const { container, store } = await mountDetail("r1");

    // 初始 idle:不显示(计算中提示是条件渲染,不是常驻装饰)
    expect(container.querySelector("[data-hits-computing]")).toBeNull();

    store.hitsState = "computing";
    await flush();
    const hint = container.querySelector("[data-hits-computing]");
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain("本地匹配中");

    store.hitsState = "done";
    await flush();
    expect(container.querySelector("[data-hits-computing]")).toBeNull();
  });
});
