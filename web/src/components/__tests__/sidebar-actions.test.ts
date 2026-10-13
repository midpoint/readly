import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feed } from "@readly/shared";
import { api } from "@/api/client";
import Sidebar from "@/components/Sidebar.vue";
import { useFeedsStore } from "@/stores/feeds";
import { useSettingsStore } from "@/stores/settings";

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

// 打开某源行的「⋯」→「重命名」,返回行内输入框
async function openRename(container: HTMLElement): Promise<HTMLInputElement> {
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
  const input = container.querySelector<HTMLInputElement>("input");
  expect(input).toBeTruthy();
  return input!;
}

// 模拟键入:设值 + input 事件 + 等 Vue 重渲染
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
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

    const input = await openRename(container);
    expect(input.value).toBe("示例源"); // 预填当前标题

    await typeInto(input, "新名字");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();

    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { title: "新名字" } });
  });

  it("重命名中按 Esc:取消并收起菜单", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    const input = await openRename(container);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flush();

    expect(container.querySelector("input")).toBeNull();
    expect(findButton(container, "重命名")).toBeUndefined(); // 菜单不复活
    expect(api).not.toHaveBeenCalledWith("/api/feeds/3", expect.objectContaining({ method: "PATCH" }));
  });

  it("刷新成功但重载失败时仍显示「已刷新」而非「刷新失败」", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/refresh" && opts?.method === "POST") return Promise.resolve({ done: true, processed: 1, remaining: 0 });
      if (path === "/api/articles") return Promise.reject(new Error("boom")); // 重载失败
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/feeds") return Promise.resolve([FEED]);
      if (path === "/api/stats")
        return Promise.resolve({ unreadTotal: 2, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      return Promise.resolve(null);
    });
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    const button = findButton(container, "刷新订阅");
    expect(button).toBeTruthy();
    button!.click();
    await flush();

    expect(button!.textContent?.trim()).toBe("已刷新");
  });

  it("重命名输入连续键入不被每次全选(光标留在末尾)", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    const input = await openRename(container);
    expect(document.activeElement).toBe(input); // 打开即聚焦

    await typeInto(input, "新名字");
    await typeInto(input, "新名字啊");

    // 每次键入触发重渲染,若 ref 回调重复 select() 会全选(selectionStart=0)
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
  });

  it("unreadOnly 开启时侧栏隐藏零未读源,关闭后恢复", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/categories") return Promise.resolve([{ id: 1, name: "科技", sortOrder: 0, createdAt: "2025-10-13T00:00:00.000Z" }]);
      if (path === "/api/feeds")
        return Promise.resolve([
          { ...FEED, id: 1, url: "https://a.example.com/rss", title: "有未读", categoryId: 1, unreadCount: 2 },
          { ...FEED, id: 2, url: "https://b.example.com/rss", title: "零未读", categoryId: 1, unreadCount: 0 },
        ]);
      if (path === "/api/stats")
        return Promise.resolve({ unreadTotal: 2, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      if (path === "/api/articles") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.resolve(null);
    });
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    expect(container.textContent).toContain("有未读");
    expect(container.textContent).toContain("零未读");
    useSettingsStore().updatePrefs({ unreadOnly: true });
    await nextTick();
    await nextTick();
    expect(container.textContent).toContain("有未读");
    expect(container.textContent).not.toContain("零未读");
    useSettingsStore().updatePrefs({ unreadOnly: false });
    await nextTick();
    await nextTick();
    expect(container.textContent).toContain("零未读");
  });
});
