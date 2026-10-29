import { SETTING_KEYS, type GReaderAuth } from "@readly/shared";
import { getSetting } from "./settings";

export const GREADER_LONG_PREFIX = "tag:google.com,2005:reader/item/";
export const READ_TAG = "user/-/state/com.google/read";
export const STARRED_TAG = "user/-/state/com.google/starred";
export const READING_LIST = "user/-/state/com.google/reading-list";
export const KEPT_UNREAD = "user/-/state/com.google/kept-unread";
export const LABEL_PREFIX = "user/-/label/";

export interface GReaderItemRow {
  id: number;
  feed_id: number;
  feed_title: string;
  feed_site_url: string | null;
  category_name: string | null;
  title: string;
  author: string | null;
  url: string | null;
  published_at: string;
  excerpt: string | null;
  content: string | null;
  content_full: string | null;
  is_read: number;
  is_starred: number;
}

export async function loadCredentials(db: D1Database): Promise<GReaderAuth | null> {
  const value = await getSetting<GReaderAuth | null>(db, SETTING_KEYS.greaderAuth, null);
  if (
    !value ||
    typeof value.username !== "string" ||
    !value.username ||
    typeof value.password !== "string" ||
    !value.password
  ) {
    return null;
  }
  return { username: value.username, password: value.password };
}

export async function deriveToken(auth: GReaderAuth): Promise<string> {
  const data = new TextEncoder().encode(`${auth.username}:${auth.password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${auth.username}/${hex}`;
}

export function googleLoginToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^GoogleLogin\s+auth=(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function longItemId(id: number): string {
  return `${GREADER_LONG_PREFIX}${id.toString(16).padStart(16, "0")}`;
}

export function parseItemId(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith(GREADER_LONG_PREFIX)) {
    const hex = value.slice(GREADER_LONG_PREFIX.length);
    if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
    const id = Number.parseInt(hex, 16);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  // 全数字优先按十进制解释(客户端常回传 16 位十进制 ID)
  if (/^\d+$/.test(value)) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  if (/^[0-9a-fA-F]{16}$/.test(value)) {
    const id = Number.parseInt(value, 16);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  return null;
}

export function encodeCursor(publishedAt: string, id: number): string {
  const raw = JSON.stringify({ p: publishedAt, id });
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(raw: string | undefined): { publishedAt: string; id: number } | null {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const value = JSON.parse(atob(padded)) as { p?: unknown; id?: unknown };
    if (typeof value.p !== "string" || typeof value.id !== "number" || !Number.isFinite(value.id)) return null;
    if (Number.isNaN(Date.parse(value.p))) return null;
    return { publishedAt: value.p, id: Math.trunc(value.id) };
  } catch {
    return null;
  }
}

export function unixSeconds(iso: string | null | undefined): number {
  if (!iso) return 0;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

export function isoFromUnix(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toISOString();
}

export function parseIntParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function toGReaderItem(row: GReaderItemRow): Record<string, unknown> {
  const published = unixSeconds(row.published_at);
  const categories = [READING_LIST];
  if (row.is_read === 1) categories.push(READ_TAG);
  if (row.is_starred === 1) categories.push(STARRED_TAG);
  if (row.category_name) categories.push(`${LABEL_PREFIX}${row.category_name}`);
  return {
    id: longItemId(row.id),
    title: row.title,
    author: row.author ?? "",
    published,
    updated: published,
    crawlTimeMsec: String(published * 1000),
    timestampUsec: String(published * 1000000),
    alternate: [{ href: row.url ?? "", type: "text/html" }],
    canonical: [{ href: row.url ?? "" }],
    summary: { direction: "ltr", content: row.excerpt ?? "" },
    content: { direction: "ltr", content: row.content_full ?? row.content ?? row.excerpt ?? "" },
    categories,
    origin: { streamId: `feed/${row.feed_id}`, title: row.feed_title, htmlUrl: row.feed_site_url ?? "" },
  };
}
