import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
