import { defineStore } from "pinia";
import { ref } from "vue";
import type { Category, Feed, Stats } from "@readly/shared";
import { api } from "@/api/client";

export const useFeedsStore = defineStore("feeds", () => {
  const categories = ref<Category[]>([]);
  const feeds = ref<Feed[]>([]);
  const stats = ref<Stats | null>(null);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [cats, fs, st] = await Promise.all([
        api<Category[]>("/api/categories"),
        api<Feed[]>("/api/feeds"),
        api<Stats>("/api/stats"),
      ]);
      categories.value = cats;
      feeds.value = fs;
      stats.value = st;
    } finally {
      loading.value = false;
    }
  }

  async function addFeeds(urls: string[], categoryId: number | null): Promise<{ created: number; failed: { url: string; error: string }[] }> {
    const createdAll: { id: number }[] = [];
    const failedAll: { url: string; error: string }[] = [];
    try {
      for (let i = 0; i < urls.length; i += 100) {
        const slice = urls.slice(i, i + 100);
        const res = await api<{ created: { id: number }[]; failed: { url: string; error: string }[] }>("/api/feeds", {
          method: "POST",
          body: { urls: slice, categoryId },
        });
        createdAll.push(...res.created);
        failedAll.push(...res.failed);
      }
      return { created: createdAll.length, failed: failedAll };
    } finally {
      // 中途分片失败时已入库的源也要能回显;load 失败照常向上抛,由调用方展示
      await load();
    }
  }

  async function discover(url: string): Promise<{ url: string; title: string; type: string }[]> {
    return api("/api/feeds/discover", { method: "POST", body: { url } });
  }

  async function createCategory(name: string): Promise<Category> {
    const cat = await api<Category>("/api/categories", { method: "POST", body: { name } });
    await load();
    return cat;
  }

  async function moveFeed(feedId: number, categoryId: number | null): Promise<void> {
    await api(`/api/feeds/${feedId}`, { method: "PATCH", body: { categoryId } });
    await load();
  }

  async function removeFeed(feedId: number): Promise<void> {
    await api(`/api/feeds/${feedId}`, { method: "DELETE" });
    await load();
  }

  async function markAllRead(scope: { type: "all" | "feed" | "category"; id?: number }, olderThanDays?: number): Promise<number> {
    // 契约:无时间档时请求体与既往逐字节一致(既有精确体测试守护)
    const res = await api<{ updated: number }>("/api/articles/mark-all-read", {
      method: "POST",
      body: olderThanDays === undefined ? { scope } : { scope, olderThanDays },
    });
    await load();
    return res.updated;
  }

  async function renameFeed(feedId: number, title: string): Promise<void> {
    await api(`/api/feeds/${feedId}`, { method: "PATCH", body: { title } });
    await load();
  }

  // 改址:保存即抓取校验由服务端完成;失败(ApiError)向上抛,由弹窗就地展示且不重载
  async function editFeedUrl(feedId: number, url: string): Promise<void> {
    await api(`/api/feeds/${feedId}`, { method: "PATCH", body: { url } });
    await load();
  }

  // 服务端分批刷新,循环调用直至 done;100 次上限兜底防死循环
  async function refreshAll(): Promise<{ processed: number }> {
    let processed = 0;
    for (let i = 0; i < 100; i++) {
      const r = await api<{ done: boolean; processed: number; remaining: number }>("/api/refresh", { method: "POST" });
      processed += r.processed;
      if (r.done) return { processed };
    }
    return { processed };
  }

  // 轻量刷新:仅更新侧栏计数,不重拉分类/订阅(阅读标已读后调用)。
  // 源级徽标由 feeds[].unreadCount 承载(来源 /api/feeds),而阅读路径不重拉订阅列表,
  // 故在此用 perFeed 就地同步,避免每次标已读都全量请求 /api/feeds(缺席的源即 0 未读)。
  async function refreshStats(): Promise<void> {
    const s = await api<Stats>("/api/stats");
    stats.value = s;
    feeds.value = feeds.value.map((f) => ({ ...f, unreadCount: s.perFeed[f.id] ?? 0 }));
  }

  return { categories, feeds, stats, loading, load, addFeeds, discover, createCategory, moveFeed, removeFeed, markAllRead, renameFeed, editFeedUrl, refreshAll, refreshStats };
});
