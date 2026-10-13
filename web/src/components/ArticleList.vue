<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { groupArticlesByDate } from "@/modules/date";
import { useArticlesStore } from "@/stores/articles";
import { useReaderStore } from "@/stores/reader";
import ArticleListItem from "./ArticleListItem.vue";
import DateGroupHeader from "./DateGroupHeader.vue";

const route = useRoute();
const router = useRouter();
const articles = useArticlesStore();
const reader = useReaderStore();

const groups = computed(() => groupArticlesByDate(articles.items));

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
  if (item && !item.isRead) void articles.setState(id, { isRead: true });
}
</script>

<template>
  <div class="h-full overflow-y-auto">
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
