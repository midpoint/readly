import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth";
import type { GReaderItemRow } from "../lib/greader";
import {
  KEPT_UNREAD,
  LABEL_PREFIX,
  READ_TAG,
  READING_LIST,
  STARRED_TAG,
  decodeCursor,
  deriveToken,
  encodeCursor,
  googleLoginToken,
  isoFromUnix,
  loadCredentials,
  parseItemId,
  parseIntParam,
  toGReaderItem,
  unixSeconds,
} from "../lib/greader";

const NO_STORE = { "Cache-Control": "no-store" };
const greader = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

export interface MultiParams {
  add(key: string, value: string): void;
  get(key: string): string | undefined;
  getAll(key: string): string[];
}

function createMultiParams(): MultiParams {
  const map = new Map<string, string[]>();
  return {
    add(key, value) {
      const list = map.get(key) ?? [];
      list.push(value);
      map.set(key, list);
    },
    get(key) {
      return map.get(key)?.[0];
    },
    getAll(key) {
      return map.get(key) ?? [];
    },
  };
}

async function collectParams(c: Ctx): Promise<MultiParams> {
  const params = createMultiParams();
  new URL(c.req.url).searchParams.forEach((value, key) => params.add(key, value));
  if (c.req.method === "POST") {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") params.add(key, value);
      }
    } else {
      const form = await c.req.raw.formData().catch(() => null);
      form?.forEach((value, key) => {
        if (typeof value === "string") params.add(key, value);
      });
    }
  }
  return params;
}

greader.use("/reader/*", async (c, next) => {
  const credentials = await loadCredentials(c.env.DB);
  const provided = googleLoginToken(c.req.header("Authorization"));
  if (!credentials || !provided) return c.text("Unauthorized", 401, NO_STORE);
  const expected = await deriveToken(credentials);
  if (!timingSafeEqualStr(provided, expected)) return c.text("Unauthorized", 401, NO_STORE);
  return next();
});

greader.on(["GET", "POST"], "/accounts/ClientLogin", async (c) => {
  const credentials = await loadCredentials(c.env.DB);
  const params = await collectParams(c);
  if (
    !credentials ||
    params.get("Email") !== credentials.username ||
    params.get("Passwd") !== credentials.password
  ) {
    return c.text("Unauthorized", 401, NO_STORE);
  }
  const token = await deriveToken(credentials);
  if (params.get("output") === "json") {
    return c.json({ SID: token, LSID: token, Auth: token }, 200, NO_STORE);
  }
  return c.text(`SID=${token}\nLSID=${token}\nAuth=${token}\n`, 200, NO_STORE);
});

greader.get("/reader/api/0/token", async (c) => {
  const credentials = await loadCredentials(c.env.DB);
  if (!credentials) return c.text("Unauthorized", 401, NO_STORE);
  return c.text(await deriveToken(credentials), 200, NO_STORE);
});

greader.get("/reader/api/0/user-info", async (c) => {
  const credentials = await loadCredentials(c.env.DB);
  if (!credentials) return c.text("Unauthorized", 401, NO_STORE);
  return c.json(
    {
      userId: "1",
      userName: credentials.username,
      userProfileId: "1",
      userEmail: credentials.username,
      isBloggerUser: false,
      signupTimeSec: 0,
      isMultiLoginEnabled: false,
    },
    200,
    NO_STORE
  );
});

function usec(iso: string | null): string {
  const seconds = unixSeconds(iso);
  return seconds > 0 ? String(seconds * 1000000) : "0";
}

greader.get("/reader/api/0/subscription/list", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT f.id, f.url, f.site_url, f.title, f.icon_url, f.category_id, c.name AS category_name
     FROM feeds f LEFT JOIN categories c ON c.id = f.category_id
     ORDER BY f.sort_order, f.id`
  ).all<{
    id: number;
    url: string;
    site_url: string | null;
    title: string;
    icon_url: string | null;
    category_id: number | null;
    category_name: string | null;
  }>();
  return c.json(
    {
      subscriptions: rows.results.map((row) => ({
        id: `feed/${row.id}`,
        title: row.title,
        url: row.url,
        htmlUrl: row.site_url ?? "",
        iconUrl: row.icon_url ?? "",
        categories: row.category_name
          ? [{ id: `${LABEL_PREFIX}${row.category_name}`, label: row.category_name, type: "folder" }]
          : [],
      })),
    },
    200,
    NO_STORE
  );
});

greader.get("/reader/api/0/tag/list", async (c) => {
  const rows = await c.env.DB.prepare("SELECT name FROM categories ORDER BY sort_order, id").all<{ name: string }>();
  return c.json(
    {
      tags: [
        { id: STARRED_TAG },
        { id: READ_TAG },
        { id: READING_LIST },
        { id: KEPT_UNREAD },
        ...rows.results.map((row) => ({ id: `${LABEL_PREFIX}${row.name}`, label: row.name, type: "folder" })),
      ],
    },
    200,
    NO_STORE
  );
});

greader.get("/reader/api/0/unread-count", async (c) => {
  const includeEmpty = c.req.query("all") === "1";
  const feeds = await c.env.DB.prepare(
    `SELECT f.id,
       (SELECT COUNT(*) FROM articles a LEFT JOIN article_states s ON s.article_id = a.id
        WHERE a.feed_id = f.id AND COALESCE(s.is_read, 0) = 0) AS count,
       (SELECT MAX(a.published_at) FROM articles a WHERE a.feed_id = f.id) AS newest
     FROM feeds f ORDER BY f.sort_order, f.id`
  ).all<{ id: number; count: number; newest: string | null }>();
  const labels = await c.env.DB.prepare(
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id = a.feed_id
          LEFT JOIN article_states s ON s.article_id = a.id
        WHERE f.category_id = c.id AND COALESCE(s.is_read, 0) = 0) AS count,
       (SELECT MAX(a.published_at) FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE f.category_id = c.id) AS newest
     FROM categories c ORDER BY c.sort_order, c.id`
  ).all<{ id: number; name: string; count: number; newest: string | null }>();
  const totals = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM articles a LEFT JOIN article_states s ON s.article_id = a.id
        WHERE COALESCE(s.is_read, 0) = 0) AS unread,
       (SELECT MAX(published_at) FROM articles) AS newest`
  ).first<{ unread: number; newest: string | null }>();

  const unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[] = [];
  for (const feed of feeds.results) {
    if (includeEmpty || feed.count > 0) {
      unreadcounts.push({ id: `feed/${feed.id}`, count: feed.count, newestItemTimestampUsec: usec(feed.newest) });
    }
  }
  for (const label of labels.results) {
    if (includeEmpty || label.count > 0) {
      unreadcounts.push({
        id: `${LABEL_PREFIX}${label.name}`,
        count: label.count,
        newestItemTimestampUsec: usec(label.newest),
      });
    }
  }
  unreadcounts.push({
    id: READING_LIST,
    count: totals?.unread ?? 0,
    newestItemTimestampUsec: usec(totals?.newest ?? null),
  });
  return c.json({ max: totals?.unread ?? 0, unreadcounts }, 200, NO_STORE);
});

interface StreamFilter {
  empty?: boolean;
  feedId?: number;
  categoryName?: string;
  starred?: boolean;
}

function parseStream(raw: string): StreamFilter {
  const stream = raw.trim();
  if (stream === READING_LIST || stream === READ_TAG || stream === KEPT_UNREAD) return {};
  if (stream === STARRED_TAG) return { starred: true };
  if (stream.startsWith("feed/")) {
    const id = Number(stream.slice("feed/".length));
    return Number.isInteger(id) && id > 0 ? { feedId: id } : { empty: true };
  }
  if (stream.startsWith(LABEL_PREFIX)) return { categoryName: stream.slice(LABEL_PREFIX.length) };
  return { empty: true };
}

const ITEM_SELECT = `
  SELECT a.id, a.feed_id, f.title AS feed_title, f.site_url AS feed_site_url,
         c.name AS category_name, a.title, a.author, a.url, a.published_at,
         a.excerpt, a.content, a.content_full,
         COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred
  FROM articles a
  JOIN feeds f ON f.id = a.feed_id
  LEFT JOIN categories c ON c.id = f.category_id
  LEFT JOIN article_states s ON s.article_id = a.id`;

function streamLimit(params: MultiParams): number {
  return parseIntParam(params.get("n"), 20, 1, 1000);
}

function isAscending(params: MultiParams): boolean {
  return params.get("r") === "o";
}

function buildStreamWhere(
  stream: StreamFilter,
  params: MultiParams,
  cursor: { publishedAt: string; id: number } | null,
  ascending: boolean
): { where: string[]; binds: (string | number)[] } {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (stream.empty) where.push("0");
  if (stream.feedId !== undefined) {
    where.push("a.feed_id = ?");
    binds.push(stream.feedId);
  }
  if (stream.categoryName !== undefined) {
    where.push("c.name = ?");
    binds.push(stream.categoryName);
  }
  if (stream.starred) where.push("COALESCE(s.is_starred, 0) = 1");
  if (params.getAll("it").includes(READ_TAG)) where.push("COALESCE(s.is_read, 0) = 1");
  if (params.getAll("it").includes(STARRED_TAG)) where.push("COALESCE(s.is_starred, 0) = 1");
  if (params.getAll("xt").includes(READ_TAG)) where.push("COALESCE(s.is_read, 0) = 0");
  if (params.getAll("xt").includes(STARRED_TAG)) where.push("COALESCE(s.is_starred, 0) = 0");
  const ot = parseIntParam(params.get("ot"), 0, 0, 253402300799);
  const otIso = ot > 0 ? isoFromUnix(ot) : null;
  if (otIso) {
    where.push("a.published_at < ?");
    binds.push(otIso);
  }
  const nt = parseIntParam(params.get("nt"), 0, 0, 253402300799);
  const ntIso = nt > 0 ? isoFromUnix(nt) : null;
  if (ntIso) {
    where.push("a.published_at > ?");
    binds.push(ntIso);
  }
  if (cursor) {
    const op = ascending ? ">" : "<";
    where.push(`(a.published_at ${op} ? OR (a.published_at = ? AND a.id ${op} ?))`);
    binds.push(cursor.publishedAt, cursor.publishedAt, cursor.id);
  }
  return { where, binds };
}

greader.get("/reader/api/0/stream/items/ids", async (c) => {
  const params = await collectParams(c);
  const streamId = params.get("s");
  if (!streamId) return c.json({ itemRefs: [] }, 200, NO_STORE);
  const stream = parseStream(streamId);
  const limit = streamLimit(params);
  const ascending = isAscending(params);
  const cursor = decodeCursor(params.get("c"));
  const { where, binds } = buildStreamWhere(stream, params, cursor, ascending);
  const order = ascending ? "ASC" : "DESC";
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.published_at FROM articles a
     JOIN feeds f ON f.id = a.feed_id
     LEFT JOIN categories c ON c.id = f.category_id
     LEFT JOIN article_states s ON s.article_id = a.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.published_at ${order}, a.id ${order}
     LIMIT ?`
  )
    .bind(...binds, limit + 1)
    .all<{ id: number; published_at: string }>();
  const hasMore = rows.results.length > limit;
  const pageRows = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = pageRows[pageRows.length - 1];
  const payload: { itemRefs: { id: string }[]; continuation?: string } = {
    itemRefs: pageRows.map((row) => ({ id: String(row.id) })),
  };
  if (hasMore && last) payload.continuation = encodeCursor(last.published_at, last.id);
  return c.json(payload, 200, NO_STORE);
});

greader.on(["GET", "POST"], "/reader/api/0/stream/contents/*", async (c) => {
  const params = await collectParams(c);
  const prefix = "/reader/api/0/stream/contents/";
  const rawStream = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : params.get("s") ?? "";
  let streamId: string;
  try {
    streamId = decodeURIComponent(rawStream);
  } catch {
    streamId = rawStream;
  }
  const stream = parseStream(streamId);
  const limit = streamLimit(params);
  const ascending = isAscending(params);
  const cursor = decodeCursor(params.get("c"));
  const { where, binds } = buildStreamWhere(stream, params, cursor, ascending);
  const order = ascending ? "ASC" : "DESC";
  const rows = await c.env.DB.prepare(
    `${ITEM_SELECT}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.published_at ${order}, a.id ${order}
     LIMIT ?`
  )
    .bind(...binds, limit + 1)
    .all<GReaderItemRow>();
  const hasMore = rows.results.length > limit;
  const pageRows = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = pageRows[pageRows.length - 1];
  const payload: Record<string, unknown> = {
    id: streamId,
    updated: Math.floor(Date.now() / 1000),
    items: pageRows.map(toGReaderItem),
  };
  if (hasMore && last) payload.continuation = encodeCursor(last.published_at, last.id);
  return c.json(payload, 200, NO_STORE);
});

greader.on(["GET", "POST"], "/reader/api/0/stream/items/contents", async (c) => {
  const params = await collectParams(c);
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of params.getAll("i")) {
    const id = parseItemId(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 1000) break;
  }
  if (ids.length === 0) return c.json({ items: [] }, 200, NO_STORE);
  // 用 json_each 传数组,规避 D1 单条 SQL 100 个绑定参数的限制(支持一次取 1000 条)
  const rows = await c.env.DB.prepare(`${ITEM_SELECT} WHERE a.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<GReaderItemRow>();
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  return c.json(
    {
      items: ids
        .map((id) => byId.get(id))
        .filter((row): row is GReaderItemRow => row !== undefined)
        .map(toGReaderItem),
    },
    200,
    NO_STORE
  );
});

export default greader;
