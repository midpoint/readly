<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LocationQueryRaw } from "vue-router";
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

// 标已读时间档(发布日期早于 N 天的未读文章);菜单交互随侧栏 ⋯ 菜单同款
const MARK_AGE_OPTIONS = [
  { days: 3, label: "3 天以上标已读" },
  { days: 7, label: "1 周以上标已读" },
  { days: 30, label: "1 月以上标已读" },
  { days: 365, label: "1 年以上标已读" },
] as const;
const markMenuOpen = ref(false);

async function markAllAsRead(olderThanDays?: number): Promise<void> {
  if (markingAllRead.value) return;
  markingAllRead.value = true;
  markMenuOpen.value = false;
  try {
    const scope: { type: "all" | "feed" | "category"; id?: number } =
      articles.feedId !== null
        ? { type: "feed", id: articles.feedId }
        : articles.categoryId !== null
          ? { type: "category", id: articles.categoryId }
          : { type: "all" };
    await feedsStore.markAllRead(scope, olderThanDays);
    await articles.load(true);
  } catch {
    // 失败静默:侧栏计数与列表保持原状,可重试
  } finally {
    markingAllRead.value = false;
  }
}

function onDocumentClick(): void {
  if (markMenuOpen.value) markMenuOpen.value = false;
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && markMenuOpen.value) markMenuOpen.value = false;
}

async function toggleUnreadOnly(): Promise<void> {
  settings.updatePrefs({ unreadOnly: !settings.prefs.unreadOnly });
  try {
    await articles.load(true);
  } catch {
    // 静默:偏好已生效,列表可下次刷新恢复
  }
}

let observer: IntersectionObserver | null = null;

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void articles.loadMore().catch(() => undefined);
  });
  const sentinel = document.getElementById("list-sentinel");
  if (sentinel) observer.observe(sentinel);
});

onUnmounted(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
  observer?.disconnect();
});

// 与 Inbox.setArticleParam 同款:replace 被并发导航打断时下一拍重试一次
function replaceQuery(query: LocationQueryRaw): void {
  void router.replace({ query }).catch(() => {
    window.setTimeout(() => {
      void router.replace({ query }).catch(() => undefined);
    }, 0);
  });
}

async function select(id: number) {
  try {
    await reader.open(id);
  } catch {
    return;
  }
  // store → URL:点击打开也要同步 ?a=,与 Inbox 的键盘路径一致(相同则 no-op,不回环)
  if (route.query.a !== String(id)) replaceQuery({ ...route.query, a: String(id) });
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
      <span class="truncate font-medium text-neutral-500" :title="scopeLabel">{{ scopeLabel }}</span>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="shrink-0 rounded-md px-2 py-1 font-medium hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
          :class="settings.prefs.unreadOnly ? 'text-[var(--accent)]' : 'text-neutral-500'"
          :title="settings.prefs.unreadOnly ? '显示全部文章' : '只显示未读'"
          @click="toggleUnreadOnly"
        >
          只看未读
        </button>
        <button
          data-layout-toggle
          class="shrink-0 rounded-md px-2 py-1 font-medium text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
          :title="settings.prefs.articleLayout === 'list' ? '切换为卡片布局' : '切换为列表布局'"
          @click="settings.updatePrefs({ articleLayout: settings.prefs.articleLayout === 'list' ? 'card' : 'list' })"
        >
          {{ settings.prefs.articleLayout === "list" ? "卡片" : "列表" }}
        </button>
        <div class="relative flex shrink-0 items-center">
          <button
            class="rounded-md px-2 py-1 font-medium text-neutral-500 hover:bg-neutral-200/60 disabled:opacity-50 dark:hover:bg-neutral-800"
            :disabled="markingAllRead"
            @click="markAllAsRead()"
          >
            全部标已读
          </button>
          <button
            data-mark-age-toggle
            class="rounded-md px-1 py-1 font-medium text-neutral-400 hover:bg-neutral-200/60 disabled:opacity-50 dark:hover:bg-neutral-800"
            :disabled="markingAllRead"
            aria-label="更多标已读范围"
            :aria-expanded="markMenuOpen"
            @click.stop="markMenuOpen = !markMenuOpen"
          >
            ▾
          </button>
          <div
            v-if="markMenuOpen"
            data-mark-age-menu
            class="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            @click.stop
          >
            <button
              v-for="opt in MARK_AGE_OPTIONS"
              :key="opt.days"
              :data-mark-age="opt.days"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              :disabled="markingAllRead"
              @click="markAllAsRead(opt.days)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
      </div>
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
    <div v-if="articles.items.length === 0 && !articles.loading" class="p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
      这里还没有文章
    </div>
    <div id="list-sentinel" class="h-8" />
    <div v-if="articles.loading" class="pb-4 text-center text-xs text-neutral-400">加载中…</div>
  </div>
</template>
