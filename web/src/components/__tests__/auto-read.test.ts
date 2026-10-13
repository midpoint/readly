// @vitest-environment jsdom
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { api } from "@/api/client";
import ArticleList from "@/components/ArticleList.vue";
import ReaderPane from "@/components/ReaderPane.vue";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// jsdom 无 IntersectionObserver:捕获回调供测试触发
class FakeIO {
  static instances: FakeIO[] = [];
  callback: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    FakeIO.instances.push(this);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

const ITEM = {
  id: 1,
  feedId: 1,
  feedTitle: "F",
  feedIconUrl: null,
  title: "标题一",
  url: null,
  author: null,
  publishedAt: "2026-01-01T00:00:00.000Z",
  excerpt: null,
  imageUrl: null,
  isRead: false,
  isStarred: false,
  isLater: false,
  hasFullText: false,
};

let app: App | null = null;
let host: HTMLElement | null = null;
// 同一 pinia 实例贯穿「测试体内取的 store」与「挂载的组件」,否则开关改了组件也看不到
let pinia: Pinia;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIO);
  FakeIO.instances = [];
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

// 宏任务排空点击后的异步链(reader.open → route.replace → setState PATCH),再补一次 DOM 更新
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountList() {
  const router = createRouter({ history: createWebHistory(), routes: [{ path: "/", component: { template: "<div/>" } }] });
  await router.push("/");
  await router.isReady();
  app = createApp(ArticleList);
  app.use(pinia);
  setActivePinia(pinia);
  app.use(router);
  app.mount(host!);
  await nextTick();
}

describe("autoMarkReadOnOpen", () => {
  it("关闭时点击文章不发 PATCH;开启时发 PATCH", async () => {
    const settings = useSettingsStore();
    settings.initLocal();
    settings.updatePrefs({ autoMarkReadOnOpen: false });
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles") return Promise.resolve({ items: [{ ...ITEM }], nextCursor: null });
      if (path === "/api/articles/1") return Promise.resolve({ ...ITEM });
      return Promise.resolve({});
    });
    await mountList();
    // 列表由外部加载(避开冷启动守卫)
    const { useArticlesStore } = await import("@/stores/articles");
    await useArticlesStore().load(true);
    await nextTick();
    // 第一个 button 是工具栏「全部标已读」,按标题取文章行
    const row = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes(ITEM.title)
    );
    row!.click();
    await flush();
    const patches = vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/articles/1" && o?.method === "PATCH");
    expect(patches).toHaveLength(0);

    settings.updatePrefs({ autoMarkReadOnOpen: true });
    useArticlesStore().patchItemLocally(1, { isRead: false });
    row!.click();
    await flush();
    const patches2 = vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/articles/1" && o?.method === "PATCH");
    expect(patches2).toHaveLength(1);
  });
});

describe("autoMarkReadOnScroll", () => {
  it("哨兵可见且开启时自动标已读;关闭时不标", async () => {
    const settings = useSettingsStore();
    settings.initLocal();
    vi.mocked(api).mockImplementation((path, o) => {
      if (path === "/api/articles/2") return o?.method === "PATCH" ? Promise.resolve({}) : Promise.resolve({ ...ITEM, id: 2, isRead: false });
      return Promise.resolve({});
    });
    const router = createRouter({ history: createWebHistory(), routes: [{ path: "/", component: { template: "<div/>" } }] });
    await router.push("/");
    await router.isReady();
    app = createApp(ReaderPane);
    app.use(pinia);
    setActivePinia(pinia);
    app.use(router);
    app.mount(host!);
    const reader = useReaderStore();
    await reader.open(2);
    await nextTick();

    // 结构性守卫:哨兵必须在滚动容器内且位于内容末尾(移出去则不随滚动、恒可见即触发)
    const sentinel = host!.querySelector(".h-px");
    expect(sentinel).not.toBeNull();
    const scroller = sentinel!.closest(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.lastElementChild).toBe(sentinel);

    settings.updatePrefs({ autoMarkReadOnScroll: false });
    const io = FakeIO.instances.at(-1)!;
    io.callback([{ isIntersecting: true } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    await nextTick();
    expect(vi.mocked(api).mock.calls.filter(([p, o]) => o?.method === "PATCH")).toHaveLength(0);

    settings.updatePrefs({ autoMarkReadOnScroll: true });
    io.callback([{ isIntersecting: true } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    await nextTick();
    expect(vi.mocked(api).mock.calls.filter(([p, o]) => o?.method === "PATCH")).toHaveLength(1);
  });
});
