import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { ArticleDetail } from "@readly/shared";
import { api } from "@/api/client";
import { extractFromHtml, plainTextLength } from "@/modules/extract";
import { useArticlesStore } from "./articles";
import { useSettingsStore } from "./settings";

export const useReaderStore = defineStore("reader", () => {
  const article = ref<ArticleDetail | null>(null);
  const loading = ref(false);
  const fullTextLoading = ref(false);
  const fullTextError = ref<string | null>(null);
  const fullTextNote = ref<string | null>(null);

  async function open(id: number): Promise<void> {
    loading.value = true;
    fullTextError.value = null;
    fullTextNote.value = null;
    try {
      article.value = await api<ArticleDetail>(`/api/articles/${id}`);
      useArticlesStore().currentId = id;
    } finally {
      loading.value = false;
    }
    maybeAutoExtract();
  }

  function close(): void {
    article.value = null;
    useArticlesStore().currentId = null;
  }

  function maybeAutoExtract(): void {
    const a = article.value;
    if (!a || !a.url || a.contentFull) return;
    const fp = useSettingsStore().fetchPrefs;
    if (!fp.auto) return;
    if (plainTextLength(a.content ?? a.excerpt) >= fp.minChars) return;
    void fetchFullText().catch(() => undefined);
  }

  async function fetchFullText(): Promise<void> {
    const a = article.value;
    if (!a || !a.url || fullTextLoading.value) return;
    fullTextLoading.value = true;
    fullTextError.value = null;
    fullTextNote.value = null;
    try {
      const res = await api<{ html: string; finalUrl: string; truncated: boolean }>("/api/proxy/html", { query: { url: a.url } });
      const result = extractFromHtml(res.html, res.finalUrl);
      if (article.value?.id !== a.id) return; // 中途切文,丢弃结果
      if (result.html.length > 512 * 1024) {
        article.value.contentFull = result.html;
        fullTextNote.value = "文章较长,本次仅在本地显示";
        return;
      }
      article.value.contentFull = result.html;
      if (res.truncated) fullTextNote.value = "页面较大,仅提取到部分内容";
      article.value.extractedAt = new Date().toISOString();
      useArticlesStore().patchItemLocally(a.id, { hasFullText: true });
      try {
        await api(`/api/articles/${a.id}/fulltext`, { method: "POST", body: { content_full: result.html } });
      } catch {
        fullTextNote.value = "全文已提取,但保存失败(本次仅本地可见)";
      }
    } catch (e) {
      if (article.value?.id !== a.id) throw e; // 已切文:旧文章的失败不挂到新文章头部
      fullTextError.value = e instanceof Error ? e.message : "抓取失败";
      throw e;
    } finally {
      fullTextLoading.value = false;
      // 抓取期间用户已切到其它文章:该文仍需按自动条件补抓(串行,无风暴)
      if (article.value !== null && article.value.id !== a.id) {
        maybeAutoExtract();
      }
    }
  }

  // 列表内状态变化(收藏/已读)同步到已打开的文章详情
  const articles = useArticlesStore();
  watch(
    () => articles.current,
    (cur) => {
      if (article.value && cur && cur.id === article.value.id) {
        article.value.isRead = cur.isRead;
        article.value.isStarred = cur.isStarred;
        article.value.isLater = cur.isLater;
      }
    },
    { deep: true }
  );

  return { article, loading, fullTextLoading, fullTextError, fullTextNote, open, close, fetchFullText };
});
