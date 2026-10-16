<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { ArticleDetail } from "@readly/shared";
import { aiTextOf, detectTextLang } from "@/modules/ai";
import { highlightMatchesIn } from "@/modules/highlight";
import { sanitizeArticleHtml } from "@/modules/render";
import { useAiStore } from "@/stores/ai";
import { useAnalysisStore } from "@/stores/analysis";
import { useArticlesStore } from "@/stores/articles";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import ThemePanel from "./ThemePanel.vue";

const emit = defineEmits<{ close: [] }>();

const reader = useReaderStore();
const articles = useArticlesStore();
const analysis = useAnalysisStore();
const showThemePanel = ref(false);

// AI 摘要:本地切片一次(幂等);未配置时点击按钮给出设置引导
const ai = useAiStore();
const showAiCard = ref(false);
const showAiGuide = ref(false);
const aiDegraded = ref(false); // 本轮生成以非 JSON 原文收束(summary 为 null);仅在 state=done 下被消费,切文后旧续段不写
// 流式视图:生成中,或本轮降级收束(展示原文 + 说明);其余情况有缓存即直接展示摘要卡
const aiStreamView = computed(() => ai.summaryState === "loading" || (ai.summaryState === "done" && aiDegraded.value));
ai.init();

async function runSummary(a: ArticleDetail): Promise<void> {
  showAiCard.value = true;
  aiDegraded.value = false;
  // 失败时 store 已写入 summaryError(经 [data-ai-error] 展示);取消/切文静默收束
  const outcome = await ai
    .generateSummary({
      id: a.id,
      title: a.title,
      text: aiTextOf(a.contentFull ?? a.content ?? a.excerpt),
      lang: detectTextLang(a.title),
    })
    .catch(() => null);
  // 切文(resetSummary)后旧续段不得写任何可见状态:先以文章 id 守卫(取消/复位结算的 raw 为空,不会走到降级)
  if (reader.article?.id !== a.id) return;
  if (outcome?.summary) a.aiSummary = outcome.summary;
  else if (outcome && ai.summaryState === "done") aiDegraded.value = true; // 有原文无 summary:降级(旧摘要保留)
}

function onAiButton(): void {
  const a = reader.article;
  if (!a) return;
  if (ai.summaryState === "loading") {
    ai.cancelSummary(); // 生成中再点 = 取消
    return;
  }
  if (a.aiSummary) {
    // 已有缓存:只切换卡片显隐,不重新生成
    showAiCard.value = !showAiCard.value;
    return;
  }
  if (!ai.configured) {
    showAiGuide.value = true;
    return;
  }
  void runSummary(a);
}

function regenerate(): void {
  const a = reader.article;
  if (!a) return;
  // 不清缓存:成功才替换,失败/降级保留旧摘要(错误经 [data-ai-error]、降级经卡片说明提示)
  void runSummary(a);
}

const showOriginal = ref(false);
const useFull = computed(() => Boolean(reader.article?.contentFull) && !showOriginal.value);
const html = computed(() => {
  const a = reader.article;
  if (!a) return "";
  return sanitizeArticleHtml(useFull.value && a.contentFull ? a.contentFull : (a.content ?? ""));
});
// 中文版式判定:以「已消毒、即所渲染」的内容为源(与 html 同源;style/script 已被过滤);
// 摘要/全文切换或抓取全文后随之重判
const isZh = computed(() => detectTextLang(aiTextOf(html.value)) === "zh");
watch(
  () => reader.article?.id,
  () => {
    showOriginal.value = false;
    // 切文复位:卡片/引导收起;在途摘要作废(已有 aiSummary 的缓存不自动弹,由按钮展开)
    showAiCard.value = false;
    showAiGuide.value = false;
    aiDegraded.value = false;
    ai.resetSummary();
  }
);

// 渲染后高亮:只包裹已清洗 DOM 的文本节点(零 innerHTML 注入)。
// watch 源返回新数组,每次依赖重估(html 变化 / rules 任意变更含换色 / 文章 id)都会触发回调,
// 在下一拍重贴;v-html 重渲染会清掉旧 mark,而 highlightMatchesIn 本身幂等(先清旧 mark 再包裹),
// 重贴不叠加、换色/关闭即时生效;规则从本地/服务端异步就绪时同理由此覆盖。
const articleBody = ref<HTMLElement | null>(null);

function applyHighlights(): void {
  const el = articleBody.value;
  if (!el) return;
  highlightMatchesIn(el, analysis.rules, { maxMarks: 300 });
}

watch(
  () => [html.value, analysis.rules.length ?? 0, reader.article?.id] as const,
  () => {
    void nextTick(applyHighlights);
  },
  { immediate: true }
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
          <div class="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
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
            <button
              data-ai-button
              :class="btn"
              :title="ai.summaryState === 'loading' ? '点击取消' : undefined"
              @click="onAiButton"
            >
              {{ ai.summaryState === "loading" ? "生成中…" : "AI 摘要" }}
            </button>
            <button :class="btn" @click="showThemePanel = !showThemePanel">Aa 主题</button>
            <a v-if="reader.article.url" :href="reader.article.url" target="_blank" rel="noopener noreferrer" :class="btn">原文</a>
          </div>
        </div>
        <h2 class="mt-2 text-xl font-semibold leading-snug dark:text-neutral-100">{{ reader.article.title }}</h2>
        <p v-if="reader.fullTextError" class="mt-1 text-xs text-red-600 dark:text-red-400">抓取失败:{{ reader.fullTextError }}</p>
        <p v-if="reader.article.author" class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ reader.article.author }}</p>
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
          <div
            v-if="showAiCard && reader.article.aiSummary && !aiStreamView"
            data-ai-card
            class="mx-auto mt-3 w-full max-w-[var(--reader-width,720px)] rounded-xl border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800"
          >
            <p class="font-medium dark:text-neutral-100">{{ reader.article.aiSummary.oneLiner }}</p>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-300">
              <li v-for="(p, i) in reader.article.aiSummary.points" :key="i">{{ p }}</li>
            </ul>
            <div class="mt-2 flex justify-end gap-2">
              <button data-ai-regenerate class="text-xs text-neutral-500 hover:underline dark:text-neutral-400" @click="regenerate">重新生成</button>
            </div>
          </div>
          <div
            v-else-if="showAiCard && aiStreamView"
            data-ai-stream-card
            class="mx-auto mt-3 w-full max-w-[var(--reader-width,720px)] rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800"
          >
            <p data-ai-stream class="whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300">{{ ai.summaryStream }}<span v-if="ai.summaryState === 'loading'">▍</span></p>
            <p v-if="ai.summaryState === 'done' && aiDegraded" class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">模型未按 JSON 输出,以上为原始回复</p>
          </div>
          <div
            v-else-if="showAiGuide && !ai.configured"
            data-ai-guide
            class="mx-auto mt-3 w-full max-w-[var(--reader-width,720px)] rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800"
          >
            <p class="text-sm text-neutral-600 dark:text-neutral-300">尚未配置 AI 服务商。</p>
            <RouterLink to="/settings" class="text-sm text-[var(--accent-strong)] hover:underline">前往设置 →</RouterLink>
          </div>
          <p v-if="ai.summaryError" data-ai-error class="mx-auto mt-2 w-full max-w-[var(--reader-width,720px)] text-xs text-red-600 dark:text-red-400">{{ ai.summaryError }}</p>
          <article ref="articleBody" class="reader-body mx-auto w-full px-6 py-6" :class="{ 'reader-zh': isZh }" v-html="html" />
          <div ref="bottomSentinel" class="h-px" />
        </div>
        <div v-if="!html" class="p-6 text-sm text-neutral-500 dark:text-neutral-400">该文章没有可显示的正文,可尝试打开原文。</div>
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
/* —— 中文书籍派版式(reader-zh;西文不加此类,保持现状) —— */
.reader-body.reader-zh {
  text-align: justify;
  text-spacing-trim: space-first; /* 标点挤压;旧浏览器忽略该属性,无副作用 */
  letter-spacing: 0.01em;
}
.reader-body.reader-zh :deep(p) {
  text-indent: 2em;
  margin: 0.8em 0;
}
/* 非段落例外:不首行缩进 */
.reader-body.reader-zh :deep(blockquote p),
.reader-body.reader-zh :deep(li p),
.reader-body.reader-zh :deep(pre),
.reader-body.reader-zh :deep(figcaption) {
  text-indent: 0;
}
.reader-body.reader-zh :deep(p[data-img-only]) {
  text-indent: 0;
}
/* —— 语言无关的通用版式改进 —— */
.reader-body :deep(blockquote) {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent);
}
/* Tailwind preflight 清零了列表样式,此处恢复项目符号(规格「靠项目符号对齐」的前提) */
.reader-body :deep(ul) {
  padding-left: 1.8em;
  list-style: disc;
}
.reader-body :deep(ol) {
  padding-left: 1.8em;
  list-style: decimal;
}
.reader-body :deep(li) {
  margin: 0.35em 0;
}
/* 独立图片居中留白(经 sanitize 精确打标的纯图片段);段落内行内图零影响 */
.reader-body :deep(p[data-img-only] img),
.reader-body :deep(figure img) {
  display: block;
  margin: 1em auto;
}
</style>
