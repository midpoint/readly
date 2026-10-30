import { Hono, type Context } from "hono";
import { SETTING_KEYS, type FeverAuth } from "@readly/shared";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth";
import { md5Hex } from "../lib/md5";
import { getSetting } from "../lib/settings";
import { unixSeconds } from "../lib/greader";

const API_VERSION = 3;
const ITEM_LIMIT = 50;
const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = Context<{ Bindings: Env }>;

interface BaseResponse {
  api_version: number;
  auth: number;
  last_refreshed_on_time?: number;
  [key: string]: unknown;
}

interface CategoryRow {
  id: number;
  name: string;
}

interface FeedRow {
  id: number;
  url: string;
  site_url: string | null;
  title: string;
  category_id: number | null;
  last_fetched_at: string | null;
}

interface ItemRow {
  id: number;
  feed_id: number;
  title: string;
  author: string | null;
  url: string | null;
  published_at: string;
  excerpt: string | null;
  content: string | null;
  content_full: string | null;
  is_read: number;
  is_saved: number;
}

const ITEM_SELECT = `
  SELECT a.id, a.feed_id, a.title, a.author, a.url, a.published_at,
         a.excerpt, a.content, a.content_full,
         COALESCE(s.is_read, 0) AS is_read,
         COALESCE(s.is_starred, 0) AS is_saved
  FROM articles a
  LEFT JOIN article_states s ON s.article_id = a.id`;

export async function loadFeverCredentials(db: D1Database): Promise<FeverAuth | null> {
  const value = await getSetting<FeverAuth | null>(db, SETTING_KEYS.feverAuth, null);
  if (!value || typeof value !== "object") return null;
  if (typeof value.username !== "string" || !value.username) return null;
  if (typeof value.password !== "string" || !value.password) return null;
  return { username: value.username, password: value.password };
}

async function collectParams(c: Ctx): Promise<Map<string, string>> {
  const params = new Map<string, string>();
  new URL(c.req.url).searchParams.forEach((value, key) => params.set(key, value));
  if (c.req.method === "POST") {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await c.req
        .json<Record<string, unknown>>()
        .catch(() => ({}) as Record<string, unknown>);
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") params.set(key, value);
      }
    } else {
      const form = await c.req.raw.formData().catch(() => null);
      form?.forEach((value, key) => {
        if (typeof value === "string") params.set(key, value);
      });
    }
  }
  return params;
}

async function lastRefreshed(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(last_fetched_at) AS latest FROM feeds")
    .first<{ latest: string | null }>();
  return unixSeconds(row?.latest ?? null);
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseInteger(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

function parseIds(raw: string | undefined): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const text = part.trim();
    if (!/^\d+$/.test(text)) continue;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= ITEM_LIMIT) break;
  }
  return out;
}

function beforeIso(raw: string | undefined): string {
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString();
  const ms = value > 1e14 ? Math.floor(value / 1000) : value > 1e10 ? Math.floor(value) : Math.floor(value * 1000);
  if (ms > 253402300799000) return new Date().toISOString();
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function toFeverItem(row: ItemRow): Record<string, unknown> {
  return {
    id: row.id,
    feed_id: row.feed_id,
    title: row.title,
    author: row.author ?? "",
    html: row.content_full ?? row.content ?? row.excerpt ?? "",
    url: row.url ?? "",
    is_saved: row.is_saved,
    is_read: row.is_read,
    created_on_time: unixSeconds(row.published_at),
  };
}

async function loadLibrary(db: D1Database): Promise<{
  groups: { id: number; title: string }[];
  feeds: Record<string, unknown>[];
  feedsGroups: { group_id: number; feed_ids: string }[];
}> {
  const categories = await db
    .prepare("SELECT id, name FROM categories ORDER BY sort_order, id")
    .all<CategoryRow>();
  const feeds = await db
    .prepare(
      `SELECT id, url, site_url, title, category_id, last_fetched_at
       FROM feeds ORDER BY sort_order, id`
    )
    .all<FeedRow>();

  const byCategory = new Map<number, number[]>();
  for (const feed of feeds.results) {
    if (feed.category_id === null) continue;
    const list = byCategory.get(feed.category_id) ?? [];
    list.push(feed.id);
    byCategory.set(feed.category_id, list);
  }

  const feedsGroups: { group_id: number; feed_ids: string }[] = [];
  for (const category of categories.results) {
    const ids = byCategory.get(category.id);
    if (!ids || ids.length === 0) continue;
    feedsGroups.push({ group_id: category.id, feed_ids: ids.sort((a, b) => a - b).join(",") });
  }

  return {
    groups: categories.results.map((category) => ({ id: category.id, title: category.name })),
    feeds: feeds.results.map((feed) => ({
      id: feed.id,
      favicon_id: 0,
      title: feed.title,
      url: feed.url,
      site_url: feed.site_url ?? "",
      is_spark: 0,
      last_updated_on_time: unixSeconds(feed.last_fetched_at),
    })),
    feedsGroups,
  };
}

async function loadItems(db: D1Database, params: Map<string, string>): Promise<{
  items: Record<string, unknown>[];
  total_items: number;
}> {
  const total = await db.prepare("SELECT COUNT(*) AS n FROM articles").first<{ n: number }>();
  const totalItems = total?.n ?? 0;

  const maxRaw = params.get("max_id");
  if (params.has("max_id")) {
    const maxId = parseNonNegativeInt(maxRaw);
    if (maxId !== null) {
      const rows =
        maxId === 0
          ? await db
              .prepare(`${ITEM_SELECT} ORDER BY a.id DESC LIMIT ?`)
              .bind(ITEM_LIMIT)
              .all<ItemRow>()
          : await db
              .prepare(`${ITEM_SELECT} WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`)
              .bind(maxId, ITEM_LIMIT)
              .all<ItemRow>();
      return { items: rows.results.map(toFeverItem), total_items: totalItems };
    }
  }

  if (params.has("with_ids")) {
    const ids = parseIds(params.get("with_ids"));
    if (ids.length === 0) return { items: [], total_items: totalItems };
    const rows = await db
      .prepare(
        `${ITEM_SELECT} WHERE a.id IN (SELECT value FROM json_each(?))
         ORDER BY a.id ASC LIMIT ?`
      )
      .bind(JSON.stringify(ids), ITEM_LIMIT)
      .all<ItemRow>();
    return { items: rows.results.map(toFeverItem), total_items: totalItems };
  }

  const sinceId = parseNonNegativeInt(params.get("since_id")) ?? 0;
  const rows = await db
    .prepare(`${ITEM_SELECT} WHERE a.id > ? ORDER BY a.id ASC LIMIT ?`)
    .bind(sinceId, ITEM_LIMIT)
    .all<ItemRow>();
  return { items: rows.results.map(toFeverItem), total_items: totalItems };
}

async function unreadItemIds(db: D1Database): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT a.id FROM articles a
       LEFT JOIN article_states s ON s.article_id = a.id
       WHERE COALESCE(s.is_read, 0) = 0
       ORDER BY a.id ASC`
    )
    .all<{ id: number }>();
  return rows.results.map((row) => row.id).join(",");
}

async function savedItemIds(db: D1Database): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT a.id FROM articles a
       LEFT JOIN article_states s ON s.article_id = a.id
       WHERE COALESCE(s.is_starred, 0) = 1
       ORDER BY a.id ASC`
    )
    .all<{ id: number }>();
  return rows.results.map((row) => row.id).join(",");
}

async function writeItemState(
  db: D1Database,
  ids: number[],
  as: "read" | "unread" | "saved" | "unsaved",
  now: string
): Promise<"unread" | "saved"> {
  if (ids.length > 0) {
    const jsonIds = JSON.stringify(ids);
    if (as === "read") {
      await db
        .prepare(
          `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
           SELECT a.id, 1, ?, ? FROM articles a
           WHERE a.id IN (SELECT value FROM json_each(?))
           ON CONFLICT(article_id) DO UPDATE SET
             is_read = 1, read_at = COALESCE(read_at, excluded.read_at), updated_at = excluded.updated_at`
        )
        .bind(now, now, jsonIds)
        .run();
    } else if (as === "unread") {
      await db
        .prepare(
          `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
           SELECT a.id, 0, NULL, ? FROM articles a
           WHERE a.id IN (SELECT value FROM json_each(?))
           ON CONFLICT(article_id) DO UPDATE SET
             is_read = 0, read_at = NULL, updated_at = excluded.updated_at`
        )
        .bind(now, jsonIds)
        .run();
    } else if (as === "saved") {
      await db
        .prepare(
          `INSERT INTO article_states (article_id, is_starred, starred_at, updated_at)
           SELECT a.id, 1, ?, ? FROM articles a
           WHERE a.id IN (SELECT value FROM json_each(?))
           ON CONFLICT(article_id) DO UPDATE SET
             is_starred = 1, starred_at = COALESCE(starred_at, excluded.starred_at), updated_at = excluded.updated_at`
        )
        .bind(now, now, jsonIds)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO article_states (article_id, is_starred, starred_at, updated_at)
           SELECT a.id, 0, NULL, ? FROM articles a
           WHERE a.id IN (SELECT value FROM json_each(?))
           ON CONFLICT(article_id) DO UPDATE SET
             is_starred = 0, starred_at = NULL, updated_at = excluded.updated_at`
        )
        .bind(now, jsonIds)
        .run();
    }
  }
  return as === "read" || as === "unread" ? "unread" : "saved";
}

async function markFeedOrGroup(
  db: D1Database,
  mark: "feed" | "group",
  rawId: string | undefined,
  before: string | undefined,
  now: string
): Promise<void> {
  const id = parseInteger(rawId);
  if (id === null) return;
  if (mark === "feed" && id <= 0) return;
  if (mark === "group" && id < 0) return;

  const cutoff = beforeIso(before);
  let scope = "";
  const binds: (string | number)[] = [now, now, cutoff];
  if (mark === "feed") {
    scope = " AND a.feed_id = ?";
    binds.push(id);
  } else if (id > 0) {
    scope = " AND f.category_id = ?";
    binds.push(id);
  }

  await db
    .prepare(
      `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
       SELECT a.id, 1, ?, ? FROM articles a
       JOIN feeds f ON f.id = a.feed_id
       LEFT JOIN article_states s ON s.article_id = a.id
       WHERE COALESCE(s.is_read, 0) = 0 AND a.published_at < ?${scope}
       ON CONFLICT(article_id) DO UPDATE SET
         is_read = 1, read_at = excluded.read_at, updated_at = excluded.updated_at`
    )
    .bind(...binds)
    .run();
}

async function applyWrite(
  db: D1Database,
  params: Map<string, string>,
  payload: BaseResponse
): Promise<void> {
  const mark = params.get("mark");
  const as = params.get("as");
  const now = new Date().toISOString();

  if (mark === "item" && (as === "read" || as === "unread" || as === "saved" || as === "unsaved")) {
    const kind = await writeItemState(db, parseIds(params.get("id")), as, now);
    if (kind === "unread") payload.unread_item_ids = await unreadItemIds(db);
    else payload.saved_item_ids = await savedItemIds(db);
    return;
  }

  if ((mark === "feed" || mark === "group") && as === "read") {
    await markFeedOrGroup(db, mark, params.get("id"), params.get("before"), now);
    payload.unread_item_ids = await unreadItemIds(db);
  }
}

const fever = new Hono<{ Bindings: Env }>();

fever.on(["GET", "POST"], "/fever", handleFever);
fever.on(["GET", "POST"], "/fever/", handleFever);
fever.on(["GET", "POST"], "/fever.php", handleFever);

async function handleFever(c: Ctx): Promise<Response> {
  const params = await collectParams(c);
  const credentials = await loadFeverCredentials(c.env.DB);
  if (!credentials) return c.json({ api_version: API_VERSION, auth: 0 }, 200, NO_STORE);

  const provided = params.get("api_key")?.trim().toLowerCase();
  const expected = md5Hex(`${credentials.username}:${credentials.password}`);
  if (!provided || !/^[0-9a-f]{32}$/.test(provided) || !timingSafeEqualStr(provided, expected)) {
    return c.json({ api_version: API_VERSION, auth: 0 }, 200, NO_STORE);
  }

  const payload: BaseResponse = {
    api_version: API_VERSION,
    auth: 1,
    last_refreshed_on_time: await lastRefreshed(c.env.DB),
  };

  await applyWrite(c.env.DB, params, payload);

  if (params.has("groups") || params.has("feeds")) {
    const library = await loadLibrary(c.env.DB);
    if (params.has("groups")) payload.groups = library.groups;
    if (params.has("feeds")) payload.feeds = library.feeds;
    payload.feeds_groups = library.feedsGroups;
  }
  if (params.has("favicons")) payload.favicons = [];
  if (params.has("items")) {
    const page = await loadItems(c.env.DB, params);
    payload.items = page.items;
    payload.total_items = page.total_items;
  }
  if (params.has("unread_item_ids")) payload.unread_item_ids = await unreadItemIds(c.env.DB);
  if (params.has("saved_item_ids")) payload.saved_item_ids = await savedItemIds(c.env.DB);
  if (params.has("links")) payload.links = [];

  return c.json(payload, 200, NO_STORE);
}

export default fever;
