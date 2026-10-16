// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type App } from "vue";
import type { Feed } from "@readly/shared";
import { api, ApiError } from "@/api/client";
import FeedUrlEditor from "@/components/FeedUrlEditor.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const FEED: Feed = {
  id: 3,
  url: "https://old.example.com/rss",
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

// 宿主包装:v-else 让 close 后组件真实卸载(与 Sidebar 用法一致),data-closed 观察 emit
const Host = defineComponent({
  components: { FeedUrlEditor },
  data: () => ({ feed: FEED, closed: false }),
  template: '<div><span v-if="closed" data-closed /><FeedUrlEditor v-else :feed="feed" @close="closed = true" /></div>',
});

let app: App | null = null;
let host: HTMLElement | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
}

function mockApi(overrides?: (path: string, opts?: { method?: string; body?: unknown }) => unknown): void {
  vi.mocked(api).mockImplementation((path, opts) => {
    const o = overrides?.(path, opts);
    if (o !== undefined) return o as Promise<unknown>;
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([{ ...FEED, url: "https://new.example.com/rss" }]);
    if (path === "/api/stats") return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(api).mockReset();
  mockApi();
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(Host);
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

describe("FeedUrlEditor", () => {
  it("预填当前网址;未修改时保存禁用,修改后启用", async () => {
    const input = host!.querySelector<HTMLInputElement>("[data-feed-url]")!;
    expect(input.value).toBe(FEED.url);
    const saveBtn = host!.querySelector<HTMLButtonElement>("[data-feed-url-save]")!;
    expect(saveBtn.disabled).toBe(true);
    await typeInto(input, "https://new.example.com/rss");
    expect(saveBtn.disabled).toBe(false);
  });

  it("保存成功:PATCH { url } → emit close(组件卸载),不留错误行", async () => {
    const input = host!.querySelector<HTMLInputElement>("[data-feed-url]")!;
    await typeInto(input, "https://new.example.com/rss");
    host!.querySelector<HTMLButtonElement>("[data-feed-url-save]")!.click();
    await flush();
    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(host!.querySelector("[data-feed-url]")).toBeNull();
    expect(host!.querySelector("[data-closed]")).not.toBeNull();
  });

  it("保存失败:错误消息就地展示、弹窗保持打开、不 emit close", async () => {
    mockApi((path, opts) => {
      if (path === "/api/feeds/3" && opts?.method === "PATCH") return Promise.reject(new ApiError("fetch_failed", "抓取失败(HTTP 404)", 502));
      return undefined;
    });
    const input = host!.querySelector<HTMLInputElement>("[data-feed-url]")!;
    await typeInto(input, "https://dead.example.com/rss");
    host!.querySelector<HTMLButtonElement>("[data-feed-url-save]")!.click();
    await flush();
    expect(host!.querySelector("[data-feed-url-error]")!.textContent).toContain("抓取失败(HTTP 404)");
    expect(host!.querySelector("[data-feed-url]")).not.toBeNull(); // 弹窗还在
    expect(host!.querySelector("[data-closed]")).toBeNull();
  });

  it("点击遮罩关闭:emit close", async () => {
    const overlay = host!.firstElementChild!.firstElementChild as HTMLElement; // Host div > 弹窗根
    (overlay as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(host!.querySelector("[data-closed]")).not.toBeNull();
  });
});
