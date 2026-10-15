export const READLY_VERSION = "1.0.0";

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  createdAt: string;
}

export interface Feed {
  id: number;
  url: string;
  siteUrl: string | null;
  title: string;
  description: string | null;
  iconUrl: string | null;
  categoryId: number | null;
  sortOrder: number;
  lastFetchedAt: string | null;
  errorCount: number;
  lastError: string | null;
  unreadCount: number;
  createdAt: string;
}

export type ArticleView = "all" | "unread" | "starred" | "later";

export interface AiSummary {
  oneLiner: string;
  points: string[];
}

export interface AiTranslation {
  lang: string;
  paragraphs: { i: number; t: string }[];
}

export interface ArticleListItem {
  id: number;
  feedId: number;
  feedTitle: string;
  feedIconUrl: string | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string;
  excerpt: string | null;
  imageUrl: string | null;
  isRead: boolean;
  isStarred: boolean;
  isLater: boolean;
  hasFullText: boolean;
}

export interface ArticleDetail extends ArticleListItem {
  content: string | null;
  contentFull: string | null;
  aiSummary: AiSummary | null;
  aiTranslation: AiTranslation | null;
  extractedAt: string | null;
}

export interface ArticlesPage {
  items: ArticleListItem[];
  nextCursor: string | null;
}

export interface Stats {
  unreadTotal: number;
  starredTotal: number;
  laterTotal: number;
  perFeed: Record<number, number>;
  perCategory: Record<number, number>;
}

export interface ParsedItem {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  publishedAt: string;
  excerpt: string | null;
  content: string | null;
  imageUrl: string | null;
  lang: string | null;
}

export interface FeedParseResult {
  title: string;
  siteUrl: string | null;
  description: string | null;
  iconUrl: string | null;
  items: ParsedItem[];
}

export interface RefreshResult {
  done: boolean;
  processed: number;
  remaining: number;
}

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  useProxy: boolean;
}

export interface FetchPrefs {
  auto: boolean;
  minChars: number;
}

export interface KeywordRule {
  id: string;
  name: string;
  keyword: string;
  isRegex: boolean;
  caseSensitive: boolean;
  color: string;
  enabled: boolean;
}

export type ClusterLevel = "loose" | "normal" | "strict";

export interface ClusterPrefs {
  scope: 100 | 200 | 300;
  level: ClusterLevel;
}

export const CLUSTER_THRESHOLDS: Record<ClusterLevel, number> = {
  loose: 0.45,
  normal: 0.58,
  strict: 0.7,
};

export type ThemeMode = "light" | "dark" | "system";
export type ReadingTheme = "classic" | "sepia" | "paper" | "night" | "contrast";

export interface ReaderPrefs {
  themeMode: ThemeMode;
  accent: string;
  readingTheme: ReadingTheme;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  fontFamily: "system" | "serif";
  autoMarkReadOnOpen: boolean;
  autoMarkReadOnScroll: boolean;
  unreadOnly: boolean;
  collapsedCategoryIds: number[];
  sidebarWidth: number;
  listWidth: number;
  articleLayout: "card" | "list";
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  themeMode: "system",
  accent: "#3b82f6",
  readingTheme: "classic",
  fontSize: 17,
  lineHeight: 1.7,
  contentWidth: 720,
  fontFamily: "system",
  autoMarkReadOnOpen: true,
  autoMarkReadOnScroll: true,
  unreadOnly: false,
  collapsedCategoryIds: [],
  sidebarWidth: 256,
  listWidth: 380,
  articleLayout: "card",
};

export const SETTING_KEYS = {
  readerPrefs: "reader_prefs",
  aiProviders: "ai_providers",
  fetchPrefs: "fetch_prefs",
  keywordRules: "keyword_rules",
  clusterPrefs: "cluster_prefs",
  refreshBatchSize: "refresh_batch_size",
  refreshInterval: "refresh_interval",
  retentionDays: "retention_days",
} as const;
