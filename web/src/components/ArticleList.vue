<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { groupArticlesByDate } from "@/modules/date";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import ArticleListItem from "./ArticleListItem.vue";
import DateGroupHeader from "./DateGroupHeader.vue";

const route = useRoute();
const router = useRouter();
const articles = useArticlesStore();
const feedsStore = useFeedsStore();
const reader = useReaderStore();
const settings = useSettingsStore();

const groups = computed(() => groupArticlesByDate(articles.items));

// 当前列表范围文案:源标题 → 分类名 → 全部文章
const scopeLabel = computed(() => {
  if (articles.feedId !== null) {
    return feedsStore.feeds.find((f) => f.id === articles.feedId)?.title ?? "订阅源";
  }
  if (articles.categoryId !== null) {
    return feedsStore.categories.find((c) => c.id === articles.categoryId)?.name ?? "分类";
  }
  return "全部文章";
});

const markingAllRead = ref(false);

async function markAllAsRead(): Promise<void> {
  if (markingAllRead.value) return;
  markingAllRead.value = true;
  try {
    const scope: { type: "all" | "feed" | "category"; id?: number } =
      articles.feedId !== null
        ? { type: "feed", id: articles.feedId }
        : articles.categoryId !== null
          ? { type: "category", id: articles.categoryId }
          : { type: "all" };
    await feedsStore.markAllRead(scope);
    await articles.load(true);
  } catch {
    // 失败静默:侧栏计数与列表保持原状,可重试
  } finally {
    markingAllRead.value = false;
  }
}

let observer: IntersectionObserver | null = null;

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void articles.loadMore();
  });
  const sentinel = document.getElementById("list-sentinel");
  if (sentinel) observer.observe(sentinel);
});

onUnmounted(() => observer?.disconnect());

async function select(id: number) {
  try {
    await reader.open(id);
  } catch {
    return;
  }
  // store → URL:点击打开也要同步 ?a=,与 Inbox 的键盘路径一致(相同则 no-op,不回环)
  if (route.query.a !== String(id)) void router.replace({ query: { ...route.query, a: String(id) } });
  const item = articles.items.find((i) => i.id === id);
  if (settings.prefs.autoMarkReadOnOpen && item && !item.isRead)
    void articles.setState(id, { isRead: true }).catch(() => undefined);
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div
      class="sticky top-0 z-20 flex h-9 items-center justify-between gap-2 border-b border-neutral-200/70 bg-neutral-50/90 px-4 text-xs backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-950/90"
    >
      <span class="truncate font-medium text-neutral-500">{{ scopeLabel }}</span>
      <button
        class="shrink-0 rounded-md px-2 py-1 font-medium text-neutral-500 hover:bg-neutral-200/60 disabled:opacity-50 dark:hover:bg-neutral-800"
        :disabled="markingAllRead"
        @click="markAllAsRead"
      >
        全部标已读
      </button>
    </div>
    <template v-for="group in groups" :key="group.label">
      <DateGroupHeader :label="group.label" />
      <ArticleListItem
        v-for="item in group.items"
        :key="item.id"
        :item="item"
        :active="item.id === articles.currentId"
        @select="select"
      />
    </template>
    <div v-if="articles.items.length === 0 && !articles.loading" class="p-10 text-center text-sm text-neutral-500">
      这里还没有文章
    </div>
    <div id="list-sentinel" class="h-8" />
    <div v-if="articles.loading" class="pb-4 text-center text-xs text-neutral-400">加载中…</div>
  </div>
</template>
