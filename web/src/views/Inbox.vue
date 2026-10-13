<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute } from "vue-router";
import type { ArticleView } from "@readly/shared";
import ArticleList from "@/components/ArticleList.vue";
import ReaderPane from "@/components/ReaderPane.vue";
import Sidebar from "@/components/Sidebar.vue";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";
import { useReaderStore } from "@/stores/reader";

const route = useRoute();
const feedsStore = useFeedsStore();
const articles = useArticlesStore();
const reader = useReaderStore();

onMounted(async () => {
  await feedsStore.load();
  const view = (typeof route.query.view === "string" ? route.query.view : "all") as ArticleView;
  const feedId = typeof route.query.feed === "string" ? Number(route.query.feed) : null;
  const categoryId = typeof route.query.category === "string" ? Number(route.query.category) : null;
  await articles.setFilter(view, feedId, categoryId);
  if (typeof route.query.a === "string") void reader.open(Number(route.query.a));
});

function onKey(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const idx = articles.items.findIndex((i) => i.id === articles.currentId);
  if (e.key === "j") {
    const next = articles.items[Math.min(idx + 1, articles.items.length - 1)] ?? articles.items[0];
    if (next) void selectArticle(next.id);
  } else if (e.key === "k") {
    const prev = articles.items[Math.max(idx - 1, 0)];
    if (prev) void selectArticle(prev.id);
  } else if (e.key === "Escape") {
    reader.close();
  } else if (reader.article) {
    if (e.key === "s") void articles.setState(reader.article.id, { isStarred: !reader.article.isStarred });
    if (e.key === "m") void articles.setState(reader.article.id, { isRead: !reader.article.isRead });
    if (e.key === "v") void articles.setState(reader.article.id, { isLater: !reader.article.isLater });
  }
}

async function selectArticle(id: number) {
  await reader.open(id);
  const item = articles.items.find((i) => i.id === id);
  if (item && !item.isRead) void articles.setState(id, { isRead: true });
}
</script>

<template>
  <div class="flex h-full" tabindex="0" @keydown="onKey">
    <Sidebar class="hidden md:flex" />
    <div class="flex min-w-0 flex-1">
      <div class="w-full shrink-0 overflow-hidden border-r border-neutral-200 md:w-[380px] dark:border-neutral-800">
        <ArticleList />
      </div>
      <ReaderPane class="hidden md:flex" />
    </div>
  </div>
</template>
