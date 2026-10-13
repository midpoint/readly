<script setup lang="ts">
import { computed } from "vue";
import { sanitizeArticleHtml } from "@/modules/render";
import { useArticlesStore } from "@/stores/articles";
import { useReaderStore } from "@/stores/reader";

const reader = useReaderStore();
const articles = useArticlesStore();

const html = computed(() => (reader.article?.content ? sanitizeArticleHtml(reader.article.content) : ""));

async function toggle(patch: { isRead?: boolean; isStarred?: boolean; isLater?: boolean }) {
  const a = reader.article;
  if (!a) return;
  const prev = { isRead: a.isRead, isStarred: a.isStarred, isLater: a.isLater };
  const next = { ...prev, ...patch };
  Object.assign(a, next);
  articles.patchItemLocally(a.id, next);
  try {
    await articles.setState(a.id, patch);
  } catch {
    Object.assign(a, prev);
    articles.patchItemLocally(a.id, prev);
  }
}

const btn = "rounded-lg border border-neutral-200 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800";
</script>

<template>
  <section class="flex h-full flex-1 flex-col overflow-hidden">
    <div v-if="!reader.article" class="flex h-full items-center justify-center text-sm text-neutral-400">
      选择左侧文章开始阅读
    </div>
    <template v-else>
      <header class="border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0 text-xs text-neutral-500">
            <span>{{ reader.article.feedTitle }}</span>
            <span> · </span>
            <span>{{ new Date(reader.article.publishedAt).toLocaleString("zh-CN") }}</span>
          </div>
          <div class="flex shrink-0 gap-1.5">
            <button :class="btn" @click="toggle({ isStarred: !reader.article.isStarred })">
              {{ reader.article.isStarred ? "★ 已收藏" : "☆ 收藏" }}
            </button>
            <button :class="btn" @click="toggle({ isLater: !reader.article.isLater })">
              {{ reader.article.isLater ? "已稍后读" : "稍后读" }}
            </button>
            <button :class="btn" @click="toggle({ isRead: !reader.article.isRead })">
              {{ reader.article.isRead ? "标为未读" : "标为已读" }}
            </button>
            <a v-if="reader.article.url" :href="reader.article.url" target="_blank" rel="noopener noreferrer" :class="btn">原文</a>
          </div>
        </div>
        <h2 class="mt-2 text-xl font-semibold leading-snug">{{ reader.article.title }}</h2>
        <p v-if="reader.article.author" class="mt-1 text-xs text-neutral-500">{{ reader.article.author }}</p>
      </header>
      <article class="reader-body mx-auto w-full overflow-y-auto px-6 py-6" v-html="html" />
      <div v-if="!html" class="p-6 text-sm text-neutral-500">该文章没有可显示的正文,可尝试打开原文。</div>
    </template>
  </section>
</template>

<style scoped>
.reader-body {
  max-width: var(--reader-width, 720px);
  font-size: var(--reader-font-size, 17px);
  line-height: var(--reader-line-height, 1.7);
}
.reader-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
.reader-body :deep(a) {
  color: var(--accent);
}
</style>
