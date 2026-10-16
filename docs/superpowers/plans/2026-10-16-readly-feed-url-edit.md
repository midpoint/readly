# Readly 订阅源编辑网址 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏源管理菜单新增「编辑网址」:弹窗修改订阅源 URL,**保存即抓取校验**(同添加订阅语义),成功采纳新源元数据并增量入库,失败就地报错、库内概不落笔。

**Architecture:** 服务端扩展现有 `PATCH /api/feeds/:id`(新增可选字段 `url`,复用 `assertSafeUrl` + `fetchFeedIntoDb`,不新增端点);客户端新增 `FeedUrlEditor.vue` 弹窗(样式对齐 RuleEditor/ProviderEditor)+ store `editFeedUrl` + Sidebar 两处 ⋯ 菜单接线。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- 设计文档:`docs/superpowers/specs/2026-10-16-feed-url-edit-design.md`(已评审)。一切行为以该文档为准。
- 无 `any`;strict;新增 UI 必须同时声明深色文字与底色配对(纪律 2);深色为 class 策略(`html.dark`)。
- 契约断言(a935c3a 教训):客户端测试钉**精确请求体**(`{ url }`,不多不少);worker 测试用线上字段名(`url`)走 HTTP 层。
- 错误码冻结:`invalid_url`(400)/ `already_subscribed`(400)/ `fetch_failed`(502,与既有 `/feeds/:id/refresh` 一致)/ `not_found`(404);错误文案来自 `ApiError.message`,弹窗直接展示。
- 抓取只经 `fetchFeedIntoDb`(内含 `fetchText` 的 SSRF 防护链);改址首抓必须传空 ETag/Last-Modified(旧值对应旧 URL),`initialLimit: 50`(同 `subscribeOne`)。
- worker 测试新增用例必须插在 `worker/test/feeds.test.ts` 末尾「分类不存在:整批 400」用例**之前**(该用例注释要求保持在文件末尾)。
- 数据契约:改址后旧文章全部保留(`UNIQUE(feed_id, guid)` + `INSERT OR IGNORE` 自然去重增量);编辑器只发 `{ url }`。
- 选择器契约:`[data-feed-url]`(输入框)、`[data-feed-url-save]`(保存按钮)、`[data-feed-url-error]`(错误行)。
- 视觉验收必须实测(纪律 1):headless Chrome 浅/深双态截图 + 文本对比度 ≥4.5 实测,参照 `/tmp/readly-final-verify-final.mjs` 的「桩 API + CDP 直连」模式;不触碰用户后台 `pnpm dev`(5173/8787)。
- 每任务一个 commit,消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

---

### Task 1: worker `PATCH /api/feeds/:id` 支持改址(保存即抓取校验)

**Files:**
- Modify: `worker/src/routes/feeds.ts`(PATCH 路由,约 171-207 行;import 行 7)
- Test: `worker/test/feeds.test.ts`(新增用例插在文件末尾「分类不存在:整批 400」用例之前)

**Interfaces:**
- Consumes:`assertSafeUrl`(`../lib/ssrf`,已有)、`fetchFeedIntoDb` / `FetchIntoResult`(`../lib/refresh`,已有)、`fail`/`ok`(`../respond`,已有)、`FEED_SELECT`/`toFeed`(本文件内已有)。
- Produces:`PATCH /api/feeds/:id` 接受 `url?: unknown`;成功返回完整 feed(200);错误码 `invalid_url` / `already_subscribed` / `fetch_failed` / `not_found`。行为语义见设计文档 §3。

- [ ] **Step 1: 写失败测试(6 个用例 + 新 feed XML 常量)**

在 `worker/test/feeds.test.ts` 的 `FEED_XML` 常量之后追加:

```ts
// 新地址抓取用:标题不同、guid a2 与原源重复、a3 为新文章(验证 保留+增量 同时成立)
const NEW_FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>新源标题</title><link>https://new.example.com</link>
<item><title>乙</title><guid>a2</guid><pubDate>Mon, 13 Oct 2025 09:00:00 GMT</pubDate><description>乙摘要</description></item>
<item><title>丙</title><guid>a3</guid><pubDate>Mon, 13 Oct 2025 10:00:00 GMT</pubDate><description>丙摘要</description></item>
</channel></rss>`;
```

在文件末尾「分类不存在:整批 400」用例**之前**插入以下 6 个用例:

```ts
  it("PATCH url:抓取成功采纳新元数据并重置校验器,旧文章保留、新文章增量入库", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    // 预置旧校验器与错误计数:改址成功后必须被覆盖/清零
    await env.DB.prepare("UPDATE feeds SET last_etag = '\"v1\"', last_modified = 'Mon, 01 Jan 2024 00:00:00 GMT', error_count = 3, last_error = '旧错误' WHERE id = ?").bind(id).run();
    fetchMock
      .get("https://new.example.com")
      .intercept({ path: "/rss" })
      .reply(200, NEW_FEED_XML, { headers: { "Content-Type": "application/rss+xml", ETag: '"v2"', "Last-Modified": "Wed, 15 Oct 2025 00:00:00 GMT" } });

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(res.status).toBe(200);
    const feed = (await res.json()) as { url: string; title: string; siteUrl: string | null; unreadCount: number };
    expect(feed.url).toBe("https://new.example.com/rss");
    expect(feed.title).toBe("新源标题"); // 采纳新源标题
    expect(feed.siteUrl).toBe("https://new.example.com");
    expect(feed.unreadCount).toBe(3); // a1 保留 + a2 去重 + a3 增量

    const row = await env.DB.prepare("SELECT last_etag, last_modified, error_count, last_error FROM feeds WHERE id = ?")
      .bind(id)
      .first<{ last_etag: string; last_modified: string; error_count: number; last_error: string | null }>();
    expect(row!.last_etag).toBe('"v2"');
    expect(row!.last_modified).toBe("Wed, 15 Oct 2025 00:00:00 GMT");
    expect(row!.error_count).toBe(0);
    expect(row!.last_error).toBeNull();

    const guids = await env.DB.prepare("SELECT guid FROM articles WHERE feed_id = ? ORDER BY guid").bind(id).all<{ guid: string }>();
    expect(guids.results.map((r) => r.guid)).toEqual(["a1", "a2", "a3"]);
  });

  it("PATCH url:他源已占用的地址报 400,库内不变", async () => {
    mockFeed("https://feed.example.com");
    mockFeed("https://other.example.com");
    const a = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const b = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://other.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const bId = b.created[0]!.id;

    const res = await apiFetch(`/api/feeds/${bId}`, { method: "PATCH", body: { url: "https://feed.example.com/rss" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: "already_subscribed", message: "已订阅该源" });
    const row = await env.DB.prepare("SELECT url, title FROM feeds WHERE id = ?").bind(bId).first<{ url: string; title: string }>();
    expect(row!.url).toBe("https://other.example.com/rss");
    expect(row!.title).toBe("示例源");
    expect(a.created[0]!.id).toBeDefined(); // 源 A 不受影响
  });

  it("PATCH url:内网地址报 400,不发任何网络请求", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "http://127.0.0.1/rss" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: "invalid_url", message: "不允许访问内网地址" });
    // 若代码走了抓取路径,net 连接被禁 → 会以 502 冒头;400 本身即证明未发请求
    expect(fetchMock.pendingInterceptors()).toHaveLength(0);
  });

  it("PATCH url:抓取失败报 502,旧地址/旧标题/错误计数原样", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;
    fetchMock.get("https://dead.example.com").intercept({ path: "/rss" }).reply(404, "gone", { headers: { "Content-Type": "text/plain" } });

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "https://dead.example.com/rss" } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("fetch_failed");
    const row = await env.DB.prepare("SELECT url, title, error_count, last_error FROM feeds WHERE id = ?")
      .bind(id)
      .first<{ url: string; title: string; error_count: number; last_error: string | null }>();
    expect(row!.url).toBe("https://feed.example.com/rss");
    expect(row!.title).toBe("示例源");
    expect(row!.error_count).toBe(0); // 编辑失败是输入问题,不记入源故障
    expect(row!.last_error).toBeNull();
  });

  it("PATCH url:与当前地址相同 → no-op 成功,无网络请求", async () => {
    mockFeed("https://feed.example.com");
    const created = (await (await apiFetch("/api/feeds", { method: "POST", body: { urls: ["https://feed.example.com/rss"] } })).json()) as { created: { id: number }[] };
    const id = created.created[0]!.id;

    const res = await apiFetch(`/api/feeds/${id}`, { method: "PATCH", body: { url: "https://feed.example.com/rss" } });
    expect(res.status).toBe(200);
    const feed = (await res.json()) as { url: string; title: string };
    expect(feed.url).toBe("https://feed.example.com/rss");
    expect(feed.title).toBe("示例源");
    expect(fetchMock.pendingInterceptors()).toHaveLength(0);
  });

  it("PATCH url:源不存在报 404", async () => {
    const res = await apiFetch("/api/feeds/999", { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @readly/worker test -- test/feeds.test.ts`
Expected: 6 个新用例 FAIL(`url` 目前被静默忽略:标题/URL 不变或 `nothing_to_update` 400 等)。

- [ ] **Step 3: 实现路由**

`worker/src/routes/feeds.ts` 第 7 行改为:

```ts
import { fetchFeedIntoDb, type FetchIntoResult } from "../lib/refresh";
```

`feeds.patch("/feeds/:id", ...)` 整体替换为:

```ts
feeds.patch("/feeds/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ title?: unknown; categoryId?: unknown; sortOrder?: unknown; url?: unknown }>()
    .catch(() => ({}) as { title?: unknown; categoryId?: unknown; sortOrder?: unknown; url?: unknown });

  // —— 改址(先于小字段;保存即抓取校验,失败整体拒绝,库内概不落笔) ——
  let urlHandled = false;
  if (typeof body.url === "string") {
    const raw = body.url.trim();
    if (!raw) return fail(c, 400, "invalid_url", "请提供网址");
    let nextUrl: string;
    try {
      nextUrl = assertSafeUrl(raw).toString();
    } catch (e) {
      return fail(c, 400, "invalid_url", e instanceof Error ? e.message : "无效的 URL");
    }
    const current = await c.env.DB.prepare("SELECT id, url FROM feeds WHERE id = ?").bind(id).first<{ id: number; url: string }>();
    if (!current) return fail(c, 404, "not_found", "订阅不存在");
    if (nextUrl !== current.url) {
      const taken = await c.env.DB.prepare("SELECT id FROM feeds WHERE url = ? AND id != ?").bind(nextUrl, id).first<{ id: number }>();
      if (taken) return fail(c, 400, "already_subscribed", "已订阅该源");
      // 空校验器抓新地址(旧 ETag/Last-Modified 对应旧 URL 不可复用);initialLimit 同添加订阅,响应耗时受控
      let r: FetchIntoResult;
      try {
        r = await fetchFeedIntoDb(c.env.DB, { id, url: nextUrl, lastEtag: null, lastModified: null }, { initialLimit: 50 });
      } catch (e) {
        return fail(c, 502, "fetch_failed", e instanceof Error ? e.message : "抓取失败");
      }
      try {
        await c.env.DB.prepare(
          `UPDATE feeds SET url = ?, title = ?, site_url = ?, icon_url = ?, description = ?,
             last_fetched_at = ?, next_refresh_at = ?, last_etag = ?, last_modified = ?,
             error_count = 0, last_error = NULL
           WHERE id = ?`
        )
          .bind(
            nextUrl,
            r.title ?? nextUrl,
            r.siteUrl ?? null,
            r.iconUrl ?? null,
            r.description ?? null,
            new Date().toISOString(),
            new Date(Date.now() + 30 * 60_000).toISOString(),
            r.etag ?? null,
            r.lastModified ?? null,
            id
          )
          .run();
      } catch {
        // 并发窗口:新地址在预检后被他人占用(UNIQUE 兜底);已入库的新文章保留(仍属该源内容)
        return fail(c, 400, "already_subscribed", "已订阅该源");
      }
    }
    urlHandled = true;
  }

  // 先校验分类存在性再执行 UPDATE,避免外键约束错误 500(categoryId 为 null 表示移到未分类,合法)
  if (typeof body.categoryId === "number" && !(await categoryExists(c.env.DB, body.categoryId))) {
    return fail(c, 400, "invalid_category", "分类不存在");
  }
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (typeof body.title === "string" && body.title.trim()) {
    sets.push("title = ?");
    values.push(body.title.trim());
  }
  if (body.categoryId === null || typeof body.categoryId === "number") {
    sets.push("category_id = ?");
    values.push(body.categoryId as number | null);
  }
  if (typeof body.sortOrder === "number") {
    sets.push("sort_order = ?");
    values.push(body.sortOrder);
  }
  if (sets.length === 0) {
    // 仅有 url 且已走完改址流程(含 no-op)时,回读返回;其余「无字段」维持原 400
    if (!urlHandled) return fail(c, 400, "nothing_to_update", "没有可更新字段");
  } else {
    values.push(id);
    let changes = 0;
    try {
      const res = await c.env.DB.prepare(`UPDATE feeds SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
      changes = res.meta.changes ?? 0;
    } catch {
      // 残余约束错误(如分类在存在性检查后被并发删除)兜底为 400 而非 500
      return fail(c, 400, "invalid_category", "分类不存在");
    }
    if (!changes) return fail(c, 404, "not_found", "订阅不存在");
  }
  const row = await c.env.DB.prepare(`${FEED_SELECT} WHERE f.id = ?`).bind(id).first<Row>();
  if (!row) return fail(c, 404, "not_found", "订阅不存在");
  return ok(c, toFeed(row));
});
```

- [ ] **Step 4: 运行确认通过(文件 + 全量 worker)**

Run: `pnpm --filter @readly/worker test -- test/feeds.test.ts`
Expected: 该文件全部 PASS(原 8 + 新 6 = 14)。
Run: `pnpm --filter @readly/worker test`
Expected: 134 passed(128 + 6)。

- [ ] **Step 5: Commit**

```bash
git add worker/src/routes/feeds.ts worker/test/feeds.test.ts
git commit -m "feat(worker): PATCH /api/feeds/:id 支持改址(保存即抓取校验)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: web store `editFeedUrl`

**Files:**
- Modify: `web/src/stores/feeds.ts`(renameFeed 之后加方法并导出)
- Test: `web/src/stores/__tests__/feeds.test.ts`

**Interfaces:**
- Consumes:`api`(`@/api/client`)、本 store 的 `load()`。
- Produces:`editFeedUrl(feedId: number, url: string): Promise<void>`;失败向上抛(调用方展示)。Task 3/4 依赖此签名。

- [ ] **Step 1: 写失败测试**

`web/src/stores/__tests__/feeds.test.ts` 末尾追加:

```ts
  it("editFeedUrl:精确请求体 { url },成功后重载;失败向上抛且不重载", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/feeds/3" && opts?.method === "PATCH") return Promise.resolve(null);
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/feeds") return Promise.resolve([{ ...FEED, url: "https://new.example.com/rss" }]);
      if (path === "/api/stats") return Promise.resolve(EMPTY_STATS);
      return Promise.resolve([]);
    });
    const store = useFeedsStore();
    await store.editFeedUrl(3, "https://new.example.com/rss");
    // 契约断言:请求体只含 url,不多不少(a935c3a 教训:逐字段钉死)
    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(store.feeds[0]!.url).toBe("https://new.example.com/rss"); // load() 后取服务端真相

    // 失败:向上抛,且不再重载(load 不再被触发)
    const feedCalls = vi.mocked(api).mock.calls.length;
    vi.mocked(api).mockRejectedValueOnce(new Error("已订阅该源"));
    await expect(store.editFeedUrl(3, "https://dup.example.com/rss")).rejects.toThrow("已订阅该源");
    expect(vi.mocked(api).mock.calls.length).toBe(feedCalls + 1); // 仅 PATCH 一次,无后续 load
  });
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @readly/web test -- src/stores/__tests__/feeds.test.ts`
Expected: FAIL(`store.editFeedUrl is not a function`)。

- [ ] **Step 3: 实现**

`web/src/stores/feeds.ts`,`renameFeed` 之后加:

```ts
  // 改址:保存即抓取校验由服务端完成;失败(ApiError)向上抛,由弹窗就地展示且不重载
  async function editFeedUrl(feedId: number, url: string): Promise<void> {
    await api(`/api/feeds/${feedId}`, { method: "PATCH", body: { url } });
    await load();
  }
```

`return { ... }` 行加 `editFeedUrl`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @readly/web test -- src/stores/__tests__/feeds.test.ts`
Expected: 7 passed(原 6 + 新 1)。

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/feeds.ts web/src/stores/__tests__/feeds.test.ts
git commit -m "feat(web): feeds store 增加 editFeedUrl(精确契约 { url })

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `FeedUrlEditor.vue` 弹窗组件 + 组件测试

**Files:**
- Create: `web/src/components/FeedUrlEditor.vue`
- Test: `web/src/components/__tests__/feed-url-editor.test.ts`

**Interfaces:**
- Consumes:`useFeedsStore().editFeedUrl(feedId, url)`(Task 2)、`Feed` 类型。
- Produces:组件 props `feed: Feed`;emits `saved: []`(保存成功先发)、`close: []`;选择器 `[data-feed-url]` / `[data-feed-url-save]` / `[data-feed-url-error]`。Task 4 依赖。

- [ ] **Step 1: 写组件**

`web/src/components/FeedUrlEditor.vue`:

```vue
<script setup lang="ts">
import { ref } from "vue";
import type { Feed } from "@readly/shared";
import { useFeedsStore } from "@/stores/feeds";

const props = defineProps<{ feed: Feed }>();
const emit = defineEmits<{ saved: []; close: [] }>();

const feedsStore = useFeedsStore();
const url = ref(props.feed.url);
const busy = ref(false);
const error = ref("");

async function save(): Promise<void> {
  const next = url.value.trim();
  if (!next || next === props.feed.url || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    // 保存即抓取校验(服务端):成功才落库;失败抛 ApiError,消息就地展示
    await feedsStore.editFeedUrl(props.feed.id, next);
    emit("saved");
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "保存失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <h3 class="text-base font-semibold">编辑订阅源网址</h3>
      <p class="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">{{ feed.title }}</p>
      <label class="mt-4 block text-xs text-neutral-500 dark:text-neutral-400">
        网址
        <input
          v-model="url"
          data-feed-url
          class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          placeholder="https://example.com/feed.xml"
          @keydown.enter="save"
        />
      </label>
      <p v-if="error" data-feed-url-error class="mt-2 text-xs text-red-600 dark:text-red-400">{{ error }}</p>
      <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">保存时会立即抓取新地址校验;失败则保持原地址不变。</p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="emit('close')">取消</button>
        <button
          data-feed-url-save
          :disabled="busy || !url.trim() || url.trim() === feed.url"
          class="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm text-white disabled:opacity-50"
          @click="save"
        >
          {{ busy ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 写组件测试**

`web/src/components/__tests__/feed-url-editor.test.ts`:

```ts
// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type App } from "vue";
import type { Feed } from "@readly/shared";
import { api, ApiError } from "@/api/client";
import FeedUrlEditor from "@/components/FeedUrlEditor.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const FEED: Feed = {
  id: 3,
  url: "https://old.example.com/rss",
  siteUrl: null,
  title: "示例源",
  description: null,
  iconUrl: null,
  categoryId: null,
  sortOrder: 0,
  lastFetchedAt: null,
  errorCount: 0,
  lastError: null,
  unreadCount: 2,
  createdAt: "2025-10-13T00:00:00.000Z",
};

// 宿主包装:v-else 让 close 后组件真实卸载(与 Sidebar 用法一致),data-closed 观察 emit
const Host = defineComponent({
  components: { FeedUrlEditor },
  data: () => ({ feed: FEED, closed: false }),
  template: '<div><span v-if="closed" data-closed /><FeedUrlEditor v-else :feed="feed" @close="closed = true" /></div>',
});

let app: App | null = null;
let host: HTMLElement | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
}

function mockApi(overrides?: (path: string, opts?: { method?: string; body?: unknown }) => unknown): void {
  vi.mocked(api).mockImplementation((path, opts) => {
    const o = overrides?.(path, opts);
    if (o !== undefined) return o as Promise<unknown>;
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([{ ...FEED, url: "https://new.example.com/rss" }]);
    if (path === "/api/stats") return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(api).mockReset();
  mockApi();
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(Host);
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

describe("FeedUrlEditor", () => {
  it("预填当前网址;未修改时保存禁用,修改后启用", async () => {
    const input = host!.querySelector<HTMLInputElement>("[data-feed-url]")!;
    expect(input.value).toBe(FEED.url);
    const saveBtn = host!.querySelector<HTMLButtonElement>("[data-feed-url-save]")!;
    expect(saveBtn.disabled).toBe(true);
    await typeInto(input, "https://new.example.com/rss");
    expect(saveBtn.disabled).toBe(false);
  });

  it("保存成功:PATCH { url } → emit close(组件卸载),不留错误行", async () => {
    const input = host!.querySelector<HTMLInputElement>("[data-feed-url]")!;
    await typeInto(input, "https://new.example.com/rss");
    host!.querySelector<HTMLButtonElement>("[data-feed-url-save]")!.click();
    await flush();
    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(host!.querySelector("[data-feed-url]")).toBeNull();
    expect(host!.querySelector("[data-closed]")).not.toBeNull();
  });

  it("保存失败:错误消息就地展示、弹窗保持打开、不 emit close", async () => {
    mockApi((path, opts) => {
      if (path === "/api/feeds/3" && opts?.method === "PATCH") return Promise.reject(new ApiError("fetch_failed", "抓取失败(HTTP 404)", 502));
      return undefined;
    });
    const input = host!.querySelector<HTMLInputElement>("[data-feed-url]")!;
    await typeInto(input, "https://dead.example.com/rss");
    host!.querySelector<HTMLButtonElement>("[data-feed-url-save]")!.click();
    await flush();
    expect(host!.querySelector("[data-feed-url-error]")!.textContent).toContain("抓取失败(HTTP 404)");
    expect(host!.querySelector("[data-feed-url]")).not.toBeNull(); // 弹窗还在
    expect(host!.querySelector("[data-closed]")).toBeNull();
  });

  it("点击遮罩关闭:emit close", async () => {
    const overlay = host!.firstElementChild!.firstElementChild as HTMLElement; // Host div > 弹窗根
    (overlay as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(host!.querySelector("[data-closed]")).not.toBeNull();
  });
});
```

注意:第 4 个用例依赖 `@click.self`——直接 dispatch 到弹窗根元素本身(而非内层)才会触发 self 判定;`MouseEvent` 需 `bubbles: true`。宿主结构为 `div(Wrapper) > div(弹窗根)`,故取 `firstElementChild.firstElementChild`。

- [ ] **Step 3: 运行**

Run: `pnpm --filter @readly/web test -- src/components/__tests__/feed-url-editor.test.ts`
Expected: 4 passed。(TDD 说明:组件与测试同任务交付——组件无前置依赖,先写组件再写测试即本任务的构建顺序;测试即行为契约。)

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @readly/web typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FeedUrlEditor.vue web/src/components/__tests__/feed-url-editor.test.ts
git commit -m "feat(web): FeedUrlEditor 弹窗(网址编辑/内联错误/成功关闭)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Sidebar 接线(两处 ⋯ 菜单 + 弹窗挂载)

**Files:**
- Modify: `web/src/components/Sidebar.vue`(import;/`menuFeedId` 状态区;两处菜单模板;模板末尾挂弹窗)
- Test: `web/src/components/__tests__/sidebar-actions.test.ts`

**Interfaces:**
- Consumes:`FeedUrlEditor`(Task 3)、`articles.markStale()`(已有)。
- Produces:⋯ 菜单新增按钮「编辑网址」(两处实例同款);保存成功 → `articles.markStale()`。

- [ ] **Step 1: 写失败测试**

`web/src/components/__tests__/sidebar-actions.test.ts` 末尾追加:

```ts
  it("⋯ 菜单「编辑网址」:弹窗预填当前地址;保存成功关闭并标记列表失效", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);
    const articles = useArticlesStore();

    container.querySelector<HTMLButtonElement>('button[aria-label="源管理菜单"]')!.click();
    await flush();
    findButton(container, "编辑网址")!.click();
    await flush();
    const input = container.querySelector<HTMLInputElement>("[data-feed-url]");
    expect(input).toBeTruthy();
    expect(input!.value).toBe(FEED.url); // 预填当前地址

    await typeInto(input!, "https://new.example.com/rss");
    container.querySelector<HTMLButtonElement>("[data-feed-url-save]")!.click();
    await flush();

    expect(api).toHaveBeenCalledWith("/api/feeds/3", { method: "PATCH", body: { url: "https://new.example.com/rss" } });
    expect(container.querySelector("[data-feed-url]")).toBeNull(); // 成功关闭
    expect(articles.stale).toBe(true); // 新地址可能补入新文章:列表失效,返回阅读器重拉
  });

  it("有分类的源:⋯ 菜单同样含「编辑网址」", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/categories") return Promise.resolve([{ id: 1, name: "科技", sortOrder: 0, createdAt: "2025-10-13T00:00:00.000Z" }]);
      if (path === "/api/feeds") return Promise.resolve([{ ...FEED, id: 5, title: "分类源", categoryId: 1 }]);
      if (path === "/api/stats") return Promise.resolve({ unreadTotal: 2, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      if (path === "/api/articles") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.resolve(null);
    });
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    container.querySelector<HTMLButtonElement>('button[aria-label="源管理菜单"]')!.click();
    await flush();
    expect(findButton(container, "编辑网址")).toBeTruthy();
  });
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @readly/web test -- src/components/__tests__/sidebar-actions.test.ts`
Expected: 新用例 FAIL(「编辑网址」按钮不存在,`findButton` 返回 undefined → `!.click()` 抛错 / `toBeTruthy` 失败)。

- [ ] **Step 3: 实现接线**

`web/src/components/Sidebar.vue` 三处修改:

① import 区(与既有 import 并列):

```ts
import FeedUrlEditor from "@/components/FeedUrlEditor.vue";
```

② 「源项管理菜单」状态区,`renameTitle` 之后加:

```ts
const editingUrlFeed = ref<Feed | null>(null);

function startEditUrl(feed: Feed): void {
  closeMenu();
  editingUrlFeed.value = feed;
}
```

③ 两处菜单模板(分类内列表约 279-283 行、未分类列表约 330-334 行),「重命名」按钮之后各加一行(两处完全一致):

```html
<button :class="menuItem" @click="startEditUrl(feed)">编辑网址</button>
```

④ 模板末尾,`</aside>` 之前挂弹窗:

```html
<FeedUrlEditor
  v-if="editingUrlFeed"
  :feed="editingUrlFeed"
  @close="editingUrlFeed = null"
  @saved="articles.markStale()"
/>
```

- [ ] **Step 4: 运行确认通过(文件 + 全量 web)**

Run: `pnpm --filter @readly/web test -- src/components/__tests__/sidebar-actions.test.ts`
Expected: 11 passed(原 9 + 新 2)。
Run: `pnpm --filter @readly/web test`
Expected: 260 passed(253 + 1 store + 4 组件 + 2 sidebar = 260)。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Sidebar.vue web/src/components/__tests__/sidebar-actions.test.ts
git commit -m "feat(web): 侧栏⋯菜单接入「编辑网址」(弹窗+成功标记列表失效)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 全量验证 + Chrome 浅/深视觉实测

**Files:**
- Create(验后删):`/tmp/readly-url-edit-verify.mjs`;截图存 `/tmp/readly-url-edit-*.png`。

**Interfaces:**
- Consumes:`web/dist`(`pnpm build` 产物)、headless Chrome(`/usr/bin/google-chrome`)、参考样板 `/tmp/readly-final-verify-final.mjs`(桩 API + CDP 直连,不依赖 Playwright 包)。
- Produces:验证报告(测试计数、对比度实测值、截图路径)。

- [ ] **Step 1: 全量测试与类型检查**

Run: `pnpm -r test`
Expected: worker 134 + web 260 全绿。
Run: `pnpm -r typecheck`
Expected: 无错误。

- [ ] **Step 2: 构建**

Run: `pnpm build`
Expected: `vue-tsc --noEmit && vite build` 成功。

- [ ] **Step 3: Chrome 浅/深实测**

参照 `/tmp/readly-final-verify-final.mjs` 搭建一次性脚本:
- 桩 API(`127.0.0.1:5101`,独立端口;不触碰用户 5173/8787)+ 静态服务 `web/dist`;CDP 端口 9535,profile `/tmp/readly-url-edit-chrome-profile`;预置 `localStorage.readly_token`。
- 桩 API 端点:`/api/categories`、`/api/feeds`(GET 返回一个源;PATCH:请求体 url 含 `127.0.0.1` → 400 `{ error: { code: "invalid_url", message: "不允许访问内网地址" } }`,否则 200 返回标题更新后的源)、`/api/stats`、`/api/articles`。
- 动线(浅色):
  1. 打开 `/` → ⋯ → 「编辑网址」→ 断言输入框预填原地址 → 截图 `readly-url-edit-light.png`;
  2. 输入 `http://127.0.0.1/rss` → 保存 → 断言 `[data-feed-url-error]` 文本 = 「不允许访问内网地址」、弹窗未关 → 截图 `readly-url-edit-light-error.png`;
  3. 输入 `https://new.example.com/rss` → 保存 → 断言弹窗关闭、侧栏出现新标题;
- 切换 `html.dark`(与生产同款 class 策略),重复打开弹窗 → 截图 `readly-url-edit-dark.png`、错误态截图 `readly-url-edit-dark-error.png`。
- 对比度实测(CDP `Runtime.evaluate` 取 computed color/background,按 WCAG 相对亮度算比值,记录实测值):
  - 说明行浅色 `neutral-500` / 白、深色 `neutral-400` / `neutral-900` ≥ 4.5;
  - 错误行浅色 `red-600` / 白、深色 `red-400` / `neutral-900` ≥ 4.5;
  - 主按钮白字 / `var(--accent)`(既有按钮模式,记录实测值)。
- 零未捕获异常、零意外 4xx/5xx;验后删除脚本。

- [ ] **Step 4: 记录**

将实测值、截图路径、测试计数写入交付汇报;如任一对比度 <4.5,回到 Task 3 调整色阶后重测(不得目视放行)。

---

## Self-Review 记录

- 规格覆盖:§3 路由(顺序/错误码/initialLimit)→ T1;§4 数据语义 → T1 用例 1(guid 三态断言);§5 store → T2;弹窗 → T3;Sidebar 接线 + markStale → T4;§6 测试矩阵 → T1/T2/T3/T4 全覆盖;§7 移动端(菜单项 `md:` 显隐随既有模板,无需额外代码)→ T4 模板紧随既有项;视觉验收纪律 → T5。
- 占位符扫描:无 TBD/TODO;所有步骤含完整代码与命令。
- 类型一致性:`editFeedUrl(feedId: number, url: string)`(T2)在 T3 弹窗按同签名调用;`[data-feed-url*]` 选择器三处(T3 组件、T3 测试、T4 测试)一致;错误码 `invalid_url`/`already_subscribed`/`fetch_failed`(T1)与 T3 测试断言 `ApiError.code` 一致。
- 计数核对:worker 128+6=134;web 253+1(T2 store)+4(T3 组件)+2(T4 sidebar)=260。以实际运行为准,若与预期不符须查明原因而非改数字。
