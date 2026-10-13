import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/modules/extract", () => ({
  extractFromHtml: vi.fn(() => ({ title: "T", html: "<p>完整正文</p>", textLength: 4 })),
  plainTextLength: vi.fn(() => 100),
}));

const ARTICLE = {
  id: 1, feedId: 1, feedTitle: "F", feedIconUrl: null, title: "标题", url: "https://n.example.com/a",
  author: null, publishedAt: "2026-01-01T00:00:00.000Z", excerpt: "短摘要", imageUrl: null,
  isRead: false, isStarred: false, isLater: false, hasFullText: false,
  content: "<p>短</p>", contentFull: null, aiSummary: null, aiTranslation: null, extractedAt: null,
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
});

describe("reader 全文抓取", () => {
  it("自动抓取:短文+auto=true 时 open 后走代理→提取→持久化", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.resolve({ html: "<html>…</html>", finalUrl: ARTICLE.url, truncated: false });
      if (path === "/api/articles/1/fulltext" && opts?.method === "POST") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal(); // 默认 auto=true, minChars=300;plainTextLength mock 返回 100 < 300
    const reader = useReaderStore();
    await reader.open(1);
    await vi.waitFor(() => expect(reader.article?.contentFull).toBe("<p>完整正文</p>"));
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/proxy/html", expect.objectContaining({ query: { url: ARTICLE.url } }));
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/articles/1/fulltext", expect.objectContaining({ method: "POST" }));
    expect(reader.fullTextError).toBeNull();
  });

  it("auto=false 不自动抓取;手动 fetchFullText 仍可用", async () => {
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.resolve({ html: "<html/>", finalUrl: ARTICLE.url, truncated: false });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    settings.updateFetchPrefs({ auto: false });
    const reader = useReaderStore();
    await reader.open(1);
    await Promise.resolve();
    expect(vi.mocked(api).mock.calls.some(([p]) => p === "/api/proxy/html")).toBe(false);
    await reader.fetchFullText();
    expect(reader.article?.contentFull).toBe("<p>完整正文</p>");
  });

  it("抓取失败写入 fullTextError", async () => {
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.reject(new Error("抓取超时"));
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    const reader = useReaderStore();
    await reader.open(1);
    await expect(reader.fetchFullText()).rejects.toThrow("抓取超时");
    expect(reader.fullTextError).toBe("抓取超时");
  });
});
