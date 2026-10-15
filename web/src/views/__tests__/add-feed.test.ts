import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { useArticlesStore } from "@/stores/articles";
import AddFeed from "@/views/AddFeed.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>订阅列表</title></head>
  <body>
    <outline text="科技">
      <outline type="rss" text="少数派" title="少数派" xmlUrl="https://sspai.com/feed" htmlUrl="https://sspai.com"/>
    </outline>
    <outline text="独立源" type="rss" xmlUrl="https://blog.example.com/atom.xml" title="独立博客"/>
  </body>
</opml>`;

let mounted: { app: App; container: HTMLElement } | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path, opts) => {
    if (path === "/api/categories" && opts?.method === "POST")
      return Promise.resolve({ id: 1, name: "科技", sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    if (path === "/api/feeds" && opts?.method === "POST") return Promise.resolve({ created: [{ id: 1 }], failed: [] });
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    return Promise.resolve({});
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
});

async function mountAddFeed(): Promise<HTMLElement> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>inbox</div>" } },
      { path: "/add", component: AddFeed },
    ],
  });
  await router.push("/add");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(AddFeed);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return container;
}

describe("AddFeed OPML 导入", () => {
  it("导入成功后标记列表失效(与加源订阅同款),并给出导入结果", async () => {
    const container = await mountAddFeed(); // 内部 setActivePinia,之后才可用 store
    const articles = useArticlesStore();
    expect(articles.stale).toBe(false);

    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("OPML 导入/导出"))!.click();
    await nextTick();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    // jsdom 未实现 Blob.prototype.text();按组件消费面桩最小 File(text() 返回 OPML 文本)
    const file = { name: "readly.opml", text: async () => OPML } as unknown as File;
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();

    // 1 分类(1 源)+ 1 未分类源
    expect(container.textContent).toContain("导入完成:成功 2 个源");
    expect(useArticlesStore().stale).toBe(true);
  });
});
