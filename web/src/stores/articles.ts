import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ArticleListItem, ArticleView, ArticlesPage } from "@readly/shared";
import { api } from "@/api/client";
import { useFeedsStore } from "./feeds";

interface StatePatch {
  isRead?: boolean;
  isStarred?: boolean;
  isLater?: boolean;
}

const STATS_REFRESH_DEBOUNCE_MS = 800;
let statsTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStatsRefresh(): void {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    statsTimer = null;
    void useFeedsStore().refreshStats().catch(() => undefined);
  }, STATS_REFRESH_DEBOUNCE_MS);
}

export const useArticlesStore = defineStore("articles", () => {
  const items = ref<ArticleListItem[]>([]);
  const cursor = ref<string | null>(null);
  const hasMore = ref(true);
  const loading = ref(false);
  // 是否曾成功加载过:冷启动(URL 无参)时也需触发首次拉取,由 Inbox 的守卫消费
  const loaded = ref(false);
  const view = ref<ArticleView>("all");
  const feedId = ref<number | null>(null);
  const categoryId = ref<number | null>(null);
  const currentId = ref<number | null>(null);

  const current = computed(() => items.value.find((i) => i.id === currentId.value) ?? null);

  // 加载中收到 reset(切换过滤条件)时不能丢弃,排队待当前请求结束后以最新条件补跑
  let pendingReset = false;

  async function fetchPage(reset: boolean): Promise<void> {
    if (loading.value) {
      if (reset) pendingReset = true;
      return;
    }
    loading.value = true;
    try {
      const page = await api<ArticlesPage>("/api/articles", {
        query: {
          view: view.value,
          feed_id: feedId.value ?? undefined,
          category_id: categoryId.value ?? undefined,
          cursor: reset ? undefined : (cursor.value ?? undefined),
          limit: 30,
        },
      });
      if (reset) items.value = page.items;
      else {
        const seen = new Set(items.value.map((i) => i.id));
        items.value = [...items.value, ...page.items.filter((i) => !seen.has(i.id))];
      }
      cursor.value = page.nextCursor;
      hasMore.value = page.nextCursor !== null;
      loaded.value = true;
    } finally {
      loading.value = false;
      if (pendingReset) {
        pendingReset = false;
        void fetchPage(true).catch(() => undefined);
      }
    }
  }

  async function load(reset = true): Promise<void> {
    await fetchPage(reset);
  }

  async function loadMore(): Promise<void> {
    if (items.value.length === 0) return;
    if (!hasMore.value || loading.value) return;
    await fetchPage(false);
  }

  async function setFilter(v: ArticleView, f: number | null, c: number | null): Promise<void> {
    view.value = v;
    feedId.value = f;
    categoryId.value = c;
    currentId.value = null;
    await load(true);
  }

  async function setState(id: number, patch: StatePatch): Promise<void> {
    const before = items.value.map((i) => ({ ...i }));
    const target = items.value.find((i) => i.id === id);
    if (target) Object.assign(target, patch);
    try {
      await api(`/api/articles/${id}`, { method: "PATCH", body: patch });
      if (patch.isRead === true && view.value === "unread") {
        items.value = items.value.filter((i) => i.id !== id);
      }
      if (patch.isStarred === false && view.value === "starred") {
        items.value = items.value.filter((i) => i.id !== id);
      }
      if (patch.isLater === false && view.value === "later") {
        items.value = items.value.filter((i) => i.id !== id);
      }
      scheduleStatsRefresh();
    } catch (e) {
      items.value = before;
      throw e;
    }
  }

  function patchItemLocally(id: number, patch: StatePatch): void {
    const target = items.value.find((i) => i.id === id);
    if (target) Object.assign(target, patch);
  }

  return {
    items,
    loading,
    hasMore,
    loaded,
    view,
    feedId,
    categoryId,
    currentId,
    current,
    load,
    loadMore,
    setFilter,
    setState,
    patchItemLocally,
  };
});
