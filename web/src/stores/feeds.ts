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

  async function markAllRead(scope: { type: "all" | "feed" | "category"; id?: number }): Promise<number> {
    const res = await api<{ updated: number }>("/api/articles/mark-all-read", { method: "POST", body: { scope } });
    await load();
    return res.updated;
  }

  return { categories, feeds, stats, loading, load, addFeeds, discover, createCategory, moveFeed, removeFeed, markAllRead };
});
