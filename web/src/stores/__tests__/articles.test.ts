import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/api/client";
import { useArticlesStore } from "@/stores/articles";
import type { ArticleListItem } from "@readly/shared";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

function item(id: number): ArticleListItem {
  return {
    id,
    feedId: 1,
    feedTitle: "F",
    feedIconUrl: null,
    title: `t${id}`,
    url: null,
    author: null,
    publishedAt: `2025-10-13T0${id}:00:00.000Z`,
    excerpt: null,
    imageUrl: null,
    isRead: false,
    isStarred: false,
    isLater: false,
    hasFullText: false,
  };
}

describe("articles store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(api).mockReset();
    // 统一伪定时器:setState 成功路径会挂 800ms stats 防抖定时器,
    // 若不接管,残留定时器可能在后续用例中触发并消费 mockResolvedValueOnce 队列
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("load 重置列表并记录游标", async () => {
    vi.mocked(api).mockResolvedValue({ items: [item(2), item(1)], nextCursor: "c1" });
    const store = useArticlesStore();
    await store.load(true);
    expect(store.items.map((i) => i.id)).toEqual([2, 1]);
    expect(store.hasMore).toBe(true);
    expect(api).toHaveBeenCalledWith("/api/articles", expect.objectContaining({ query: expect.objectContaining({ view: "all" }) }));
  });

  it("loadMore 追加并去重", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ items: [item(3), item(2)], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [item(2), item(1)], nextCursor: null });
    const store = useArticlesStore();
    await store.load(true);
    await store.loadMore();
    expect(store.items.map((i) => i.id)).toEqual([3, 2, 1]);
    expect(store.hasMore).toBe(false);
  });

  it("setState 乐观更新,失败回滚", async () => {
    vi.mocked(api).mockResolvedValueOnce({ items: [item(1)], nextCursor: null });
    const store = useArticlesStore();
    await store.load(true);
    vi.mocked(api).mockRejectedValueOnce(new ApiError("x", "boom", 500));
    await expect(store.setState(1, { isRead: true })).rejects.toBeInstanceOf(ApiError);
    expect(store.items[0]!.isRead).toBe(false);
    vi.mocked(api).mockResolvedValueOnce({ isRead: true, isStarred: false, isLater: false });
    await store.setState(1, { isRead: true });
    expect(store.items[0]!.isRead).toBe(true);
  });

  it("unread 视图下标记已读会从列表移除", async () => {
    vi.mocked(api).mockResolvedValueOnce({ items: [item(1)], nextCursor: null });
    const store = useArticlesStore();
    store.view = "unread";
    await store.load(true);
    vi.mocked(api).mockResolvedValueOnce({ isRead: true, isStarred: false, isLater: false });
    await store.setState(1, { isRead: true });
    expect(store.items).toHaveLength(0);
  });

  it("空列表时 loadMore 不发请求", async () => {
    const store = useArticlesStore();
    await store.loadMore();
    expect(api).not.toHaveBeenCalled();
  });

  it("加载中发出的 setFilter 会在当前请求完成后以新过滤重放", async () => {
    let resolveFirst!: (page: { items: ArticleListItem[]; nextCursor: string | null }) => void;
    const first = new Promise<{ items: ArticleListItem[]; nextCursor: string | null }>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(api).mockReturnValueOnce(first);
    vi.mocked(api).mockResolvedValueOnce({ items: [item(9)], nextCursor: null });
    const store = useArticlesStore();
    const inFlight = store.setFilter("unread", null, null);
    await store.setFilter("starred", null, null);
    resolveFirst({ items: [item(5)], nextCursor: "c1" });
    await inFlight;
    // 伪定时器下排空宏/微任务队列(等价原 setTimeout(r, 0) 的真实排空)
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenLastCalledWith(
      "/api/articles",
      expect.objectContaining({ query: expect.objectContaining({ view: "starred" }) })
    );
    expect(store.items.map((i) => i.id)).toEqual([9]);
  });

  it("setState 成功后防抖刷新 stats,连续变更只刷一次", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api).mockImplementation((path, opts) => {
        if (path === "/api/articles" && !opts?.method) return Promise.resolve({ items: [item(1)], nextCursor: null });
        if (path === "/api/articles/1") return Promise.resolve({ isRead: true, isStarred: false, isLater: false });
        if (path === "/api/stats") return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
        return Promise.resolve({});
      });
      const store = useArticlesStore();
      await store.load(true);
      const before = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/stats").length;
      await store.setState(1, { isRead: true });
      await store.setState(1, { isStarred: true });
      await vi.advanceTimersByTimeAsync(900);
      const after = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/stats").length;
      expect(after - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unreadOnly 开启时列表与分页请求携带 unread=1", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles") {
        const q = opts?.query as Record<string, unknown>;
        expect(q.unread).toBe(1);
        return Promise.resolve({ items: [item(1)], nextCursor: "c1" });
      }
      return Promise.resolve({});
    });
    const { useSettingsStore } = await import("@/stores/settings");
    useSettingsStore().initLocal();
    useSettingsStore().updatePrefs({ unreadOnly: true });
    const store = useArticlesStore();
    await store.load(true);
    vi.mocked(api).mockResolvedValueOnce({ items: [item(2)], nextCursor: null });
    await store.loadMore();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    // 第二次分页请求同样携带 unread=1(mockResolvedValueOnce 会压制实现体内的断言,须显式覆盖)
    expect((vi.mocked(api).mock.calls[1]?.[1]?.query as Record<string, unknown>).unread).toBe(1);
  });
});
