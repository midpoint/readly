import type { ArticleDetail, ArticleListItem, AiSummary, AiTranslation } from "@readly/shared";

export interface ArticleRow {
  id: number;
  feed_id: number;
  feed_title: string;
  feed_icon_url: string | null;
  title: string;
  url: string | null;
  author: string | null;
  published_at: string;
  excerpt: string | null;
  image_url: string | null;
  has_full_text: number;
  is_read: number;
  is_starred: number;
  is_later: number;
  content?: string | null;
  content_full?: string | null;
  ai_summary?: string | null;
  ai_translation?: string | null;
  extracted_at?: string | null;
}

export function toArticleListItem(row: ArticleRow): ArticleListItem {
  return {
    id: row.id,
    feedId: row.feed_id,
    feedTitle: row.feed_title,
    feedIconUrl: row.feed_icon_url,
    title: row.title,
    url: row.url,
    author: row.author,
    publishedAt: row.published_at,
    excerpt: row.excerpt,
    imageUrl: row.image_url,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    isLater: row.is_later === 1,
    hasFullText: row.has_full_text === 1,
  };
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function toArticleDetail(row: ArticleRow): ArticleDetail {
  return {
    ...toArticleListItem(row),
    content: row.content ?? null,
    contentFull: row.content_full ?? null,
    aiSummary: parseJson<AiSummary>(row.ai_summary),
    aiTranslation: parseJson<AiTranslation>(row.ai_translation),
    extractedAt: row.extracted_at ?? null,
  };
}
