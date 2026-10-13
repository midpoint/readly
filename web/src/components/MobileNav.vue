<script setup lang="ts">
import { useRouter } from "vue-router";
import { useArticlesStore } from "@/stores/articles";

const router = useRouter();
const articles = useArticlesStore();

const tabs: { key: "all" | "unread" | "starred" | "later"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "unread", label: "未读" },
  { key: "starred", label: "收藏" },
  { key: "later", label: "稍后读" },
];

function go(key: "all" | "unread" | "starred" | "later") {
  void router.replace({ path: "/", query: key === "all" ? {} : { view: key } });
  void articles.setFilter(key, null, null).catch(() => undefined);
}
</script>

<template>
  <nav class="flex border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 md:hidden">
    <button
      v-for="t in tabs"
      :key="t.key"
      class="flex-1 py-2.5 text-center text-xs"
      :class="articles.view === t.key ? 'font-medium text-[var(--accent)]' : 'text-neutral-500'"
      @click="go(t.key)"
    >
      {{ t.label }}
    </button>
    <button class="flex-1 py-2.5 text-center text-xs text-neutral-500" @click="router.push('/add')">添加</button>
  </nav>
</template>
