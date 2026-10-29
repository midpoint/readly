# Google Reader API 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Readly 增加 Google Reader API 兼容层,使 Reeder / FeedMe / NewsFlash 等客户端可完成登录、订阅列表、文章同步以及已读/收藏双向标记。

**Architecture:** 新增独立 Hono 子应用 `worker/src/routes/greader.ts`,挂载在根路径下的 `/accounts/*` 与 `/reader/api/0/*`;纯函数(token 派生、ID 解析/格式化、游标、item 映射)放在 `worker/src/lib/greader.ts`。凭据存 D1 `settings.greader_auth`(设置页生成独立密码),请求以 `Authorization: GoogleLogin auth=<username>/<sha256>` 认证。前端新增 `GoogleReaderSettings.vue` 区块,复用现有 `/api/settings` 通道。

**Tech Stack:** Cloudflare Workers + Hono + D1 + Web Crypto(SHA-256);Vue 3 + Pinia + Tailwind;vitest(`@cloudflare/vitest-pool-workers` 与 jsdom)。

## Global Constraints

- 不新增运行时依赖;不新增数据库迁移(复用 `settings` 表)。
- 端点契约以 `docs/superpowers/specs/2026-10-29-google-reader-api-design.md` 为准;`/reader/*` 鉴权失败必须 401,`Cache-Control: no-store`。
- 仅 JSON(`ClientLogin` 的 `output=json` 除外);`output=xml` 忽略。
- 所有时间戳:秒为整数,毫秒/微秒为字符串。
- 深浅色 Tailwind 类名必须成对声明(`dark:` 前缀)。
- 提交信息末尾固定附加:`Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- **所有命令在仓库根 `/home/mj/aicode/readly` 执行**;当前目录不是仓库根时先 `cd /home/mj/aicode/readly`(否则 `pnpm -C worker` 与 `git add shared/...` 都会找错位置)。
- 聚焦测试命令用 `pnpm -C worker exec vitest run <path>` / `pnpm -C web exec vitest run <path>`(不要用 `pnpm -- <path>` 形式)。
- worker 测试依赖 `web/dist` 存在;若缺失先 `pnpm build`。

---

### Task 1: 共享契约 + GReader 纯函数库

**Files:**
- Modify: `shared/src/index.ts`(在 `SETTING_KEYS` 前后追加)
- Create: `worker/src/lib/greader.ts`
- Test: `worker/test/greader-lib.test.ts`

**Interfaces:**
- Produces:
  - `GReaderAuth { username: string; password: string }`
  - `GREADER_USERNAME = "readly"`
  - `SETTING_KEYS.greaderAuth = "greader_auth"`
  - `loadCredentials(db: D1Database): Promise<GReaderAuth | null>`
  - `deriveToken(auth: GReaderAuth): Promise<string>` → `"<username>/<sha256 hex>"`
  - `googleLoginToken(header: string | undefined): string | null`
  - `longItemId(id: number): string`
  - `parseItemId(raw: string): number | null`
  - `encodeCursor(publishedAt: string, id: number): string`
  - `decodeCursor(raw: string | undefined): { publishedAt: string; id: number } | null`
  - `unixSeconds(iso: string | null | undefined): number`
  - `isoFromUnix(seconds: number): string | null`
  - `parseIntParam(raw: string | undefined, fallback: number, min: number, max: number): number`
  - `toGReaderItem(row: GReaderItemRow): Record<string, unknown>`
  - `GReaderItemRow` 字段:`id, feed_id, feed_title, feed_site_url, category_name, title, author, url, published_at, excerpt, content, content_full, is_read, is_starred`
  - 常量:`READING_LIST`, `READ_TAG`, `STARRED_TAG`, `KEPT_UNREAD`, `LABEL_PREFIX`, `GREADER_LONG_PREFIX`

- [ ] **Step 1: 在 shared 中写入契约**

在 `shared/src/index.ts` 的 `SETTING_KEYS` 之前加入:

```ts
export interface GReaderAuth {
  username: string;
  password: string;
}

export const GREADER_USERNAME = "readly";
```

并在 `SETTING_KEYS` 对象内追加一行:

```ts
  greaderAuth: "greader_auth",
```

- [ ] **Step 2: 写失败的单元测试**

Create `worker/test/greader-lib.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  READ_TAG,
  READING_LIST,
  STARRED_TAG,
  decodeCursor,
  deriveToken,
  encodeCursor,
  isoFromUnix,
  longItemId,
  parseItemId,
  parseIntParam,
  toGReaderItem,
  unixSeconds,
  type GReaderItemRow,
} from "../src/lib/greader";

describe("parseItemId", () => {
  it("解析长格式、16 位 hex、十进制", () => {
    expect(parseItemId("tag:google.com,2005:reader/item/000000000000002a")).toBe(42);
    expect(parseItemId("000000000000002a")).toBe(42);
    expect(parseItemId("42")).toBe(42);
    // 全数字串按十进制处理,避免 16 位十进制 ID 被误判为 hex
    expect(parseItemId("1746307865812560")).toBe(1746307865812560);
    expect(parseItemId("0000000000000010")).toBe(10);
  });
  it("非法/非正返回 null", () => {
    expect(parseItemId("")).toBeNull();
    expect(parseItemId("abc")).toBeNull();
    expect(parseItemId("0")).toBeNull();
    expect(parseItemId("-1")).toBeNull();
    expect(parseItemId("tag:google.com,2005:reader/item/zz")).toBeNull();
  });
});

describe("longItemId", () => {
  it("16 位小写 hex 左补零", () => {
    expect(longItemId(42)).toBe("tag:google.com,2005:reader/item/000000000000002a");
    expect(longItemId(31)).toBe("tag:google.com,2005:reader/item/000000000000001f");
  });
});

describe("cursor", () => {
  it("往返", () => {
    const cursor = encodeCursor("2026-10-01T00:00:01.000Z", 7);
    expect(decodeCursor(cursor)).toEqual({ publishedAt: "2026-10-01T00:00:01.000Z", id: 7 });
  });
  it("非法返回 null", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    const bad = btoa(JSON.stringify({ p: "nope", id: 1 })).replace(/=+$/, "");
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe("deriveToken", () => {
  it("sha256(username:password)", async () => {
    expect(await deriveToken({ username: "readly", password: "secret" })).toBe(
      "readly/1eacdaa8570b440467416a15bc1c48300bab00f75cd582e2f8de265317c1c5df"
    );
  });
});

describe("时间与数字参数", () => {
  it("unixSeconds", () => {
    expect(unixSeconds("2026-10-01T00:00:01.000Z")).toBe(1790812801);
    expect(unixSeconds(null)).toBe(0);
    expect(unixSeconds("nope")).toBe(0);
  });
  it("isoFromUnix 拒绝非法范围", () => {
    expect(isoFromUnix(1790812801)).toBe("2026-10-01T00:00:01.000Z");
    expect(isoFromUnix(0)).toBeNull();
    expect(isoFromUnix(1e18)).toBeNull();
  });
  it("parseIntParam 截断与钳制", () => {
    expect(parseIntParam(undefined, 20, 1, 1000)).toBe(20);
    expect(parseIntParam("abc", 20, 1, 1000)).toBe(20);
    expect(parseIntParam("0", 20, 1, 1000)).toBe(1);
    expect(parseIntParam("5000", 20, 1, 1000)).toBe(1000);
    expect(parseIntParam("7.9", 20, 1, 1000)).toBe(7);
  });
});

describe("toGReaderItem", () => {
  const base: GReaderItemRow = {
    id: 42,
    feed_id: 3,
    feed_title: "源标题",
    feed_site_url: "https://site.example.com",
    category_name: "科技",
    title: "文章标题",
    author: null,
    url: "https://site.example.com/post",
    published_at: "2026-10-01T00:00:01.000Z",
    excerpt: "摘要",
    content: "<p>正文</p>",
    content_full: "<p>全文</p>",
    is_read: 1,
    is_starred: 1,
  };

  it("完整形状与标签", () => {
    expect(toGReaderItem(base)).toEqual({
      id: "tag:google.com,2005:reader/item/000000000000002a",
      title: "文章标题",
      author: "",
      published: 1790812801,
      updated: 1790812801,
      crawlTimeMsec: "1790812801000",
      timestampUsec: "1790812801000000",
      alternate: [{ href: "https://site.example.com/post", type: "text/html" }],
      canonical: [{ href: "https://site.example.com/post" }],
      summary: { direction: "ltr", content: "摘要" },
      content: { direction: "ltr", content: "<p>全文</p>" },
      categories: [READING_LIST, READ_TAG, STARRED_TAG, "user/-/label/科技"],
      origin: { streamId: "feed/3", title: "源标题", htmlUrl: "https://site.example.com" },
    });
  });

  it("content 回退顺序 content_full → content → excerpt", () => {
    const noFull = toGReaderItem({ ...base, content_full: null });
    expect((noFull.content as { content: string }).content).toBe("<p>正文</p>");
    const excerptOnly = toGReaderItem({ ...base, content_full: null, content: null });
    expect((excerptOnly.content as { content: string }).content).toBe("摘要");
  });

  it("未读未收藏无分类", () => {
    const item = toGReaderItem({ ...base, is_read: 0, is_starred: 0, category_name: null });
    expect(item.categories).toEqual([READING_LIST]);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm -C worker exec vitest run test/greader-lib.test.ts`
Expected: FAIL — 无法解析 `../src/lib/greader`。

- [ ] **Step 4: 实现库文件**

Create `worker/src/lib/greader.ts`:

```ts
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm -C worker exec vitest run test/greader-lib.test.ts`
Expected: PASS(全部用例)。

Run: `pnpm -C worker run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add shared/src/index.ts worker/src/lib/greader.ts worker/test/greader-lib.test.ts
git commit -m "feat: GReader 共享契约与纯函数库

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: GReader 认证端点、路由与部署配置

**Files:**
- Create: `worker/src/routes/greader.ts`
- Modify: `worker/src/index.ts:1-31`
- Modify: `worker/wrangler.toml:9`
- Test: `worker/test/greader.test.ts`(新建,含认证用例)

**Interfaces:**
- Consumes: Task 1 的 `loadCredentials`、`deriveToken`、`googleLoginToken`、`GREADER_USERNAME`、`SETTING_KEYS.greaderAuth`。
- Produces:
  - `const greader: Hono<{ Bindings: Env }>`(default export)
  - `GET|POST /accounts/ClientLogin`
  - `GET /reader/api/0/token`
  - `GET /reader/api/0/user-info`
  - 内部 `collectParams(c): Promise<MultiParams>`(Task 3/4/5 复用)

- [ ] **Step 1: 更新部署路由白名单**

把 `worker/wrangler.toml` 第 9 行替换为:

```toml
run_worker_first = ["/api/*", "/accounts", "/accounts/*", "/reader", "/reader/*"]
```

- [ ] **Step 2: 写失败的认证集成测试**

Create `worker/test/greader.test.ts`:

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GREADER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { deriveToken } from "../src/lib/greader";
import { putSetting } from "../src/lib/settings";

const PASSWORD = "0123456789abcdef0123456789abcdef";
let token = "";

async function enable(): Promise<string> {
  await putSetting(env.DB, SETTING_KEYS.greaderAuth, { username: GREADER_USERNAME, password: PASSWORD });
  token = await deriveToken({ username: GREADER_USERNAME, password: PASSWORD });
  return token;
}

function loginBody(output?: string): URLSearchParams {
  const body = new URLSearchParams({ Email: GREADER_USERNAME, Passwd: PASSWORD });
  if (output) body.set("output", output);
  return body;
}

async function clientLogin(body: URLSearchParams): Promise<Response> {
  return SELF.fetch("http://example.com/accounts/ClientLogin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function authed(path: string, opts: { method?: string; body?: URLSearchParams } = {}): Promise<Response> {
  return SELF.fetch(`http://example.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `GoogleLogin auth=${token}`,
      ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: opts.body?.toString(),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
  token = "";
});

describe("ClientLogin", () => {
  it("正确凭据返回三行文本令牌", async () => {
    const expected = await enable();
    const res = await clientLogin(loginBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe(`SID=${expected}\nLSID=${expected}\nAuth=${expected}\n`);
  });

  it("output=json 返回 JSON 令牌", async () => {
    const expected = await enable();
    const res = await clientLogin(loginBody("json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ SID: expected, LSID: expected, Auth: expected });
  });

  it("GET 查询参数同样可用", async () => {
    const expected = await enable();
    const url = new URL("http://example.com/accounts/ClientLogin");
    url.search = loginBody().toString();
    const res = await SELF.fetch(url.toString());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Auth=${expected}`);
  });

  it("错误密码与未配置均 401", async () => {
    await enable();
    const wrong = new URLSearchParams({ Email: GREADER_USERNAME, Passwd: "wrong" });
    expect((await clientLogin(wrong)).status).toBe(401);
    await env.DB.exec("DELETE FROM settings");
    expect((await clientLogin(loginBody())).status).toBe(401);
  });
});

describe("令牌与用户信息", () => {
  it("token 端点返回同一令牌", async () => {
    const expected = await enable();
    const res = await authed("/reader/api/0/token");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expected);
  });

  it("user-info 返回标准字段", async () => {
    await enable();
    const res = await authed("/reader/api/0/user-info");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: "1",
      userName: GREADER_USERNAME,
      userProfileId: "1",
      userEmail: GREADER_USERNAME,
    });
  });

  it("缺失/错误 / 非 GoogleLogin 头均 401", async () => {
    await enable();
    expect((await SELF.fetch("http://example.com/reader/api/0/user-info")).status).toBe(401);
    const wrong = await SELF.fetch("http://example.com/reader/api/0/user-info", {
      headers: { Authorization: "GoogleLogin auth=readly/deadbeef" },
    });
    expect(wrong.status).toBe(401);
    const bearer = await SELF.fetch("http://example.com/reader/api/0/user-info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bearer.status).toBe(401);
  });

  it("/api/* 仍受 AUTH_TOKEN 保护", async () => {
    await enable();
    expect((await SELF.fetch("http://example.com/api/articles")).status).toBe(401);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: FAIL — 请求返回 404/index.html,认证用例不通过。

- [ ] **Step 4: 实现路由骨架与认证**

Create `worker/src/routes/greader.ts`:

```ts
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth";
import { deriveToken, googleLoginToken, loadCredentials } from "../lib/greader";

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

export default greader;
```

- [ ] **Step 5: 挂载子应用**

Modify `worker/src/index.ts`: 在 import 区追加:

```ts
import greader from "./routes/greader";
```

在 `app.route("/api", proxy);` 之后、`app.notFound(...)` 之前追加:

```ts
app.route("/", greader);
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm build && pnpm -C worker exec vitest run test/greader.test.ts`
Expected: PASS(认证 8 个用例)。

Run: `pnpm -C worker run typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add worker/src/routes/greader.ts worker/src/index.ts worker/wrangler.toml worker/test/greader.test.ts
git commit -m "feat: GReader 认证端点与路由

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 订阅列表、标签与未读计数

**Files:**
- Modify: `worker/src/routes/greader.ts`(追加 import 与 3 个处理器)
- Test: `worker/test/greader.test.ts`(追加 describe)

**Interfaces:**
- Consumes: `KEPT_UNREAD`、`LABEL_PREFIX`、`READING_LIST`、`READ_TAG`、`STARRED_TAG`、`unixSeconds`。
- Produces:
  - `GET /reader/api/0/subscription/list`
  - `GET /reader/api/0/tag/list`
  - `GET /reader/api/0/unread-count`

- [ ] **Step 1: 追加失败的测试**

在 `worker/test/greader.test.ts` 末尾追加:

```ts
async function seedLibrary(): Promise<{ categoryId: number; emptyCategoryId: number; feedA: number; feedB: number; feedC: number }> {
  const category = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES ('科技', 1)").run();
  const empty = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES ('空分类', 2)").run();
  const categoryId = Number(category.meta.last_row_id);
  const feedA = await env.DB.prepare(
    "INSERT INTO feeds (url, title, site_url, icon_url, category_id, sort_order, last_fetched_at) VALUES ('https://a.example.com/rss', '源A', 'https://a.example.com', 'https://a.example.com/icon.png', ?, 1, '2026-10-01T00:00:00.000Z')"
  ).bind(categoryId).run();
  const feedB = await env.DB.prepare(
    "INSERT INTO feeds (url, title, category_id, sort_order) VALUES ('https://b.example.com/rss', '源B', ?, 2)"
  ).bind(categoryId).run();
  const feedC = await env.DB.prepare(
    "INSERT INTO feeds (url, title, sort_order) VALUES ('https://c.example.com/rss', '源C', 3)"
  ).run();
  return {
    categoryId,
    emptyCategoryId: Number(empty.meta.last_row_id),
    feedA: Number(feedA.meta.last_row_id),
    feedB: Number(feedB.meta.last_row_id),
    feedC: Number(feedC.meta.last_row_id),
  };
}

async function insertArticle(feedId: number, guid: string, publishedAt: string): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO articles (feed_id, guid, title, published_at) VALUES (?, ?, ?, ?)"
  ).bind(feedId, guid, `文章 ${guid}`, publishedAt).run();
  return Number(result.meta.last_row_id);
}

describe("订阅列表、标签与未读计数", () => {
  it("subscription/list 含分类与未分类", async () => {
    await enable();
    const ids = await seedLibrary();
    const res = await authed("/reader/api/0/subscription/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: Record<string, unknown>[] };
    expect(body.subscriptions).toEqual([
      {
        id: `feed/${ids.feedA}`,
        title: "源A",
        url: "https://a.example.com/rss",
        htmlUrl: "https://a.example.com",
        iconUrl: "https://a.example.com/icon.png",
        categories: [{ id: "user/-/label/科技", label: "科技", type: "folder" }],
      },
      {
        id: `feed/${ids.feedB}`,
        title: "源B",
        url: "https://b.example.com/rss",
        htmlUrl: "",
        iconUrl: "",
        categories: [{ id: "user/-/label/科技", label: "科技", type: "folder" }],
      },
      {
        id: `feed/${ids.feedC}`,
        title: "源C",
        url: "https://c.example.com/rss",
        htmlUrl: "",
        iconUrl: "",
        categories: [],
      },
    ]);
  });

  it("tag/list 含四个系统标签与分类 label", async () => {
    await enable();
    await seedLibrary();
    const body = (await (await authed("/reader/api/0/tag/list")).json()) as { tags: Record<string, unknown>[] };
    expect(body.tags).toEqual([
      { id: "user/-/state/com.google/starred" },
      { id: "user/-/state/com.google/read" },
      { id: "user/-/state/com.google/reading-list" },
      { id: "user/-/state/com.google/kept-unread" },
      { id: "user/-/label/科技", label: "科技", type: "folder" },
      { id: "user/-/label/空分类", label: "空分类", type: "folder" },
    ]);
  });

  it("unread-count 统计 feed/label/reading-list,all=1 含零未读", async () => {
    await enable();
    const ids = await seedLibrary();
    const a1 = await insertArticle(ids.feedA, "a1", "2026-10-01T00:00:01.000Z");
    const a2 = await insertArticle(ids.feedA, "a2", "2026-10-01T00:00:02.000Z");
    await insertArticle(ids.feedB, "b1", "2026-10-01T00:00:03.000Z");
    await insertArticle(ids.feedC, "c1", "2026-10-01T00:00:04.000Z");
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read) VALUES (?, 1)").bind(a1).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read) VALUES (?, 1)").bind(a2).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read) VALUES (?, 1)").bind(
      (await env.DB.prepare("SELECT id FROM articles WHERE guid = 'b1'").first<{ id: number }>())!.id
    ).run();

    const normal = (await (await authed("/reader/api/0/unread-count")).json()) as {
      max: number;
      unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[];
    };
    expect(normal.max).toBe(1);
    expect(normal.unreadcounts).toEqual([
      { id: `feed/${ids.feedC}`, count: 1, newestItemTimestampUsec: "1790812804000000" },
      { id: "user/-/state/com.google/reading-list", count: 1, newestItemTimestampUsec: "1790812804000000" },
    ]);

    const withAll = (await (await authed("/reader/api/0/unread-count?all=1")).json()) as {
      unreadcounts: { id: string; count: number }[];
    };
    expect(withAll.unreadcounts).toEqual([
      { id: `feed/${ids.feedA}`, count: 0, newestItemTimestampUsec: "1790812802000000" },
      { id: `feed/${ids.feedB}`, count: 0, newestItemTimestampUsec: "1790812803000000" },
      { id: `feed/${ids.feedC}`, count: 1, newestItemTimestampUsec: "1790812804000000" },
      { id: "user/-/label/科技", count: 0, newestItemTimestampUsec: "1790812803000000" },
      { id: "user/-/label/空分类", count: 0, newestItemTimestampUsec: "0" },
      { id: "user/-/state/com.google/reading-list", count: 1, newestItemTimestampUsec: "1790812804000000" },
    ]);
  });
});
```

注:`unread-count` 普通模式只输出 `count > 0` 的 feed 与 label,因此科技(label 计数为 0)与空分类都不出现;`all=1` 时全部输出。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: FAIL — 三个端点 404。

- [ ] **Step 3: 实现三个端点**

在 `worker/src/routes/greader.ts` 中把现有的 `from "../lib/greader"` 导入整段替换为:

```ts
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
```

在 `export default greader;` 之前插入:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add worker/src/routes/greader.ts worker/test/greader.test.ts
git commit -m "feat: GReader 订阅列表、标签与未读计数

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 文章流端点(ids / contents / items contents)

**Files:**
- Modify: `worker/src/routes/greader.ts`(追加 import、查询构造与 3 个处理器)
- Test: `worker/test/greader.test.ts`(追加 describe)

**Interfaces:**
- Consumes: `READ_TAG`、`STARRED_TAG`、`READING_LIST`、`KEPT_UNREAD`、`LABEL_PREFIX`、`ITEM_SELECT`、`GReaderItemRow`、`decodeCursor`、`encodeCursor`、`isoFromUnix`、`parseIntParam`、`parseItemId`、`toGReaderItem`。
- Produces:
  - `GET /reader/api/0/stream/items/ids`
  - `GET|POST /reader/api/0/stream/items/contents`(用 `json_each(?)` 规避 D1 100 绑定参数上限)
  - `GET|POST /reader/api/0/stream/contents/*`
  - 内部 `parseStream(raw): StreamFilter`、`buildStreamWhere(...)`、`streamLimit(params)`、`isAscending(params)`

- [ ] **Step 1: 追加失败的测试**

在 `worker/test/greader.test.ts` 末尾追加:

```ts
async function seedManyArticles(count = 120): Promise<{ feedId: number; ids: number[] }> {
  const feed = await env.DB.prepare(
    "INSERT INTO feeds (url, title) VALUES ('https://many.example.com/rss', '批量源')"
  ).run();
  const feedId = Number(feed.meta.last_row_id);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i += 1) {
    const publishedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    statements.push(
      env.DB.prepare(
        "INSERT INTO articles (feed_id, guid, title, url, author, published_at, excerpt, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        feedId,
        `g${i}`,
        `文章${i}`,
        `https://many.example.com/${i}`,
        i === 0 ? null : `作者${i}`,
        publishedAt,
        `摘要${i}`,
        `<p>正文${i}</p>`
      )
    );
  }
  const results: D1Result<unknown>[] = [];
  for (let start = 0; start < statements.length; start += 50) {
    results.push(...(await env.DB.batch(statements.slice(start, start + 50))));
  }
  return { feedId, ids: results.map((result) => Number(result.meta.last_row_id)) };
}

describe("文章流", () => {
  it("items/ids:默认最新优先、r=o 升序、n 上限、continuation 往返", async () => {
    await enable();
    const { feedId, ids } = await seedManyArticles();
    const page1 = (await (
      await authed(`/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=10`)
    ).json()) as { itemRefs: { id: string }[]; continuation?: string };
    expect(page1.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(-10).reverse());
    expect(page1.continuation).toBeTruthy();

    const page2 = (await (
      await authed(
        `/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=10&c=${encodeURIComponent(page1.continuation!)}`
      )
    ).json()) as { itemRefs: { id: string }[] };
    expect(page2.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(-20, -10).reverse());

    const oldest = (await (
      await authed(`/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=5&r=o`)
    ).json()) as { itemRefs: { id: string }[] };
    expect(oldest.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(0, 5));

    const feedStream = (await (
      await authed(`/reader/api/0/stream/items/ids?s=feed/${feedId}&n=3`)
    ).json()) as { itemRefs: { id: string }[] };
    expect(feedStream.itemRefs).toHaveLength(3);
  });

  it("items/ids:xt/it/ot/nt 过滤与未知流", async () => {
    await enable();
    const { ids } = await seedManyArticles(5);
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 1, 1)").bind(ids[0]).run();
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, is_starred) VALUES (?, 0, 1)").bind(ids[1]).run();

    const unread = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&xt=user/-/state/com.google/read&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(unread.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(1));

    const starred = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/starred&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(starred.itemRefs.map((ref) => Number(ref.id))).toEqual([ids[0], ids[1]]);

    const readOnly = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&it=user/-/state/com.google/read&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(readOnly.itemRefs.map((ref) => Number(ref.id))).toEqual([ids[0]]);

    const olderThan = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&ot=1767225603&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(olderThan.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(0, 3));

    const newerThan = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&nt=1767225603&r=o")
    ).json()) as { itemRefs: { id: string }[] };
    expect(newerThan.itemRefs.map((ref) => Number(ref.id))).toEqual(ids.slice(4));

    const unknown = (await (
      await authed("/reader/api/0/stream/items/ids?s=user/-/state/com.google/broadcast")
    ).json()) as { itemRefs: unknown[] };
    expect(unknown.itemRefs).toEqual([]);
  });

  it("stream/contents 路径流、item 形状与分页", async () => {
    await enable();
    const { feedId, ids } = await seedManyArticles(3);
    await env.DB.prepare("UPDATE articles SET content_full = '<p>全文0</p>' WHERE id = ?").bind(ids[0]).run();
    await env.DB.prepare("UPDATE articles SET content = NULL WHERE id = ?").bind(ids[1]).run();

    const body = (await (
      await authed("/reader/api/0/stream/contents/feed/" + feedId + "?r=o")
    ).json()) as { id: string; updated: number; items: Record<string, unknown>[] };
    expect(body.id).toBe(`feed/${feedId}`);
    expect(typeof body.updated).toBe("number");
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({
      id: "tag:google.com,2005:reader/item/" + ids[0]!.toString(16).padStart(16, "0"),
      title: "文章0",
      author: "",
      url: "https://many.example.com/0",
      published: 1767225600,
      updated: 1767225600,
      crawlTimeMsec: "1767225600000",
      timestampUsec: "1767225600000000",
      alternate: [{ href: "https://many.example.com/0", type: "text/html" }],
      canonical: [{ href: "https://many.example.com/0" }],
      summary: { direction: "ltr", content: "摘要0" },
      content: { direction: "ltr", content: "<p>全文0</p>" },
      categories: ["user/-/state/com.google/reading-list"],
      origin: { streamId: `feed/${feedId}`, title: "批量源", htmlUrl: "" },
    });
    expect((body.items[1]!.content as { content: string }).content).toBe("摘要1");

    const page1 = (await (
      await authed(`/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=2`)
    ).json()) as { items: Record<string, unknown>[]; continuation?: string };
    expect(page1.items).toHaveLength(2);
    expect(page1.continuation).toBeTruthy();
    const page2 = (await (
      await authed(
        `/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=2&c=${encodeURIComponent(page1.continuation!)}`
      )
    ).json()) as { items: Record<string, unknown>[] };
    expect(page2.items).toHaveLength(1);
  });

  it("stream/items/contents 支持长格式与十进制、保持顺序", async () => {
    await enable();
    const { ids } = await seedManyArticles(3);
    const long = `tag:google.com,2005:reader/item/${ids[2]!.toString(16).padStart(16, "0")}`;
    const body = new URLSearchParams();
    body.append("i", long);
    body.append("i", String(ids[1]));
    body.append("i", String(ids[0]));
    body.append("i", "999999");
    const res = await authed("/reader/api/0/stream/items/contents", { method: "POST", body });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { items: { id: string; title: string }[] };
    expect(payload.items.map((item) => item.title)).toEqual(["文章2", "文章1", "文章0"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: FAIL — 三个流端点 404。

- [ ] **Step 3: 实现流查询与端点**

在 `worker/src/routes/greader.ts` 中把现有的 `from "../lib/greader"` 导入整段替换为以下两段:

```ts
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
```

在 `export default greader;` 之前插入:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: PASS(含新增 4 个流用例)。

- [ ] **Step 5: 提交**

```bash
git add worker/src/routes/greader.ts worker/test/greader.test.ts
git commit -m "feat: GReader 文章流端点

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 写操作(edit-tag / mark-all-as-read)

**Files:**
- Modify: `worker/src/routes/greader.ts`(追加 4 个辅助函数与 2 个处理器)
- Test: `worker/test/greader.test.ts`(追加 describe)

**Interfaces:**
- Consumes: `READ_TAG`、`STARRED_TAG`、`parseItemId`、`parseStream`。
- Produces:
  - `POST /reader/api/0/edit-tag`(批量写入用 `json_each(?)`,支持最多 1000 个 ID)
  - `POST /reader/api/0/mark-all-as-read`
  - `upsertReadState(db, ids, read)`、`upsertStarredState(db, ids, starred)`

- [ ] **Step 1: 追加失败的测试**

先把 `worker/test/greader.test.ts` 顶部已有的导入行:

```ts
import { deriveToken } from "../src/lib/greader";
```

替换为:

```ts
import { READ_TAG, STARRED_TAG, deriveToken } from "../src/lib/greader";
```

再在文件末尾追加:

```ts
async function stateOf(id: number): Promise<{ is_read: number; is_starred: number } | null> {
  return env.DB.prepare("SELECT is_read, is_starred FROM article_states WHERE article_id = ?")
    .bind(id)
    .first<{ is_read: number; is_starred: number }>();
}

describe("写操作", () => {
  it("edit-tag 批量已读/未读,保留收藏", async () => {
    await enable();
    const { ids } = await seedManyArticles(3);
    await env.DB.prepare("INSERT INTO article_states (article_id, is_starred, starred_at) VALUES (?, 1, '2026-10-01T00:00:00.000Z')")
      .bind(ids[0])
      .run();

    const readBody = new URLSearchParams();
    readBody.append("i", String(ids[0]));
    readBody.append("i", String(ids[1]));
    readBody.set("a", READ_TAG);
    let res = await authed("/reader/api/0/edit-tag", { method: "POST", body: readBody });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 1, is_starred: 1 });
    expect(await stateOf(ids[1]!)).toEqual({ is_read: 1, is_starred: 0 });

    const unreadBody = new URLSearchParams();
    unreadBody.set("i", String(ids[0]));
    unreadBody.set("r", READ_TAG);
    await authed("/reader/api/0/edit-tag", { method: "POST", body: unreadBody });
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 0, is_starred: 1 });
  });

  it("edit-tag 收藏/取消收藏并忽略 label", async () => {
    await enable();
    const { ids } = await seedManyArticles(1);
    await env.DB.prepare("INSERT INTO article_states (article_id, is_read, read_at) VALUES (?, 1, '2026-10-01T00:00:00.000Z')")
      .bind(ids[0])
      .run();

    const save = new URLSearchParams();
    save.set("i", String(ids[0]));
    save.append("a", STARRED_TAG);
    save.append("a", "user/-/label/科技");
    await authed("/reader/api/0/edit-tag", { method: "POST", body: save });
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 1, is_starred: 1 });

    const unsave = new URLSearchParams();
    unsave.set("i", String(ids[0]));
    unsave.set("r", STARRED_TAG);
    await authed("/reader/api/0/edit-tag", { method: "POST", body: unsave });
    expect(await stateOf(ids[0]!)).toEqual({ is_read: 1, is_starred: 0 });
  });

  it("edit-tag 支持长格式 ID 与不存在的 id", async () => {
    await enable();
    const { ids } = await seedManyArticles(1);
    const body = new URLSearchParams();
    body.set("i", `tag:google.com,2005:reader/item/${ids[0]!.toString(16).padStart(16, "0")}`);
    body.set("a", READ_TAG);
    const res = await authed("/reader/api/0/edit-tag", { method: "POST", body });
    expect(await res.text()).toBe("OK");
    expect((await stateOf(ids[0]!))?.is_read).toBe(1);

    const missing = new URLSearchParams();
    missing.set("i", "999999");
    missing.set("a", READ_TAG);
    expect((await authed("/reader/api/0/edit-tag", { method: "POST", body: missing })).status).toBe(200);
  });

  it("edit-tag 批量超过 100 条(验证不触 D1 绑定参数上限)", async () => {
    await enable();
    const { ids } = await seedManyArticles(120);
    const body = new URLSearchParams();
    for (const id of ids) body.append("i", String(id));
    body.set("a", READ_TAG);
    const res = await authed("/reader/api/0/edit-tag", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM article_states WHERE is_read = 1").first<{ n: number }>();
    expect(count?.n).toBe(120);
  });

  it("mark-all-as-read 按 feed/分类/全部/starred 与 ts 过滤", async () => {
    await enable();
    const category = await env.DB.prepare("INSERT INTO categories (name, sort_order) VALUES ('科技', 1)").run();
    const categoryId = Number(category.meta.last_row_id);
    const feed1 = await env.DB.prepare(
      "INSERT INTO feeds (url, title, category_id, sort_order) VALUES ('https://f1.example.com/rss', '源1', ?, 1)"
    ).bind(categoryId).run();
    const feed2 = await env.DB.prepare(
      "INSERT INTO feeds (url, title, sort_order) VALUES ('https://f2.example.com/rss', '源2', 2)"
    ).run();
    const feed1Id = Number(feed1.meta.last_row_id);
    const feed2Id = Number(feed2.meta.last_row_id);
    const a1 = await insertArticle(feed1Id, "a1", "2026-10-01T00:00:01.000Z");
    const a2 = await insertArticle(feed1Id, "a2", "2026-10-01T00:00:02.000Z");
    const b1 = await insertArticle(feed2Id, "b1", "2026-10-01T00:00:03.000Z");
    const b2 = await insertArticle(feed2Id, "b2", "2026-10-01T00:00:04.000Z");
    await env.DB.prepare("INSERT INTO article_states (article_id, is_starred) VALUES (?, 1)").bind(b2).run();

    const feedBody = new URLSearchParams({
      s: `feed/${feed1Id}`,
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:02.000Z") / 1000)),
    });
    let res = await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: feedBody });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect((await stateOf(a1))?.is_read).toBe(1);
    expect((await stateOf(a2))?.is_read ?? 0).toBe(0); // published_at == ts,不早于
    expect((await stateOf(b1))?.is_read ?? 0).toBe(0);

    const labelBody = new URLSearchParams({
      s: "user/-/label/科技",
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:03.000Z") / 1000)),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: labelBody });
    expect((await stateOf(a2))?.is_read).toBe(1);

    const starBody = new URLSearchParams({
      s: "user/-/state/com.google/starred",
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:05.000Z") / 1000)),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: starBody });
    expect((await stateOf(b2))?.is_read).toBe(1);

    const allBody = new URLSearchParams({
      s: "user/-/state/com.google/reading-list",
      ts: String(Math.floor(Date.parse("2026-10-01T00:00:06.000Z") / 1000)),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: allBody });
    expect((await stateOf(b1))?.is_read).toBe(1);

    const invalid = new URLSearchParams({ s: "user/-/state/com.google/broadcast", ts: "1" });
    const invalidRes = await authed("/reader/api/0/mark-all-as-read", { method: "POST", body: invalid });
    expect(invalidRes.status).toBe(200);
    expect(await invalidRes.text()).toBe("OK");
  });

  it("mark-all-as-read 接受毫秒时间戳", async () => {
    await enable();
    const feed = await env.DB.prepare(
      "INSERT INTO feeds (url, title) VALUES ('https://ms.example.com/rss', '毫秒源')"
    ).run();
    const id = await insertArticle(Number(feed.meta.last_row_id), "m1", "2026-10-01T00:00:01.000Z");
    const body = new URLSearchParams({
      s: `feed/${Number(feed.meta.last_row_id)}`,
      ts: String(Date.parse("2026-10-01T00:00:02.000Z")),
    });
    await authed("/reader/api/0/mark-all-as-read", { method: "POST", body });
    expect((await stateOf(id))?.is_read).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: FAIL — 两个写端点 404。

- [ ] **Step 3: 实现写端点**

在 `worker/src/routes/greader.ts` 的 `export default greader;` 之前插入:

```ts
async function upsertReadState(db: D1Database, ids: number[], read: boolean): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const jsonIds = JSON.stringify(ids);
  if (read) {
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
  } else {
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
  }
}

async function upsertStarredState(db: D1Database, ids: number[], starred: boolean): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const jsonIds = JSON.stringify(ids);
  if (starred) {
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

greader.post("/reader/api/0/edit-tag", async (c) => {
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
  const adds = params.getAll("a");
  const removes = params.getAll("r");
  if (ids.length > 0) {
    if (adds.includes(READ_TAG)) await upsertReadState(c.env.DB, ids, true);
    if (adds.includes(STARRED_TAG)) await upsertStarredState(c.env.DB, ids, true);
    if (removes.includes(READ_TAG)) await upsertReadState(c.env.DB, ids, false);
    if (removes.includes(STARRED_TAG)) await upsertStarredState(c.env.DB, ids, false);
  }
  return c.text("OK", 200, NO_STORE);
});

greader.post("/reader/api/0/mark-all-as-read", async (c) => {
  const params = await collectParams(c);
  const stream = parseStream(params.get("s") ?? "");
  if (stream.empty) return c.text("OK", 200, NO_STORE);
  const rawTs = Number(params.get("ts"));
  let ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : Date.now() / 1000;
  if (ts > 1e10) ts /= 1000;
  if (ts > 253402300799) ts = Date.now() / 1000;
  const cutoff = new Date(ts * 1000).toISOString();

  const where: string[] = [
    "COALESCE((SELECT is_read FROM article_states WHERE article_id = a.id), 0) = 0",
    "a.published_at < ?",
  ];
  const binds: (string | number)[] = [new Date().toISOString(), new Date().toISOString(), cutoff];
  let join = "";
  if (stream.feedId !== undefined) {
    where.push("a.feed_id = ?");
    binds.push(stream.feedId);
  }
  if (stream.categoryName !== undefined) {
    join = " JOIN feeds f ON f.id = a.feed_id JOIN categories c ON c.id = f.category_id";
    where.push("c.name = ?");
    binds.push(stream.categoryName);
  }
  if (stream.starred) {
    where.push("COALESCE((SELECT is_starred FROM article_states WHERE article_id = a.id), 0) = 1");
  }

  await c.env.DB.prepare(
    `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
     SELECT a.id, 1, ?, ? FROM articles a${join}
     WHERE ${where.join(" AND ")}
     ON CONFLICT(article_id) DO UPDATE SET
       is_read = 1, read_at = excluded.read_at, updated_at = excluded.updated_at`
  )
    .bind(...binds)
    .run();
  return c.text("OK", 200, NO_STORE);
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C worker exec vitest run test/greader.test.ts`
Expected: PASS。

Run: `pnpm -C worker run typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add worker/src/routes/greader.ts worker/test/greader.test.ts
git commit -m "feat: GReader 已读与收藏写操作

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 设置页 Google Reader 区块

**Files:**
- Create: `web/src/components/GoogleReaderSettings.vue`
- Modify: `web/src/views/Settings.vue`(import 区与模板帮助区块前)
- Test: `web/src/components/__tests__/google-reader-settings.test.ts`
- Test: `web/src/views/__tests__/settings-mount.test.ts`(追加挂载断言)

**Interfaces:**
- Consumes: `GREADER_USERNAME`、`SETTING_KEYS.greaderAuth`、`GReaderAuth`、`@/api/client` 的 `api`。
- Produces: 组件 `GoogleReaderSettings.vue`,选择器:
  `data-greader-enable|reset|disable|endpoint|username|password|copy-endpoint|copy-username|copy-password|message`

- [ ] **Step 1: 写失败的组件测试**

Create `web/src/components/__tests__/google-reader-settings.test.ts`:

```ts
// @vitest-environment jsdom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GREADER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { api } from "@/api/client";
import GoogleReaderSettings from "@/components/GoogleReaderSettings.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

let mounted: { app: App; container: HTMLElement } | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mount(setting?: unknown, reject = false): Promise<HTMLElement> {
  if (reject) {
    vi.mocked(api).mockRejectedValue(new Error("boom"));
  } else {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/settings" && opts?.method === "PUT") return Promise.resolve({ ok: true });
      if (path === "/api/settings") return Promise.resolve({ [SETTING_KEYS.greaderAuth]: setting ?? null });
      return Promise.resolve({});
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(GoogleReaderSettings);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return container;
}

function putCalls(): { kv: Record<string, unknown> }[] {
  return vi.mocked(api).mock.calls
    .filter(([path, opts]) => path === "/api/settings" && opts?.method === "PUT")
    .map(([, opts]) => (opts!.body as { kv: Record<string, unknown> }).kv);
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  vi.restoreAllMocks();
});

describe("GoogleReaderSettings", () => {
  it("未启用 → 启用:PUT 精确契约并显示三项凭据", async () => {
    const container = await mount(null);
    expect(container.querySelector("[data-greader-enable]")).toBeTruthy();
    (container.querySelector("[data-greader-enable]") as HTMLButtonElement).click();
    await flush();

    const envelopes = putCalls();
    expect(envelopes).toHaveLength(1);
    const kv = envelopes[0]!;
    expect(Object.keys(kv)).toEqual([SETTING_KEYS.greaderAuth]);
    const value = kv[SETTING_KEYS.greaderAuth] as { username: string; password: string };
    expect(value.username).toBe(GREADER_USERNAME);
    expect(value.password).toMatch(/^[0-9a-f]{32}$/);

    expect((container.querySelector("[data-greader-endpoint]") as HTMLElement).textContent).toContain(location.origin);
    expect((container.querySelector("[data-greader-username]") as HTMLElement).textContent).toBe(GREADER_USERNAME);
    expect((container.querySelector("[data-greader-password]") as HTMLElement).textContent).toBe(value.password);
  });

  it("已有配置直接渲染", async () => {
    const container = await mount({ username: GREADER_USERNAME, password: "deadbeefdeadbeefdeadbeefdeadbeef" });
    expect((container.querySelector("[data-greader-password]") as HTMLElement).textContent).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(container.querySelector("[data-greader-enable]")).toBeNull();
  });

  it("重置生成新密码;停用写入 null 并回到未启用态", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = await mount({ username: GREADER_USERNAME, password: "deadbeefdeadbeefdeadbeefdeadbeef" });
    (container.querySelector("[data-greader-reset]") as HTMLButtonElement).click();
    await flush();
    const resetValue = putCalls()[0]![SETTING_KEYS.greaderAuth] as { password: string };
    expect(resetValue.password).toMatch(/^[0-9a-f]{32}$/);
    expect(resetValue.password).not.toBe("deadbeefdeadbeefdeadbeefdeadbeef");

    (container.querySelector("[data-greader-disable]") as HTMLButtonElement).click();
    await flush();
    expect(putCalls()[1]![SETTING_KEYS.greaderAuth]).toBeNull();
    expect(container.querySelector("[data-greader-enable]")).toBeTruthy();
  });

  it("复制按钮写入预期文本", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = await mount({ username: GREADER_USERNAME, password: "deadbeefdeadbeefdeadbeefdeadbeef" });
    (container.querySelector("[data-greader-copy-password]") as HTMLButtonElement).click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("deadbeefdeadbeefdeadbeefdeadbeef");
    expect((container.querySelector("[data-greader-message]") as HTMLElement).textContent).toContain("已复制");
  });

  it("加载失败显示提示", async () => {
    const container = await mount(undefined, true);
    await flush();
    expect(container.textContent).toContain("Google Reader 设置加载失败");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C web exec vitest run src/components/__tests__/google-reader-settings.test.ts`
Expected: FAIL — 组件不存在。

- [ ] **Step 3: 实现组件**

Create `web/src/components/GoogleReaderSettings.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { GREADER_USERNAME, SETTING_KEYS, type GReaderAuth } from "@readly/shared";
import { api } from "@/api/client";

const auth = ref<GReaderAuth | null>(null);
const busy = ref(false);
const message = ref("");
const server = location.origin;

function sanitize(raw: unknown): GReaderAuth | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { username?: unknown; password?: unknown };
  if (typeof value.username !== "string" || !value.username) return null;
  if (typeof value.password !== "string" || !value.password) return null;
  return { username: value.username, password: value.password };
}

async function load(): Promise<void> {
  try {
    const all = await api<Record<string, unknown>>("/api/settings");
    auth.value = sanitize(all[SETTING_KEYS.greaderAuth]);
  } catch {
    message.value = "Google Reader 设置加载失败";
  }
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function save(next: GReaderAuth | null): Promise<boolean> {
  busy.value = true;
  message.value = "";
  try {
    await api("/api/settings", { method: "PUT", body: { kv: { [SETTING_KEYS.greaderAuth]: next } } });
    auth.value = next;
    return true;
  } catch {
    message.value = "保存失败,请重试";
    return false;
  } finally {
    busy.value = false;
  }
}

async function enable(): Promise<void> {
  if (await save({ username: GREADER_USERNAME, password: generatePassword() })) {
    message.value = "已启用,请在客户端填入下方信息";
  }
}

async function reset(): Promise<void> {
  if (!window.confirm("重置后旧密码立即失效,需在客户端重新登录。继续?")) return;
  if (await save({ username: GREADER_USERNAME, password: generatePassword() })) {
    message.value = "已重置,请在客户端更新密码";
  }
}

async function disable(): Promise<void> {
  if (!window.confirm("停用后所有 Google Reader 客户端将无法同步。继续?")) return;
  if (await save(null)) message.value = "已停用";
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.value = "已复制";
  } catch {
    message.value = "复制失败,请手动选择文本";
  }
}

onMounted(load);
</script>

<template>
  <section class="mt-8">
    <h2 class="text-base font-semibold">第三方客户端(Google Reader API)</h2>
    <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
      兼容 Reeder、FeedMe、NewsFlash 等支持 Google Reader API 的客户端。启用后生成独立密码,可随时重置或停用;已读与收藏双向同步。
    </p>

    <div v-if="!auth" class="mt-4">
      <button
        data-greader-enable
        :disabled="busy"
        class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        @click="enable"
      >
        启用 Google Reader API
      </button>
    </div>

    <div v-else class="mt-4 space-y-3 rounded-xl border border-neutral-200 px-4 py-4 dark:border-neutral-800">
      <div class="flex items-center gap-2 text-sm">
        <span class="w-20 shrink-0 text-neutral-500 dark:text-neutral-400">服务器</span>
        <code data-greader-endpoint class="min-w-0 flex-1 truncate">{{ server }}</code>
        <button
          data-greader-copy-endpoint
          class="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="copy(server)"
        >
          复制
        </button>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="w-20 shrink-0 text-neutral-500 dark:text-neutral-400">邮箱</span>
        <code data-greader-username class="min-w-0 flex-1 truncate">{{ auth.username }}</code>
        <button
          data-greader-copy-username
          class="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="copy(auth.username)"
        >
          复制
        </button>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="w-20 shrink-0 text-neutral-500 dark:text-neutral-400">密码</span>
        <code data-greader-password class="min-w-0 flex-1 break-all">{{ auth.password }}</code>
        <button
          data-greader-copy-password
          class="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="copy(auth.password)"
        >
          复制
        </button>
      </div>
      <div class="flex flex-wrap gap-2 pt-1">
        <button
          data-greader-reset
          :disabled="busy"
          class="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="reset"
        >
          重置密码
        </button>
        <button
          data-greader-disable
          :disabled="busy"
          class="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-red-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-neutral-800"
          @click="disable"
        >
          停用
        </button>
      </div>
      <p class="text-xs text-neutral-500 dark:text-neutral-400">
        客户端中选择「Google Reader」账户类型。分类会作为 label 显示;不支持在客户端内添加/删除订阅,仅 JSON;新文章由 Readly 后台定时刷新。
      </p>
    </div>

    <p v-if="message" data-greader-message class="mt-3 text-sm text-neutral-600 dark:text-neutral-300">{{ message }}</p>
  </section>
</template>
```

- [ ] **Step 4: 挂载到设置页**

Modify `web/src/views/Settings.vue`:

import 区追加:

```ts
import GoogleReaderSettings from "@/components/GoogleReaderSettings.vue";
```

模板中找到唯一的帮助区块起始行:

```vue
    <section class="mt-8">
      <h2 class="text-base font-semibold">帮助</h2>
```

在它之前插入:

```vue
    <GoogleReaderSettings />

```

- [ ] **Step 5: 追加设置页挂载断言**

在 `web/src/views/__tests__/settings-mount.test.ts` 的 `describe("Settings 挂载", ...)` 内追加一个用例:

```ts
  it("Google Reader 区块挂载:未启用时显示启用入口", async () => {
    const { container } = await mountSettings();
    expect(container.querySelector("[data-greader-enable]")).toBeTruthy();
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm -C web exec vitest run src/components/__tests__/google-reader-settings.test.ts src/views/__tests__/settings-mount.test.ts`
Expected: PASS。

Run: `pnpm -C web run typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/GoogleReaderSettings.vue web/src/views/Settings.vue web/src/components/__tests__/google-reader-settings.test.ts web/src/views/__tests__/settings-mount.test.ts
git commit -m "feat(web): 设置页 Google Reader API 区块

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: README 与全量验证

**Files:**
- Modify: `README.md`(功能列表、第三方客户端小节、测试计数)

**Interfaces:**
- Consumes: 前 6 个任务的产物。

- [ ] **Step 1: 更新 README 功能列表**

在「## 功能」列表的 `8. 一键部署 Cloudflare` 之后追加:

```markdown
9. Google Reader API:兼容 Reeder、FeedMe、NewsFlash 等第三方客户端(设置页一键启用独立密码,已读与收藏双向同步)
```

- [ ] **Step 2: 新增客户端配置小节**

在「## PWA」小节之后、「## 部署到 Cloudflare」之前插入:

```markdown
## 第三方客户端(Google Reader API)

设置 → 第三方客户端(Google Reader API) → 启用,即可获得:

- 服务器地址:`https://<你的 Worker 域名>`
- 邮箱:`readly`
- 密码:设置页生成的独立密码(可随时重置/停用)

在 Reeder、FeedMe、NewsFlash 等客户端中选择「Google Reader」账户类型并填入以上三项。已读与收藏(客户端中的 Starred/Saved)双向同步;Readly 的分类会作为 label 显示。

限制:不支持在客户端内添加/删除订阅(加源、删源、改名、移分类请用网页端);仅 JSON;不支持 Broadcast 等扩展;客户端不能触发刷新(新文章由服务端 cron 抓取)。密码以明文存于 D1 以便再次展示,泄露后请在设置页重置。
```

- [ ] **Step 3: 运行全量测试与类型检查**

Run: `pnpm build && pnpm -r test && pnpm -r typecheck`
Expected: 全部通过。记录实际 worker/web 用例数。

- [ ] **Step 4: 按实际结果更新 README 计数**

README 第 7 行(顶部摘要)与「## 测试」代码块中的计数都需替换为实际值:
- 第 7 行:`- 测试:<N+M> 项(worker <N> + web <M>),全绿`
- 「## 测试」代码块注释:`# worker <N> + web <M> = <N+M> 项`

若实际数与原文一致则不改。

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: Google Reader API 客户端配置与功能说明

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 端到端验收(控制器执行)

**Files:** 无源码变更;产出验收记录(写入 `.superpowers/sdd/progress.md`,该文件 gitignored)。

- [ ] **Step 1: 准备隔离的本地 D1 与种子数据**

```bash
rm -rf /tmp/readly-greader-accept
cd /home/mj/aicode/readly
pnpm build
pnpm --filter @readly/worker exec wrangler d1 migrations apply readly --local --persist-to /tmp/readly-greader-accept
cat > /tmp/greader-seed.sql <<'SQL'
INSERT INTO settings (key, value) VALUES ('greader_auth', '{"username":"readly","password":"accept-password-123"}');
INSERT INTO categories (name, sort_order) VALUES ('科技', 1);
INSERT INTO feeds (url, title, site_url, category_id, sort_order, last_fetched_at)
  VALUES ('https://a.example.com/rss', '源A', 'https://a.example.com', 1, 1, '2026-10-01T00:00:00.000Z');
INSERT INTO articles (feed_id, guid, title, url, author, published_at, excerpt, content) VALUES
  (1, 'g1', '文章一', 'https://a.example.com/1', '作者一', '2026-10-01T00:00:01.000Z', '摘要一', '<p>正文一</p>'),
  (1, 'g2', '文章二', 'https://a.example.com/2', NULL, '2026-10-01T00:00:02.000Z', '摘要二', '<p>正文二</p>');
SQL
pnpm --filter @readly/worker exec wrangler d1 execute readly --local --persist-to /tmp/readly-greader-accept --file /tmp/greader-seed.sql
```

- [ ] **Step 2: 启动本地 Worker(带已知 AUTH_TOKEN,供设置页使用)**

```bash
pnpm --filter @readly/worker exec wrangler dev --port 8787 --persist-to /tmp/readly-greader-accept --var AUTH_TOKEN:test-token
```

在另一个终端执行后续 curl;完成后终止该进程。

- [ ] **Step 3: 用 curl 走一遍客户端同步流程**

```bash
BASE=http://127.0.0.1:8787
TOKEN=$(curl -s -X POST -d 'Email=readly&Passwd=accept-password-123' "$BASE/accounts/ClientLogin" | sed -n 's/^Auth=//p')
echo "token=$TOKEN"
curl -s -H "Authorization: GoogleLogin auth=$TOKEN" "$BASE/reader/api/0/user-info" | jq .
curl -s -H "Authorization: GoogleLogin auth=$TOKEN" "$BASE/reader/api/0/subscription/list" | jq .
curl -s -H "Authorization: GoogleLogin auth=$TOKEN" "$BASE/reader/api/0/unread-count?all=1" | jq .
curl -s -H "Authorization: GoogleLogin auth=$TOKEN" "$BASE/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=10" | jq .
curl -s -H "Authorization: GoogleLogin auth=$TOKEN" "$BASE/reader/api/0/stream/contents/user/-/state/com.google/reading-list" | jq '{id, n: (.items|length), first: .items[0].title}'
curl -s -X POST -H "Authorization: GoogleLogin auth=$TOKEN" \
  --data-urlencode "i=tag:google.com,2005:reader/item/0000000000000001" \
  --data-urlencode "a=user/-/state/com.google/read" \
  "$BASE/reader/api/0/edit-tag"
curl -s -H "Authorization: GoogleLogin auth=$TOKEN" "$BASE/reader/api/0/unread-count" | jq '.max'
# 期望:token 非空;user-info.userName=readly;subscriptions 1 项;unread-count.max=2;items 2 条;
# edit-tag 输出 OK;再次 unread-count.max=1
```

- [ ] **Step 4: Chrome 浅/深验收设置区块**

启动 `pnpm --filter @readly/web dev --port 5173`(代理指向 8787;与 Step 2 的 worker 同时运行),用 headless Chrome + CDP:
1. 导航到 `http://127.0.0.1:5173/login`,在 `localStorage` 写入 `readly_token=test-token`,再导航 `/settings`;
2. 断言 `[data-greader-password]` 文本为 Step 1 种入的 `accept-password-123`(已启用态);
3. 点击 `[data-greader-reset]`(confirm 自动接受),断言密码变为 `/^[0-9a-f]{32}$/` 且不等于旧值;
4. 截图 `/tmp/readly-greader-light.png`;切换 `html.dark`,截图 `/tmp/readly-greader-dark.png`;
5. 断言深色下区块文字与背景 computed 颜色成对(非白字白底),且 `[data-greader-endpoint]`、`[data-greader-username]`、`[data-greader-password]` 三者均可见;
6. 重载页面,断言新密码仍显示(来自 D1);点击 `[data-greader-disable]`(confirm 自动接受),断言回到 `[data-greader-enable]`;再点击启用,断言三项凭据重新出现。

- [ ] **Step 5: 记录验收结果**

在 `.superpowers/sdd/progress.md` 追加:curl 各步实际输出摘要、Chrome 断言通过数、截图路径、全量测试计数。无需提交(gitignored)。

---

## 计划自检

- **Spec 覆盖:** 认证(2/4.1)、ClientLogin(2.3/4.1)、token(2.4)、user-info(4.1)、subscription(4.2)、tag(4.3)、unread-count(4.4)、items/ids(4.5)、items/contents(4.6)、stream/contents(4.7)、item 形状(4.8)、edit-tag(4.9)、mark-all-as-read(4.10)、流映射(5)、设置页(6)、路由/部署(7)、README/验收(9.3)均有对应任务。
- **无占位符:** 所有代码、命令、期望输出均已给出。
- **类型一致性:** `GReaderAuth`、`SETTING_KEYS.greaderAuth`、`GReaderItemRow`、`MultiParams`、`StreamFilter` 在各任务间名称一致;`READ_TAG`/`STARRED_TAG`/`READING_LIST`/`KEPT_UNREAD`/`LABEL_PREFIX` 均自 `worker/src/lib/greader.ts` 导出。
- **D1 限制:** 批量按 ID 查询/更新统一走 `json_each(?)`(单参数),避免单条 SQL 100 个绑定参数上限;测试用 120 条覆盖。`stream/items/contents` 请求顺序由 JS 侧 Map 重排保证。
