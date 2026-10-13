import type { RefreshResult } from "@readly/shared";
import { SETTING_KEYS } from "@readly/shared";
import { fetchText } from "./http";
import { parseFeed } from "./feed-parser";
import { getSetting } from "./settings";

export interface FeedFetchDeps {
  id: number;
  url: string;
  lastEtag: string | null;
  lastModified: string | null;
}

export interface FetchIntoResult {
  inserted: number;
  notModified: boolean;
  title?: string;
  siteUrl?: string | null;
  iconUrl?: string | null;
  description?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export async function fetchFeedIntoDb(
  db: D1Database,
  feed: FeedFetchDeps,
  opts: { initialLimit?: number; fetchFn?: typeof globalThis.fetch } = {}
): Promise<FetchIntoResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (feed.lastEtag) headers["If-None-Match"] = feed.lastEtag;
  if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

  const res = await fetchText(
    feed.url,
    { headers, accept: "application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*" },
    fetchFn
  );

  if (res.status === 304) return { inserted: 0, notModified: true };
  if (res.status < 200 || res.status >= 300) throw new Error(`抓取失败(HTTP ${res.status})`);

  const parsed = parseFeed(res.body, res.headers.get("Content-Type"));
  let items = parsed.items;
  if (opts.initialLimit !== undefined) {
    items = [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, opts.initialLimit);
  }

  const insertStmt = `INSERT OR IGNORE INTO articles
    (feed_id, guid, url, title, author, published_at, excerpt, content, image_url, lang)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  let inserted = 0;
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    const results = await db.batch(
      chunk.map((it) =>
        db
          .prepare(insertStmt)
          .bind(feed.id, it.guid, it.url, it.title, it.author, it.publishedAt, it.excerpt, it.content, it.imageUrl, it.lang)
      )
    );
    inserted += results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }

  return {
    inserted,
    notModified: false,
    title: parsed.title,
    siteUrl: parsed.siteUrl,
    iconUrl: parsed.iconUrl,
    description: parsed.description,
    etag: res.headers.get("ETag"),
    lastModified: res.headers.get("Last-Modified"),
  };
}

interface FeedRow {
  id: number;
  url: string;
  last_etag: string | null;
  last_modified: string | null;
  error_count: number;
}

export async function refreshDueFeeds(
  db: D1Database,
  opts: { limit?: number; fetchFn?: typeof globalThis.fetch; now?: Date } = {}
): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? (await getSetting(db, SETTING_KEYS.refreshBatchSize, 2)))));
  const intervalMin = Math.max(1, await getSetting(db, SETTING_KEYS.refreshInterval, 30));

  const due = await db
    .prepare(
      `SELECT id, url, last_etag, last_modified, error_count FROM feeds
       WHERE next_refresh_at IS NULL OR next_refresh_at <= ?
       ORDER BY next_refresh_at IS NOT NULL, next_refresh_at ASC, id ASC
       LIMIT ?`
    )
    .bind(nowIso, limit)
    .all<FeedRow>();

  let processed = 0;
  for (const feed of due.results) {
    processed++;
    try {
      const r = await fetchFeedIntoDb(db, { id: feed.id, url: feed.url, lastEtag: feed.last_etag, lastModified: feed.last_modified }, { fetchFn: opts.fetchFn });
      const next = new Date(now.getTime() + intervalMin * 60_000).toISOString();
      await db
        .prepare(
          `UPDATE feeds SET
             title = CASE WHEN title = url AND ? IS NOT NULL THEN ? ELSE title END,
             site_url = COALESCE(site_url, ?),
             icon_url = COALESCE(icon_url, ?),
             description = COALESCE(description, ?),
             last_etag = COALESCE(?, last_etag),
             last_modified = COALESCE(?, last_modified),
             last_fetched_at = ?, next_refresh_at = ?, error_count = 0, last_error = NULL
           WHERE id = ?`
        )
        .bind(r.title ?? null, r.title ?? null, r.siteUrl ?? null, r.iconUrl ?? null, r.description ?? null, r.etag ?? null, r.lastModified ?? null, nowIso, next, feed.id)
        .run();
    } catch (e) {
      const errCount = feed.error_count + 1;
      const backoffMs = Math.min(2 ** errCount, 24) * 3_600_000;
      const next = new Date(now.getTime() + backoffMs).toISOString();
      await db
        .prepare("UPDATE feeds SET error_count = ?, last_error = ?, next_refresh_at = ?, last_fetched_at = ? WHERE id = ?")
        .bind(errCount, e instanceof Error ? e.message : String(e), next, nowIso, feed.id)
        .run();
    }
  }

  const remainingRow = await db
    .prepare("SELECT COUNT(*) c FROM feeds WHERE next_refresh_at IS NULL OR next_refresh_at <= ?")
    .bind(nowIso)
    .first<{ c: number }>();
  const remaining = remainingRow?.c ?? 0;

  return { done: remaining === 0, processed, remaining };
}
