import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feed } from "@readly/shared";
import { api } from "@/api/client";
import { useFeedsStore } from "@/stores/feeds";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const FEED: Feed = {
  id: 3,
  url: "https://a.example.com/rss",
  siteUrl: null,
  title: "旧标题",
  description: null,
  iconUrl: null,
  categoryId: null,
  sortOrder: 0,
  lastFetchedAt: null,
  errorCount: 0,
  lastError: null,
  unreadCount: 0,
  createdAt: "2025-10-13T00:00:00.000Z",
};

const EMPTY_STATS = { unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} };

describe("feeds store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(api).mockReset();
  });

  it("addFeeds 返回成功与失败明细", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/feeds" && opts?.method === "POST") {
        return Promise.resolve({ created: [{ id: 1 }], failed: [{ url: "x", error: "bad" }] });
      }
      if (path === "/api/feeds") return Promise.resolve([]);
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/stats") return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      return Promise.resolve([]);
    });
    const store = useFeedsStore();
    const r = await store.addFeeds(["https://a.example.com/rss"], null);
    expect(r.created).toBe(1);
    expect(r.failed).toHaveLength(1);
  });

  it("discover 透传候选", async () => {
    vi.mocked(api).mockResolvedValue([{ url: "https://a.example.com/feed", title: "A", type: "application/rss+xml" }]);
    const store = useFeedsStore();
    const out = await store.discover("https://a.example.com/");
    expect(out[0]!.url).toBe("https://a.example.com/feed");
    expect(api).toHaveBeenCalledWith("/api/feeds/discover", { method: "POST", body: { url: "https://a.example.com/" } });
  });

  it("addFeeds 超过 100 个自动分片", async () => {
    const calls: { urls: string[] }[] = [];
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/feeds" && opts?.method === "POST") {
        const body = opts.body as { urls: string[] };
        calls.push(body);
        return Promise.resolve({ created: body.urls.map((_, i) => ({ id: i })), failed: [] });
      }
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/feeds") return Promise.resolve([]);
      if (path === "/api/stats") return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      return Promise.resolve([]);
    });
    const store = useFeedsStore();
    const urls = Array.from({ length: 150 }, (_, i) => `https://f${i}.example.com/rss`);
    const r = await store.addFeeds(urls, null);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.urls).toHaveLength(100);
    expect(calls[1]!.urls).toHaveLength(50);
    expect(r.created).toBe(150);
  });

  it("renameFeed 调 PATCH 并重载", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/feeds/3" && opts?.method === "PATCH") return Promise.resolve(null);
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/feeds") return Promise.resolve([{ ...FEED, title: "新标题" }]);
      if (path === "/api/stats") return Promise.resolve(EMPTY_STATS);
      return Promise.resolve([]);
    });
    const store = useFeedsStore();
    await store.renameFeed(FEED.id, "新标题");
    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { title: "新标题" } });
    // 重载:列表数据来自服务端(load 之后的 feeds 为新标题)
    expect(store.feeds[0]?.title).toBe("新标题");
    expect(vi.mocked(api).mock.calls.map(([p]) => p)).toEqual(
      expect.arrayContaining(["/api/categories", "/api/feeds", "/api/stats"])
    );
  });

  it("refreshAll 循环直至 done", async () => {
    const responses = [
      { done: false, processed: 2, remaining: 1 },
      { done: true, processed: 1, remaining: 0 },
    ];
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/refresh") {
        return Promise.resolve(responses.shift() ?? { done: true, processed: 0, remaining: 0 });
      }
      return Promise.resolve([]);
    });
    const store = useFeedsStore();
    const r = await store.refreshAll();
    expect(r.processed).toBe(3);
    expect(vi.mocked(api).mock.calls.filter(([p]) => p === "/api/refresh")).toHaveLength(2);
  });
});
