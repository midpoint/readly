import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { useFeedsStore } from "@/stores/feeds";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

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
});
