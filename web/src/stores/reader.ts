import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { ArticleDetail } from "@readly/shared";
import { api } from "@/api/client";
import { useArticlesStore } from "./articles";

export const useReaderStore = defineStore("reader", () => {
  const article = ref<ArticleDetail | null>(null);
  const loading = ref(false);

  async function open(id: number): Promise<void> {
    loading.value = true;
    try {
      article.value = await api<ArticleDetail>(`/api/articles/${id}`);
      useArticlesStore().currentId = id;
    } finally {
      loading.value = false;
    }
  }

  function close(): void {
    article.value = null;
    useArticlesStore().currentId = null;
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

  return { article, loading, open, close };
});
