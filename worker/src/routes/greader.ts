import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth";
import {
  KEPT_UNREAD,
  LABEL_PREFIX,
  READ_TAG,
  READING_LIST,
  STARRED_TAG,
  deriveToken,
  googleLoginToken,
  loadCredentials,
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

export default greader;
