import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feed } from "@readly/shared";
import { api } from "@/api/client";
import Sidebar from "@/components/Sidebar.vue";
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
  unreadCount: 2,
  createdAt: "2025-10-13T00:00:00.000Z",
};

let mounted: { app: App; container: HTMLElement } | null = null;

// 真实定时器:宏任务排空微任务链 + 两次 DOM 更新
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

// 伪定时器:每轮 advanceTimersByTimeAsync(0) 推进一轮微任务,循环排干 refreshFeeds 的 await 链
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  await nextTick();
  await nextTick();
}

async function mountSidebar(pinia: Pinia, flushFn: () => Promise<void>): Promise<HTMLElement> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/add", component: { template: "<div />" } },
    ],
  });
  await router.push("/");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Sidebar);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flushFn();
  return container;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([FEED]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 2, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    if (path === "/api/articles") return Promise.resolve({ items: [], nextCursor: null });
    return Promise.resolve(null);
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  vi.useRealTimers();
});

describe("Sidebar 源入口", () => {
  it("「刷新订阅」循环 /api/refresh 直至 done,显示「已刷新」并在 2 秒后还原", async () => {
    vi.useFakeTimers();
    const pinia = createPinia();
    setActivePinia(pinia);
    const responses = [
      { done: false, processed: 2, remaining: 1 },
      { done: true, processed: 1, remaining: 0 },
    ];
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/refresh" && opts?.method === "POST") {
        return Promise.resolve(responses.shift() ?? { done: true, processed: 0, remaining: 0 });
      }
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/feeds") return Promise.resolve([FEED]);
      if (path === "/api/stats")
        return Promise.resolve({ unreadTotal: 2, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      if (path === "/api/articles") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.resolve(null);
    });
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, settle);

    const button = findButton(container, "刷新订阅");
    expect(button).toBeTruthy();
    button!.click();
    await settle();

    // 两次响应的 done 为 false→true,恰好 2 次调用
    expect(vi.mocked(api).mock.calls.filter(([p]) => p === "/api/refresh")).toHaveLength(2);
    // 刷新完成后侧栏与文章列表都重载
    expect(vi.mocked(api).mock.calls.some(([p]) => p === "/api/articles")).toBe(true);
    expect(button!.textContent?.trim()).toBe("已刷新");

    await vi.advanceTimersByTimeAsync(2000);
    await nextTick();
    expect(button!.textContent?.trim()).toBe("刷新订阅");
  });

  it("源行「⋯」菜单重命名:预填标题,Enter 提交 PATCH /api/feeds/:id", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    const menuButton = container.querySelector<HTMLButtonElement>('button[aria-label="源管理菜单"]');
    expect(menuButton).toBeTruthy();
    menuButton!.click();
    await nextTick();
    await nextTick();

    const renameItem = findButton(container, "重命名");
    expect(renameItem).toBeTruthy();
    renameItem!.click();
    await nextTick();
    await nextTick();

    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("示例源"); // 预填当前标题

    (input as HTMLInputElement).value = "新名字";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();

    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { title: "新名字" } });
  });
});
