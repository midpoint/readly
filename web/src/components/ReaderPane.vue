<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { sanitizeArticleHtml } from "@/modules/render";
import { useArticlesStore } from "@/stores/articles";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import ThemePanel from "./ThemePanel.vue";

const emit = defineEmits<{ close: [] }>();

const reader = useReaderStore();
const articles = useArticlesStore();
const showThemePanel = ref(false);

const showOriginal = ref(false);
const useFull = computed(() => Boolean(reader.article?.contentFull) && !showOriginal.value);
const html = computed(() => {
  const a = reader.article;
  if (!a) return "";
  return sanitizeArticleHtml(useFull.value && a.contentFull ? a.contentFull : (a.content ?? ""));
});
watch(
  () => reader.article?.id,
  () => {
    showOriginal.value = false;
  }
);

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

const btn = "rounded-lg border border-neutral-200 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:text-neutral-200";

const settings = useSettingsStore();
const bottomSentinel = ref<HTMLElement | null>(null);
let scrollObserver: IntersectionObserver | null = null;

function setupScrollObserver(): void {
  scrollObserver?.disconnect();
  scrollObserver = null;
  if (!bottomSentinel.value || typeof IntersectionObserver === "undefined") return;
  scrollObserver = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    const a = reader.article;
    if (!a || a.isRead) return;
    if (!settings.prefs.autoMarkReadOnScroll) return;
    void toggle({ isRead: true });
  });
  scrollObserver.observe(bottomSentinel.value);
}

onMounted(setupScrollObserver);
onUnmounted(() => scrollObserver?.disconnect());
watch(() => reader.article?.id, () => void nextTick(setupScrollObserver));
</script>

<template>
  <section class="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-neutral-950">
    <template v-if="reader.article">
      <header class="border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <div class="flex items-center justify-between gap-4">
          <button class="md:hidden shrink-0 whitespace-nowrap rounded-lg border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700 dark:text-neutral-200" @click="emit('close')">← 返回</button>
          <div class="min-w-0 text-xs text-neutral-500">
            <span>{{ reader.article.feedTitle }}</span>
            <span> · </span>
            <span>{{ new Date(reader.article.publishedAt).toLocaleString("zh-CN") }}</span>
          </div>
          <div class="flex flex-wrap justify-end gap-1.5">
            <button :class="btn" @click="toggle({ isStarred: !reader.article.isStarred })">
              {{ reader.article.isStarred ? "★ 已收藏" : "☆ 收藏" }}
            </button>
            <button :class="btn" @click="toggle({ isLater: !reader.article.isLater })">
              {{ reader.article.isLater ? "已稍后读" : "稍后读" }}
            </button>
            <button :class="btn" @click="toggle({ isRead: !reader.article.isRead })">
              {{ reader.article.isRead ? "标为未读" : "标为已读" }}
            </button>
            <button
              v-if="reader.article.url"
              data-fetch-fulltext
              :class="[btn, 'disabled:opacity-50']"
              :disabled="reader.fullTextLoading"
              @click="void reader.fetchFullText().catch(() => undefined)"
            >
              {{ reader.fullTextLoading ? "抓取中…" : reader.article.contentFull ? "重新抓取" : "抓取全文" }}
            </button>
            <button :class="btn" @click="showThemePanel = !showThemePanel">Aa 主题</button>
            <a v-if="reader.article.url" :href="reader.article.url" target="_blank" rel="noopener noreferrer" :class="btn">原文</a>
          </div>
        </div>
        <h2 class="mt-2 text-xl font-semibold leading-snug dark:text-neutral-100">{{ reader.article.title }}</h2>
        <p v-if="reader.fullTextError" class="mt-1 text-xs text-red-600 dark:text-red-400">抓取失败:{{ reader.fullTextError }}</p>
        <p v-if="reader.article.author" class="mt-1 text-xs text-neutral-500">{{ reader.article.author }}</p>
      </header>
      <div class="relative flex min-h-0 flex-1">
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div
            v-if="reader.article.contentFull"
            data-fulltext-source
            class="mx-auto mt-3 flex w-full max-w-[var(--reader-width,720px)] items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
          >
            <span>全文来自原文页{{ reader.fullTextNote ? ` · ${reader.fullTextNote}` : "" }}</span>
            <button data-toggle-original class="shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="showOriginal = !showOriginal">
              {{ showOriginal ? "显示全文" : "显示摘要" }}
            </button>
          </div>
          <article class="reader-body mx-auto w-full px-6 py-6" v-html="html" />
          <div ref="bottomSentinel" class="h-px" />
        </div>
        <div v-if="!html" class="p-6 text-sm text-neutral-500">该文章没有可显示的正文,可尝试打开原文。</div>
        <ThemePanel v-if="showThemePanel" class="absolute inset-y-0 right-0 z-30 shadow-xl" @close="showThemePanel = false" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.reader-body {
  max-width: var(--reader-width, 720px);
  font-size: var(--reader-font-size, 17px);
  line-height: var(--reader-line-height, 1.7);
  font-family: var(--reader-font-family, inherit);
  background: var(--reader-bg, transparent);
  color: var(--reader-text, inherit);
  border-radius: 12px;
}
.reader-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
.reader-body :deep(a) {
  color: var(--reader-link, var(--accent));
}
</style>
