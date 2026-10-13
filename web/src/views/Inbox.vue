<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LocationQueryRaw } from "vue-router";
import type { ArticleView } from "@readly/shared";
import ArticleList from "@/components/ArticleList.vue";
import MobileNav from "@/components/MobileNav.vue";
import ReaderPane from "@/components/ReaderPane.vue";
import ShortcutHelp from "@/components/ShortcutHelp.vue";
import Sidebar from "@/components/Sidebar.vue";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

const route = useRoute();
const router = useRouter();
const feedsStore = useFeedsStore();
const articles = useArticlesStore();
const reader = useReaderStore();
const settings = useSettingsStore();
const { showShortcutHelp, toggleShortcutHelp, closeShortcutHelp } = useShortcutHelp();

function numParam(v: unknown): number | null {
  return typeof v === "string" && Number.isInteger(Number(v)) ? Number(v) : null;
}

// URL → store:只在状态确实不同时才变更,守卫覆盖 setFilter 与 open/close 两条路径,
// 使 Sidebar 的「replace + setFilter」双写与本次 replace 都不会形成回环。
async function applyRouteQuery(): Promise<void> {
  const viewParam = typeof route.query.view === "string" ? route.query.view : "all";
  const view: ArticleView = (["all", "unread", "starred", "later"] as const).includes(viewParam as ArticleView)
    ? (viewParam as ArticleView)
    : "all";
  const feedId = numParam(route.query.feed);
  const categoryId = numParam(route.query.category);
  const filterChanged =
    view !== articles.view || feedId !== articles.feedId || categoryId !== articles.categoryId;
  // 冷启动(URL 无参 == store 默认值)也必须触发首次拉取,故叠加「未加载过」条件
  if (filterChanged || !articles.loaded) {
    await articles.setFilter(view, feedId, categoryId);
  }
  const articleId = numParam(route.query.a);
  if (articleId !== null) {
    if (articleId !== reader.article?.id) void reader.open(articleId).catch(() => undefined);
  } else if (reader.article) {
    reader.close();
  }
}

// store → URL:保留其余查询参数,仅增删 a;目标与当前一致时 no-op,避免多余导航
function setArticleParam(id: number | null): void {
  const current = typeof route.query.a === "string" ? route.query.a : null;
  if (current === (id === null ? null : String(id))) return;
  const query: LocationQueryRaw = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (k === "a" || v == null) continue;
    query[k] = Array.isArray(v) ? v.filter((x): x is string => x !== null) : v;
  }
  if (id !== null) query.a = String(id);
  void router.replace({ query });
}

onMounted(async () => {
  await feedsStore.load();
  void applyRouteQuery().catch(() => undefined);
});

watch(
  () => route.fullPath,
  () => {
    void applyRouteQuery().catch(() => undefined);
  }
);

// 关闭阅读面板:store 置空 + 清掉 URL 的 a(Esc 与移动端返回按钮共用同一路径)
function closeArticle(): void {
  reader.close();
  setArticleParam(null);
}

// 找到方向上的第一个未读并打开;到列表尾部(j 方向)自动加载一页再找一次
async function jumpUnread(dir: 1 | -1): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = articles.items;
    if (list.length > 0) {
      const cur = list.findIndex((i) => i.id === articles.currentId);
      let idx = cur === -1 ? (dir === 1 ? 0 : list.length - 1) : cur + dir;
      while (idx >= 0 && idx < list.length) {
        const item = list[idx];
        if (item && !item.isRead && item.id !== articles.currentId) {
          await selectArticle(item.id);
          return;
        }
        idx += dir;
      }
    }
    if (dir === 1 && attempt === 0 && articles.hasMore) {
      await articles.loadMore();
      continue;
    }
    return;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === "?") {
    toggleShortcutHelp();
    return;
  }
  if (e.key === "Escape" && showShortcutHelp.value) {
    closeShortcutHelp();
    return;
  }
  if (e.key === "j") {
    void jumpUnread(1).catch(() => undefined);
  } else if (e.key === "k") {
    void jumpUnread(-1).catch(() => undefined);
  } else if (e.key === "Escape") {
    closeArticle();
  } else if (reader.article) {
    if (e.key === "s")
      void articles.setState(reader.article.id, { isStarred: !reader.article.isStarred }).catch(() => undefined);
    if (e.key === "m")
      void articles.setState(reader.article.id, { isRead: !reader.article.isRead }).catch(() => undefined);
    if (e.key === "v")
      void articles.setState(reader.article.id, { isLater: !reader.article.isLater }).catch(() => undefined);
  }
}

async function selectArticle(id: number) {
  try {
    await reader.open(id);
  } catch {
    return;
  }
  setArticleParam(id);
  const item = articles.items.find((i) => i.id === id);
  if (settings.prefs.autoMarkReadOnOpen && item && !item.isRead) {
    void articles.setState(id, { isRead: true }).catch(() => undefined);
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-white md:flex-row dark:bg-neutral-950" tabindex="0" @keydown="onKey">
    <Sidebar class="hidden md:flex" />
    <div class="flex min-h-0 min-w-0 flex-1">
      <div
        class="w-full shrink-0 overflow-hidden md:w-[380px] md:border-r md:border-neutral-200 dark:md:border-neutral-800"
        :class="reader.article ? 'hidden md:block' : 'block'"
      >
        <ArticleList />
      </div>
      <ReaderPane v-if="reader.article" @close="closeArticle" />
      <div v-else class="hidden flex-1 items-center justify-center text-sm text-neutral-400 md:flex">选择左侧文章开始阅读</div>
    </div>
    <MobileNav v-if="!reader.article" />
    <ShortcutHelp />
  </div>
</template>
