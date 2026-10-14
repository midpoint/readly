import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleListItem } from "@readly/shared";
import { api } from "@/api/client";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
import { useArticlesStore } from "@/stores/articles";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import Inbox from "@/views/Inbox.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const ARTICLE: ArticleListItem = {
  id: 7,
  feedId: 1,
  feedTitle: "示例源",
  feedIconUrl: null,
  title: "冷启动可见的文章标题",
  url: null,
  author: null,
  publishedAt: "2025-10-13T08:00:00.000Z",
  excerpt: null,
  imageUrl: null,
  isRead: false,
  isStarred: false,
  isLater: false,
  hasFullText: false,
};

// jsdom 无 IntersectionObserver(ArticleList 挂载时使用)
class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let mounted: { app: App; container: HTMLElement } | null = null;

// 宏任务排空全部微任务链(store 初始化 → 请求 → 渲染),再补两次 DOM 更新
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

async function mountInbox(
  initialPath: string,
  pinia: Pinia = createPinia()
): Promise<{ router: Router; container: HTMLElement }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: Inbox }],
  });
  await router.push(initialPath);
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Inbox);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return { router, container };
}

function articleQueries(): Record<string, unknown>[] {
  return vi.mocked(api).mock.calls
    .filter(([path]) => path === "/api/articles")
    .map(([, opts]) => (opts?.query ?? {}) as Record<string, unknown>);
}

// 详情请求(GET /api/articles/:id,reader.open 只传 path)按调用顺序记录;PATCH 不计入
function detailGets(): string[] {
  return vi.mocked(api).mock.calls
    .filter(([path, opts]) => /^\/api\/articles\/\d+$/.test(path) && !opts?.method)
    .map(([path]) => path);
}

// items 工厂:以文件内 ARTICLE 为底,覆盖 id/isRead/title
function item(id: number, isRead: boolean): ArticleListItem {
  return { ...ARTICLE, id, isRead, title: `文章 ${id}` };
}

// 列表 + 每篇详情 + 其余端点(沿用文件内 vi.mocked(api).mockImplementation 模式)
function mockShortcutFlow(items: ArticleListItem[]): void {
  vi.mocked(api).mockImplementation((path, opts) => {
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    if (path === "/api/articles" && !opts?.method) return Promise.resolve({ items, nextCursor: null });
    const m = /^\/api\/articles\/(\d+)$/.exec(path);
    if (m && !opts?.method) {
      const found = items.find((i) => i.id === Number(m[1]));
      return Promise.resolve(
        found
          ? { ...found, content: "<p>正文</p>", contentFull: null, aiSummary: null, aiTranslation: null, extractedAt: null }
          : null
      );
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    if (path === "/api/articles") return Promise.resolve({ items: [ARTICLE], nextCursor: null });
    return Promise.resolve(null);
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  useShortcutHelp().closeShortcutHelp(); // 复位模块级单例,避免浮层开合状态外溢
  vi.unstubAllGlobals();
});

describe("Inbox 冷启动挂载", () => {
  it("裸 / 无参冷启动也发起首次加载(view=all)并渲染文章", async () => {
    const { container } = await mountInbox("/");
    expect(api).toHaveBeenCalledWith(
      "/api/articles",
      expect.objectContaining({ query: expect.objectContaining({ view: "all" }) })
    );
    const queries = articleQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.view).toBe("all");
    expect(container.textContent).toContain(ARTICLE.title);
  });

  it("?view=unread 按 URL 过滤;同一 filter 的重复 applyRouteQuery 不再重复请求", async () => {
    const { router, container } = await mountInbox("/?view=unread");
    expect(articleQueries()).toHaveLength(1);
    expect(articleQueries()[0]!.view).toBe("unread");
    expect(container.textContent).toContain(ARTICLE.title);

    // 变更与 filter 无关的查询参数 → 触发 route watcher(再次 applyRouteQuery)
    await router.replace("/?view=unread&t=1");
    await flush();
    // loaded 标志生效:filter 未变时不重复拉取(实际计数恒为 1,满足 ≤2)
    expect(articleQueries()).toHaveLength(1);
  });
});

describe("?a= 深链打开即已读", () => {
  it("默认偏好:深链打开未读文章 → 发出 PATCH isRead(与列表点击同语义)", async () => {
    mockShortcutFlow([item(1, true), item(2, false)]);
    const { container } = await mountInbox("/?a=2");
    await flush();

    expect(detailGets()).toEqual(["/api/articles/2"]);
    expect(useReaderStore().article?.id).toBe(2);
    expect(api).toHaveBeenCalledWith("/api/articles/2", { method: "PATCH", body: { isRead: true } });
    expect(container.textContent).toContain("文章 2");
  });

  it("关闭 autoMarkReadOnOpen:深链打开不发出 PATCH", async () => {
    mockShortcutFlow([item(1, true), item(2, false)]);
    const pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().updatePrefs({ autoMarkReadOnOpen: false });
    await mountInbox("/?a=2", pinia);
    await flush();

    expect(detailGets()).toEqual(["/api/articles/2"]);
    expect(useReaderStore().article?.id).toBe(2);
    const patches = vi.mocked(api).mock.calls.filter(([, o]) => o?.method === "PATCH");
    expect(patches).toHaveLength(0);
    localStorage.removeItem("readly_prefs"); // updatePrefs 的本地写入不跨用例
  });
});

describe("快捷键浏览(j/k 跳未读 + ? 浮层)", () => {
  it("j/k 依次跳到下一个/上一个未读并跳过已读,终点不越界重开", async () => {
    mockShortcutFlow([item(1, true), item(2, false), item(3, true), item(4, false), item(5, true), item(6, false)]);
    const { container } = await mountInbox("/");
    const root = container.firstElementChild as HTMLElement;

    // 无当前文章时 j:跳过已读 1,打开第一个未读 2
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await flush();
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/articles/2");
    expect(detailGets()).toEqual(["/api/articles/2"]);

    // 经 store 直接打开 6(不触发 selectArticle 的自动已读),再按 k:向前跳过已读 5 落到未读 4
    await useReaderStore().open(6);
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    await flush();
    expect(detailGets()).toEqual(["/api/articles/2", "/api/articles/6", "/api/articles/4"]);

    // 4 之前只剩已读(3 已读;2 已被打开时的自动已读置为已读):k 无未读可跳,停留
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    await flush();
    expect(detailGets()).toHaveLength(3);
    expect(useArticlesStore().currentId).toBe(4);

    // j:从 4 向后跳过已读 5,跳回未读 6
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await flush();
    expect(detailGets()).toEqual(["/api/articles/2", "/api/articles/6", "/api/articles/4", "/api/articles/6"]);

    // 已在末尾(6)且其后无未读:j 不越界、不重复打开当前文章
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await flush();
    expect(detailGets()).toHaveLength(4);
    expect(useArticlesStore().currentId).toBe(6);
  });

  it("? 打开帮助浮层并可切换;Esc 先关浮层不关文章,再 Esc 才关文章", async () => {
    mockShortcutFlow([item(1, true), item(2, false)]);
    const { router, container } = await mountInbox("/");
    const root = container.firstElementChild as HTMLElement;

    // 先 j 打开未读文章 2
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await flush();
    expect(useReaderStore().article?.id).toBe(2);

    // ? 打开浮层
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).not.toBeNull();
    expect(container.querySelector("[data-shortcut-help]")!.textContent).toContain("下一个未读文章");

    // Esc:只关浮层;文章仍打开,URL 仍带 a=2
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).toBeNull();
    expect(useReaderStore().article).not.toBeNull();
    expect(router.currentRoute.value.query.a).toBe("2");

    // ? 可再次开 / 关(切换)
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).not.toBeNull();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).toBeNull();

    // 浮层已关,再 Esc:文章关闭,URL 清 a
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(useReaderStore().article).toBeNull();
    expect(router.currentRoute.value.query.a).toBeUndefined();
  });

  it("浮层打开时按 j 不触发打开/已读(穿透屏蔽)", async () => {
    mockShortcutFlow([item(1, true), item(2, false)]);
    const { container } = await mountInbox("/");
    const root = container.firstElementChild as HTMLElement;

    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).not.toBeNull();

    const callsBefore = vi.mocked(api).mock.calls.length;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    await flush();
    expect(detailGets()).toHaveLength(0); // 未打开任何文章
    expect(vi.mocked(api).mock.calls.length).toBe(callsBefore); // 连 PATCH 都没有
    expect(useReaderStore().article).toBeNull();

    // ? 仍可关闭浮层
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).toBeNull();
  });

  it("卸载后浮层开关复位(onUnmounted 关浮层)", async () => {
    const { container } = await mountInbox("/");
    const root = container.firstElementChild as HTMLElement;

    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(useShortcutHelp().showShortcutHelp.value).toBe(true);

    mounted!.app.unmount();
    mounted!.container.remove();
    mounted = null;
    expect(useShortcutHelp().showShortcutHelp.value).toBe(false);
  });

  it("冷加载(document 级监听)未点击直接按 ?/j 生效", async () => {
    mockShortcutFlow([item(1, true), item(2, false)]);
    const { container } = await mountInbox("/");

    // 不点击/不聚焦:keydown 派发到 body(冒泡到 document,即文档级监听)
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).not.toBeNull();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-shortcut-help]")).toBeNull();

    // 冷加载下 j 也生效:打开第一个未读 2
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await flush();
    expect(detailGets()).toEqual(["/api/articles/2"]);
    expect(useReaderStore().article?.id).toBe(2);
  });
});
