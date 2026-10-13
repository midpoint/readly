import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleListItem } from "@readly/shared";
import { api } from "@/api/client";
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

async function mountInbox(initialPath: string): Promise<{ router: Router; container: HTMLElement }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: Inbox }],
  });
  await router.push(initialPath);
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Inbox);
  app.use(createPinia());
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
