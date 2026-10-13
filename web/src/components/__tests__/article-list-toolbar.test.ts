import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleListItem, Feed } from "@readly/shared";
import { api } from "@/api/client";
import ArticleList from "@/components/ArticleList.vue";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const FEED: Feed = {
  id: 3,
  url: "https://a.example.com/rss",
  siteUrl: null,
  title: "示例源",
  description: null,
  iconUrl: null,
  categoryId: null,
  sortOrder: 0,
  lastFetchedAt: null,
  errorCount: 0,
  lastError: null,
  unreadCount: 1,
  createdAt: "2025-10-13T00:00:00.000Z",
};

const ARTICLE: ArticleListItem = {
  id: 7,
  feedId: 3,
  feedTitle: "示例源",
  feedIconUrl: null,
  title: "待读文章",
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

// 宏任务排空全部微任务链(点击 → markAllRead → load → 列表重载),再补两次 DOM 更新
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

async function mountList(pinia: Pinia): Promise<HTMLElement> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { template: "<div />" } }],
  });
  await router.push("/");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(ArticleList);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return container;
}

function articleQueries(): Record<string, unknown>[] {
  return vi.mocked(api).mock.calls
    .filter(([path]) => path === "/api/articles")
    .map(([, opts]) => (opts?.query ?? {}) as Record<string, unknown>);
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path, opts) => {
    if (path === "/api/articles/mark-all-read" && opts?.method === "POST") return Promise.resolve({ updated: 1 });
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([FEED]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 1, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    if (path === "/api/articles") return Promise.resolve({ items: [ARTICLE], nextCursor: null });
    return Promise.resolve(null);
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  vi.unstubAllGlobals();
});

describe("ArticleList 顶部工具栏", () => {
  it("feed 过滤下点「全部标已读」:POST mark-all-read 携带 feed scope 并重载列表", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load(); // 工具栏范围文案需要 feed 标题
    const articles = useArticlesStore();
    await articles.setFilter("all", FEED.id, null);

    const container = await mountList(pinia);
    // 工具栏左侧显示当前范围(源标题)
    expect(container.textContent).toContain("示例源");
    const queriesBefore = articleQueries().length;

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "全部标已读");
    expect(button).toBeTruthy();
    button!.click();
    await flush();

    expect(api).toHaveBeenCalledWith("/api/articles/mark-all-read", {
      method: "POST",
      body: { scope: { type: "feed", id: 3 } },
    });
    // markAllRead 完成后列表按当前过滤重载
    const queries = articleQueries();
    expect(queries.length).toBe(queriesBefore + 1);
    expect(queries[queries.length - 1]!.feed_id).toBe(3);
  });

  it("日期分组头 sticky 偏移 top-9,钉在 36px 工具栏之下", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const articles = useArticlesStore();
    await articles.setFilter("all", null, null);
    const container = await mountList(pinia);

    const header = [...container.querySelectorAll(".sticky")].find((el) => el.textContent?.includes("更早"));
    expect(header).toBeTruthy();
    expect(header!.classList.contains("top-9")).toBe(true);
    expect(header!.classList.contains("top-0")).toBe(false);
  });

  it("「只看未读」开关写入偏好并重载列表", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const articles = useArticlesStore();
    await articles.setFilter("all", null, null);
    const container = await mountList(pinia);

    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("只看未读"));
    expect(btn).toBeTruthy();
    btn!.click();
    await flush();

    const last = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/articles").at(-1)!;
    expect((last[1]!.query as Record<string, unknown>).unread).toBe(1);
    const { useSettingsStore } = await import("@/stores/settings");
    expect(useSettingsStore().prefs.unreadOnly).toBe(true);
  });

  it("重载失败时偏好保持且无未处理拒绝", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const articles = useArticlesStore();
    await articles.setFilter("all", null, null);
    const container = await mountList(pinia);

    // 挂载成功后列表重载失败
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles") return Promise.reject(new Error("boom"));
      return Promise.resolve(null);
    });
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("只看未读"))!;
    btn.click();
    await flush();

    const { useSettingsStore } = await import("@/stores/settings");
    expect(useSettingsStore().prefs.unreadOnly).toBe(true);
  });
});
