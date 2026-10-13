// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { api } from "@/api/client";
import ReaderPane from "@/components/ReaderPane.vue";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/modules/extract", () => ({
  extractFromHtml: vi.fn(() => ({ title: "T", html: "<p>完整正文</p>", textLength: 4 })),
  plainTextLength: vi.fn(() => 9999),
}));

const BASE = {
  id: 1, feedId: 1, feedTitle: "F", feedIconUrl: null, title: "标题", url: "https://n.example.com/a",
  author: null, publishedAt: "2026-01-01T00:00:00.000Z", excerpt: "短摘要", imageUrl: null,
  isRead: true, isStarred: false, isLater: false, hasFullText: false,
  content: "<p>订阅摘要正文</p>", contentFull: null, aiSummary: null, aiTranslation: null, extractedAt: null,
};

let app: App | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

async function mountWith(article: Record<string, unknown>) {
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/articles/1") return Promise.resolve({ ...BASE, ...article });
    if (path === "/api/proxy/html") return Promise.resolve({ html: "<html/>", finalUrl: BASE.url, truncated: false });
    return Promise.resolve({});
  });
  const settings = useSettingsStore();
  settings.initLocal();
  settings.updateFetchPrefs({ auto: false });
  app = createApp(ReaderPane);
  app.use(createPinia());
  app.mount(host!);
  const reader = useReaderStore();
  await reader.open(1);
  await nextTick();
}

describe("ReaderPane 全文 UI", () => {
  it("已有全文:默认显示全文+来源条,切「显示摘要」回摘要", async () => {
    await mountWith({ contentFull: "<p>抓取后的完整正文</p>", hasFullText: true });
    expect(host!.textContent).toContain("抓取后的完整正文");
    expect(host!.querySelector("[data-fulltext-source]")).not.toBeNull();
    host!.querySelector<HTMLButtonElement>("[data-toggle-original]")!.click();
    await nextTick();
    expect(host!.textContent).toContain("订阅摘要正文");
    expect(host!.textContent).not.toContain("抓取后的完整正文");
  });

  it("无全文:点「抓取全文」调 store,失败显示中文错误", async () => {
    await mountWith({});
    const btn = host!.querySelector<HTMLButtonElement>("[data-fetch-fulltext]")!;
    btn.click();
    await vi.waitFor(() => expect(host!.textContent).toContain("完整正文"));
    // 失败路径
    await mountWith({});
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...BASE });
      if (path === "/api/proxy/html") return Promise.reject(new Error("抓取超时"));
      return Promise.resolve({});
    });
    host!.querySelector<HTMLButtonElement>("[data-fetch-fulltext]")!.click();
    await vi.waitFor(() => expect(host!.textContent).toContain("抓取超时"));
  });
});
