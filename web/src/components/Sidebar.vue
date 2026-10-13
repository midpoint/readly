<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";

const feedsStore = useFeedsStore();
const articles = useArticlesStore();
const router = useRouter();

const stats = computed(() => feedsStore.stats);

function select(view: "all" | "unread" | "starred" | "later", feedId: number | null = null, categoryId: number | null = null) {
  const query: Record<string, string> = {};
  if (view !== "all") query.view = view;
  if (feedId !== null) query.feed = String(feedId);
  if (categoryId !== null) query.category = String(categoryId);
  void router.replace({ path: "/", query });
  void articles.setFilter(view, feedId, categoryId);
}

function feedsOf(categoryId: number | null) {
  return feedsStore.feeds.filter((f) => (categoryId === null ? f.categoryId === null : f.categoryId === categoryId));
}

const navItem = "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-sm text-left hover:bg-neutral-200/60 dark:hover:bg-neutral-800";
</script>

<template>
  <aside class="flex h-full w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
    <div class="flex items-center justify-between px-4 py-3">
      <h1 class="text-base font-semibold">Readly</h1>
      <button class="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white" @click="router.push('/add')">
        添加订阅
      </button>
    </div>
    <nav class="space-y-0.5 px-2">
      <button :class="navItem" @click="select('all')">
        <span>全部文章</span>
      </button>
      <button :class="navItem" @click="select('unread')">
        <span>未读</span>
        <span v-if="stats?.unreadTotal" class="text-xs text-neutral-500">{{ stats.unreadTotal }}</span>
      </button>
      <button :class="navItem" @click="select('starred')">
        <span>收藏</span>
        <span v-if="stats?.starredTotal" class="text-xs text-neutral-500">{{ stats.starredTotal }}</span>
      </button>
      <button :class="navItem" @click="select('later')">
        <span>稍后读</span>
        <span v-if="stats?.laterTotal" class="text-xs text-neutral-500">{{ stats.laterTotal }}</span>
      </button>
    </nav>
    <div class="mt-4 flex-1 overflow-y-auto px-2 pb-4">
      <template v-for="cat in feedsStore.categories" :key="cat.id">
        <button :class="[navItem, 'mt-2 font-medium text-neutral-500']" @click="select('all', null, cat.id)">
          <span class="truncate">{{ cat.name }}</span>
          <span v-if="stats?.perCategory[cat.id]" class="text-xs">{{ stats.perCategory[cat.id] }}</span>
        </button>
        <button
          v-for="feed in feedsOf(cat.id)"
          :key="feed.id"
          :class="[navItem, 'pl-6']"
          @click="select('all', feed.id, null)"
        >
          <span class="truncate">{{ feed.title }}</span>
          <span v-if="feed.unreadCount" class="text-xs text-neutral-500">{{ feed.unreadCount }}</span>
        </button>
      </template>
      <button :class="[navItem, 'mt-2 font-medium text-neutral-500']" @click="select('all')">
        <span>未分类</span>
      </button>
      <button v-for="feed in feedsOf(null)" :key="feed.id" :class="[navItem, 'pl-6']" @click="select('all', feed.id, null)">
        <span class="truncate">{{ feed.title }}</span>
        <span v-if="feed.unreadCount" class="text-xs text-neutral-500">{{ feed.unreadCount }}</span>
      </button>
    </div>
    <div class="border-t border-neutral-200 p-3 dark:border-neutral-800">
      <button class="w-full rounded-lg px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="router.push('/add')">
        导入 / 导出 OPML
      </button>
    </div>
  </aside>
</template>
