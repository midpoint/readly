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

async function mountWith(article: Record<string, unknown>): Promise<HTMLElement> {
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/articles/1") return Promise.resolve({ ...BASE, ...article });
    return Promise.resolve({});
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.initLocal();
  settings.updateFetchPrefs({ auto: false });
  app = createApp(ReaderPane);
  app.use(pinia);
  setActivePinia(pinia);
  app.mount(host!);
  await useReaderStore().open(1);
  await nextTick();
  return host!;
}

function bodyOf(el: HTMLElement): HTMLElement {
  const body = el.querySelector<HTMLElement>(".reader-body");
  expect(body).not.toBeNull();
  return body!;
}

describe("ReaderPane 中文版式判定", () => {
  it("中文文章:reader-body 带 reader-zh", async () => {
    const el = await mountWith({});
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(true);
  });

  it("英文文章:不带 reader-zh", async () => {
    const el = await mountWith({
      title: "Hello",
      content: "<p>This is an English article about RSS readers and typography.</p>",
      excerpt: "English excerpt",
    });
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(false);
  });

  it("无文本内容:不带 reader-zh", async () => {
    const el = await mountWith({ title: "123", content: null, contentFull: null, excerpt: null });
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(false);
  });

  it("有全文时默认显示全文并按其判定;切回摘要后重判", async () => {
    const el = await mountWith({
      content: "<p>中文摘要正文</p>",
      contentFull: "<p>This full text is written entirely in English.</p>",
      hasFullText: true,
    });
    // 默认显示全文(英文)→ 不带类
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(false);
    // 切回摘要(中文)→ 重判为中文
    el.querySelector<HTMLButtonElement>("[data-toggle-original]")!.click();
    await nextTick();
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(true);
  });

  it("渲染集成:纯图片段带 data-img-only,文字段内单图不带", async () => {
    const el = await mountWith({
      content: '<p><img src="https://a.example.com/x.png"></p><p>文字 <img src="https://a.example.com/y.png"></p>',
    });
    const marked = el.querySelectorAll(".reader-body p[data-img-only]");
    expect(marked).toHaveLength(1);
  });
});
