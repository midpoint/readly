import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { extractFromHtml } from "@/modules/extract";
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

  it("连跳补抓:在途结果被丢弃后,落点文章按自动条件补抓完成", async () => {
    const B_URL = "https://n.example.com/b";
    let resolveProxy!: (v: unknown) => void;
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/articles/2") return Promise.resolve({ ...ARTICLE, id: 2, title: "标题二", url: B_URL });
      if (path === "/api/proxy/html") {
        const url = (opts?.query as { url?: string } | undefined)?.url;
        if (url === ARTICLE.url) return new Promise((resolve) => { resolveProxy = resolve; });
        return Promise.resolve({ html: "<html>…</html>", finalUrl: url, truncated: false });
      }
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    const reader = useReaderStore();
    await reader.open(1); // A 短文自动抓取,代理 promise 在途
    await reader.open(2); // 在途期间连跳到 B(B 的自动抓取被全局限流挡住)
    expect(reader.article?.id).toBe(2);
    resolveProxy({ html: "<html>…</html>", finalUrl: ARTICLE.url, truncated: false });
    await vi.waitFor(() => expect(reader.article?.contentFull).toBe("<p>完整正文</p>"));
    const proxyUrls = vi.mocked(api).mock.calls
      .filter(([p]) => p === "/api/proxy/html")
      .map(([, o]) => (o?.query as { url: string }).url);
    expect(proxyUrls).toEqual([ARTICLE.url, B_URL]);
  });

  it("在途失败且已切文:不写旧错误,落点文章仍补抓成功", async () => {
    const B_URL = "https://n.example.com/b";
    let rejectProxy!: (e: unknown) => void;
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/articles/2") return Promise.resolve({ ...ARTICLE, id: 2, title: "标题二", url: B_URL });
      if (path === "/api/proxy/html") {
        const url = (opts?.query as { url?: string } | undefined)?.url;
        if (url === ARTICLE.url) return new Promise((_res, rej) => { rejectProxy = rej; });
        return Promise.resolve({ html: "<html>…</html>", finalUrl: url, truncated: false });
      }
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    const reader = useReaderStore();
    await reader.open(1);
    await reader.open(2);
    rejectProxy(new Error("抓取超时"));
    await vi.waitFor(() => expect(reader.article?.contentFull).toBe("<p>完整正文</p>"));
    // 旧文章的失败不得挂到新文章头部
    expect(reader.fullTextError).toBeNull();
  });

  it("代理截断时仍持久化并提示「页面较大,仅提取到部分内容」", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.resolve({ html: "<html>…</html>", finalUrl: ARTICLE.url, truncated: true });
      if (path === "/api/articles/1/fulltext" && opts?.method === "POST") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    const reader = useReaderStore();
    await reader.open(1);
    await vi.waitFor(() => expect(reader.article?.contentFull).toBe("<p>完整正文</p>"));
    expect(reader.fullTextNote).toBe("页面较大,仅提取到部分内容");
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/articles/1/fulltext", expect.objectContaining({ method: "POST" }));
  });

  it("绝对化基准取重定向后的终址(res.finalUrl)", async () => {
    const FINAL_URL = "https://redirect.example.com/final";
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.resolve({ html: "<html>…</html>", finalUrl: FINAL_URL, truncated: false });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    const reader = useReaderStore();
    await reader.open(1);
    await vi.waitFor(() => expect(reader.article?.contentFull).toBe("<p>完整正文</p>"));
    expect(vi.mocked(extractFromHtml)).toHaveBeenCalledWith("<html>…</html>", FINAL_URL);
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
