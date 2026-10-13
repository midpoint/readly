# Readly 全文抓取(计划 03 / M3)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 摘要过短时自动抓取原文并渲染:worker 新增 `/api/proxy/html`(复用 SSRF 闸门,回传原文 HTML),浏览器端用 Readability 提取 + 既有 DOMPurify 清洗流水线,结果持久化到 `content_full`;阅读器提供「抓取全文」手动入口、全文/摘要来源切换、失败的中文错误提示;抓取偏好(自动开关 + 阈值)进设置面板并跨设备同步。

**Architecture:** 抓取全部出站流量经 worker(浏览器直连原文站会被 CORS 挡)→ `fetchText`(Task 06 冻结的 SSRF/限额/超时闸门)新增暴露原始字节以支持 charset 解码;提取在客户端(`@mozilla/readability` + jsdom 里可跑的 DOMParser),**提取结果必须再经 `sanitizeArticleHtml`**(全系统唯一渲染清洗点,沿袭既有纪律);持久化走既有 `POST /api/articles/:id/fulltext`(512KB 上限)。抓取偏好复用 settings store 的「localStorage 即时 + D1 防抖」机制,新增独立切片 `fetchPrefs`。

**Tech Stack:** 既有栈 + `@mozilla/readability`(唯一新依赖)。

## Global Constraints

- **安全**:原文页抓取只允许经 `/api/proxy/html` → `fetchText`(内部 `assertSafeUrl` + 逐跳校验 + 3MB 截断 + 20s 超时);渲染路径只允许 `sanitizeArticleHtml` 产物进 `v-html`(提取结果必须过它,不得旁路)。
- `FetchPrefs`、`SETTING_KEYS.fetchPrefs`(`"fetch_prefs"`)是 `@readly/shared` 冻结类型;默认 `{ auto: true, minChars: 300 }`;`minChars` 钳制 [50, 5000] 整数。
- 自动抓取条件(打开文章时惰性判断,不批量预抓):`article.url` 存在 且 `contentFull` 为空 且 `fetchPrefs.auto` 且 正文纯文本长度 < `minChars`。
- 失败提示中文,分类明确:「抓取失败(HTTP xxx)」「该地址不是网页内容」「不允许访问内网地址」「抓取超时」「无法提取正文」;失败不自动重试。
- 持久化:`html.length > 512 * 1024` 时**不持久化**,仅本次内存渲染,并显示「文章较长,本次仅在本地显示」;持久化失败(网络)同样仅内存 + 静默。
- 抓取偏好双写语义与 ReaderPrefs 完全一致:localStorage 键 `readly_fetch_prefs`(即时 + flush:"sync"),D1 同一次 `PUT /api/settings` 携带 `reader_prefs` 与 `fetch_prefs` 两键;本地优先、防抖 1000ms、失败静默。**既有 settings 测试语义如需调整(零点请求用例需同时 seed 两个本地键)须在报告披露**。
- 视觉验收必须实测(headless Chrome,独立端口 4499,勿动用户 5173/8787),浅色+深色;新增文本/控件必须有深色配对。
- TypeScript strict;禁止 any;文案中文;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付;测试前先 `pnpm build`(worker assets 依赖)。

---

### Task 1: worker `/api/proxy/html`(+ fetchText 原始字节)

**Files:**
- Modify: `worker/src/lib/http.ts`(`FetchTextResult` 增加 `buffer: Uint8Array`;`readCapped` 一并返回)
- Create: `worker/src/routes/proxy.ts`
- Modify: `worker/src/index.ts`(挂载)
- Create: `worker/test/proxy.test.ts`
- Modify: `worker/test/http.test.ts`(追加 1 条 buffer 断言)

**Interfaces:**
- Consumes: `fetchText`(冻结,注意本次为**加字段式扩展**)、`fail/ok`、auth 中间件(全 `/api/*` 已覆盖)。
- Produces(冻结):
  - `FetchTextResult.buffer: Uint8Array`(原始响应字节;`body` 仍为 UTF-8 解码文本,语义不变)
  - `GET /api/proxy/html?url=` → `{ html: string; finalUrl: string; truncated: boolean }`;错误:`400 invalid_url|fetch_failed|unsupported_type`、`502 upstream_error|empty_body`
  - `decodeWithCharset(bytes: Uint8Array, contentType: string | null): string`(从 proxy.ts 导出,供单测;声明 charset 不受支持时回落 UTF-8)

- [ ] **Step 1: http.ts 暴露 buffer(失败测试→实现)**

`worker/test/http.test.ts` 在「超过 maxBytes 截断」用例断言后追加:

```ts
    expect(r.buffer.byteLength).toBe(100);
```

Run: `pnpm --filter @readly/worker test test/http.test.ts`
Expected: FAIL(buffer undefined)。

`worker/src/lib/http.ts`:
1. `FetchTextResult` 增加字段:

```ts
  buffer: Uint8Array;
```

2. `readCapped` 返回值改为 `{ body: string; truncated: boolean; bytes: Uint8Array }`:把现有的 merged 数组保留为 `bytes`,再解码出 `body`(现逻辑不变,只是不再丢弃 merged);空 body 分支返回 `{ body: "", truncated: false, bytes: new Uint8Array(0) }`。
3. 调用处 `return { status, headers, body: ..., finalUrl: current, truncated, buffer: bytes }`。

Run: 同上 Expected: PASS;再 `pnpm --filter @readly/worker test` 全绿(既有 115)。

- [ ] **Step 2: 失败测试(proxy 路由)**

`worker/test/proxy.test.ts`:

```ts
import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";
import { decodeWithCharset } from "../src/routes/proxy";

beforeAll(() => fetchMock.activate());
afterAll(() => fetchMock.deactivate());

beforeEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe("decodeWithCharset", () => {
  it("声明 utf-8 直接解码", () => {
    const bytes = new TextEncoder().encode("你好");
    expect(decodeWithCharset(bytes, "text/html; charset=utf-8")).toBe("你好");
  });
  it("未知编码名回落 UTF-8 不抛错", () => {
    const bytes = new TextEncoder().encode("ok");
    expect(decodeWithCharset(bytes, "text/html; charset=x-mystery")).toBe("ok");
  });
});

describe("GET /api/proxy/html", () => {
  it("正常回传 HTML 与 finalUrl", async () => {
    fetchMock.get("https://page.example.com").intercept({ path: "/article" }).reply(200, "<html><body><p>正文</p></body></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("https://page.example.com/article"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; finalUrl: string; truncated: boolean };
    expect(body.html).toContain("<p>正文</p>");
    expect(body.finalUrl).toBe("https://page.example.com/article");
    expect(body.truncated).toBe(false);
  });
  it("非网页类型 400", async () => {
    fetchMock.get("https://cdn.example.com").intercept({ path: "/a.pdf" }).reply(200, "%PDF-", { headers: { "Content-Type": "application/pdf" } });
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("https://cdn.example.com/a.pdf"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_type");
  });
  it("私网地址被 SSRF 闸门拒绝为 400", async () => {
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("http://127.0.0.1/x"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("内网");
  });
  it("上游 404 → 502", async () => {
    fetchMock.get("https://gone.example.com").intercept({ path: "/x" }).reply(404, "nope");
    const res = await apiFetch("/api/proxy/html?url=" + encodeURIComponent("https://gone.example.com/x"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_error");
  });
  it("缺少 url 参数 400", async () => {
    const res = await apiFetch("/api/proxy/html");
    expect(res.status).toBe(400);
  });
});
```

Run: `pnpm --filter @readly/worker test test/proxy.test.ts`
Expected: FAIL(路由不存在)。

- [ ] **Step 3: 实现并挂载**

`worker/src/routes/proxy.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../env";
import { fail, ok } from "../respond";
import { fetchText } from "../lib/http";

const proxy = new Hono<{ Bindings: Env }>();

const HTML_TYPES = ["text/html", "application/xhtml+xml"];

export function decodeWithCharset(bytes: Uint8Array, contentType: string | null): string {
  const m = /charset=([^\s;]+)/i.exec(contentType ?? "");
  const charset = m?.[1]?.replace(/["']/g, "").toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // workerd 不支持的编码名:回落 UTF-8
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

proxy.get("/proxy/html", async (c) => {
  const raw = c.req.query("url");
  if (!raw) return fail(c, 400, "invalid_url", "缺少 url 参数");
  let res;
  try {
    res = await fetchText(raw, {
      maxBytes: 3 * 1024 * 1024,
      timeoutMs: 20000,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    });
  } catch (e) {
    return fail(c, 400, "fetch_failed", e instanceof Error ? e.message : "抓取失败");
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(c, 502, "upstream_error", `抓取失败(HTTP ${res.status})`);
  }
  const ctype = (res.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!HTML_TYPES.includes(ctype)) return fail(c, 400, "unsupported_type", "该地址不是网页内容");
  const html = decodeWithCharset(res.buffer, res.headers.get("Content-Type"));
  if (!html.trim()) return fail(c, 502, "empty_body", "页面内容为空");
  return ok(c, { html, finalUrl: res.finalUrl, truncated: res.truncated });
});

export default proxy;
```

`worker/src/index.ts`:import 与挂载各加一行(与既有路由同款):

```ts
import proxy from "./routes/proxy";
// 既有 app.route 之后:
app.route("/api", proxy);
```

Run: `pnpm --filter @readly/worker test`
Expected: 全绿(115 → 约 122,以实际为准)。

- [ ] **Step 4: 提交**

```bash
git add worker
git commit -m "feat(worker): /api/proxy/html 全文抓取代理(charset 解码,fetchText 暴露原始字节)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: web 提取模块(Readability + 清洗 + 绝对化)

**Files:**
- Modify: `web/package.json`(依赖 `@mozilla/readability`)
- Create: `web/src/modules/extract.ts`
- Create: `web/src/modules/__tests__/extract.test.ts`

**Interfaces:**
- Consumes: `sanitizeArticleHtml`(冻结,唯一渲染清洗点)
- Produces(冻结):
  - `interface ExtractResult { title: string | null; html: string; textLength: number }`
  - `extractFromHtml(pageHtml: string, pageUrl: string): ExtractResult`(无正文抛 `Error("无法提取正文")`)
  - `plainTextLength(html: string | null | undefined): number`(去标签去空白后的字符数)

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @readly/web add @mozilla/readability@^0.6`
(范围解析不到取 latest 并记录。)

- [ ] **Step 2: 失败测试**

`web/src/modules/__tests__/extract.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractFromHtml, plainTextLength } from "@/modules/extract";

const PAGE = `<!doctype html><html><head><title>页面标题</title></head><body>
<nav>导航导航导航</nav>
<article>
  <h1>真正的文章标题</h1>
  <p>第一段内容,这里是一段足够长的正文文本,用于通过 Readability 的阈值判断。需要重复足够多的字符才能稳定提取,所以这句话再写一遍。</p>
  <p>第二段内容,继续提供足量的正文文本以保证提取器认为这是文章主体而不是导航或页脚。再多写一些字凑长度,凑到几百个字符以上。</p>
  <p>第三段内容,同样需要足够的文本量,继续补充文字以达到阈值要求,让提取结果稳定可靠不随字数波动。</p>
  <p>第四段内容,收尾段落,依旧保持一定的文本长度,确保整体正文字数远超最小阈值,使测试不受实现细节影响。</p>
  <img src="/img/photo.png" alt="图">
  <a href="/relative/link">站内链接</a>
</article>
<footer>页脚页脚</footer>
</body></html>`;

describe("extractFromHtml", () => {
  it("提取正文并绝对化相对 URL,经 sanitizeArticleHtml 清洗", () => {
    const r = extractFromHtml(PAGE, "https://news.example.com/post/1");
    expect(r.html).toContain("第一段内容");
    expect(r.html).not.toContain("<nav>");
    expect(r.textLength).toBeGreaterThan(150);
    expect(r.title).toContain("标题");
    expect(r.html).toContain('src="https://news.example.com/img/photo.png"');
    expect(r.html).toContain('href="https://news.example.com/relative/link"');
  });

  it("无正文时抛「无法提取正文」", () => {
    expect(() => extractFromHtml("<html><body><p>太短</p></body></html>", "https://x.example.com/")).toThrow(/无法提取正文/);
  });
});

describe("plainTextLength", () => {
  it("去标签与空白后计长;空值 0", () => {
    expect(plainTextLength("<p>你好 世界</p>")).toBe(4);
    expect(plainTextLength(null)).toBe(0);
    expect(plainTextLength("  ")).toBe(0);
  });
});
```

Run: `pnpm --filter @readly/web test src/modules/__tests__/extract.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 extract.ts**

```ts
import { Readability } from "@mozilla/readability";
import { sanitizeArticleHtml } from "./render";

export interface ExtractResult {
  title: string | null;
  html: string;
  textLength: number;
}

function absoluteize(html: string, base: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  if (!root) return html;
  const fix = (el: Element, attr: string): void => {
    const v = el.getAttribute(attr);
    if (!v) return;
    try {
      el.setAttribute(attr, new URL(v, base).toString());
    } catch {
      // 保留原值
    }
  };
  for (const a of Array.from(root.querySelectorAll("a[href]"))) fix(a, "href");
  for (const img of Array.from(root.querySelectorAll("img[src]"))) fix(img, "src");
  return root.innerHTML;
}

export function extractFromHtml(pageHtml: string, pageUrl: string): ExtractResult {
  const doc = new DOMParser().parseFromString(pageHtml, "text/html");
  if (!doc.querySelector("base")) {
    const base = doc.createElement("base");
    base.setAttribute("href", pageUrl);
    doc.head.prepend(base);
  }
  const parsed = new Readability(doc).parse();
  if (!parsed || !parsed.content) throw new Error("无法提取正文");
  // 先过唯一渲染清洗点,再做 URL 绝对化(清洗含 data-src→src 提升,顺序不可反)
  const clean = absoluteize(sanitizeArticleHtml(parsed.content), pageUrl);
  const text = (parsed.textContent ?? "").replace(/\s+/g, " ").trim();
  return { title: parsed.title ?? null, html: clean, textLength: text.length };
}

export function plainTextLength(html: string | null | undefined): number {
  if (!html) return 0;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, "").length;
}
```

Run: 同上 Expected: PASS;全量 `pnpm --filter @readly/web test` 与 `typecheck` 全绿。

- [ ] **Step 4: 提交**

```bash
git add web/package.json web/src/modules pnpm-lock.yaml
git commit -m "feat(web): Readability 提取模块(清洗复用+URL 绝对化)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 抓取接线(偏好切片 + reader store + UI + 设置面板 + README)

**Files:**
- Modify: `web/src/stores/settings.ts`(新增 `fetchPrefs` 切片:`sanitizeFetchPrefs`/`updateFetchPrefs`/双键 PUT)
- Modify: `web/src/stores/__tests__/settings.test.ts`(调整 1 条既有用例 + 追加 3 条)
- Modify: `web/src/stores/reader.ts`(`fullTextLoading/fullTextError/fullTextNote`、`fetchFullText`、自动触发)
- Create: `web/src/stores/__tests__/reader.test.ts`
- Modify: `web/src/components/ReaderPane.vue`(工具栏按钮、来源切换条、错误提示、`showOriginal`)
- Create: `web/src/components/__tests__/reader-fulltext.test.ts`
- Modify: `web/src/components/ThemePanel.vue`(「全文抓取」设置区)
- Modify: `README.md`(功能 3 移除「(计划 03)」标注)
- Create(验后删): `web/scripts/verify-fulltext.mjs`

**Interfaces:**
- Consumes: Task 1 的 `/api/proxy/html`、Task 2 的 `extractFromHtml/plainTextLength`、既有 `POST /api/articles/:id/fulltext`、`FetchPrefs/SETTING_KEYS.fetchPrefs`
- Produces(冻结):
  - `settings store` 新增:`fetchPrefs: Ref<FetchPrefs>`、`updateFetchPrefs(patch: Partial<FetchPrefs>): void`、`sanitizeFetchPrefs(raw: unknown): FetchPrefs`(导出);localStorage 键 `readly_fetch_prefs`
  - `reader store` 新增:`fullTextLoading: Ref<boolean>`、`fullTextError: Ref<string | null>`、`fullTextNote: Ref<string | null>`、`fetchFullText(): Promise<void>`;`open()` 在满足自动条件时触发 `fetchFullText`(fire-and-forget)
  - ReaderPane 稳定选择器:`[data-fetch-fulltext]`(手动按钮)、`[data-fulltext-source]`(来源条)、`[data-toggle-original]`(摘要/全文切换)

- [ ] **Step 1: settings store 的 fetchPrefs 切片(失败测试→实现)**

`web/src/stores/__tests__/settings.test.ts` 调整与追加:

1. 既有「initRemote:本地已有偏好时本地优先,不回写」用例:在设置 `readly_prefs` 的同时**也写入** `localStorage.setItem("readly_fetch_prefs", JSON.stringify({ auto: true, minChars: 300 }))`(保持「本地全有 → 零请求」的用例意图;在报告披露此调整)。
2. 追加:

```ts
  it("sanitizeFetchPrefs:缺省 true/300,阈值钳制 [50,5000]", () => {
    expect(sanitizeFetchPrefs({})).toEqual({ auto: true, minChars: 300 });
    expect(sanitizeFetchPrefs({ auto: false, minChars: 1 })).toEqual({ auto: false, minChars: 50 });
    expect(sanitizeFetchPrefs({ minChars: 99999 })).toEqual({ auto: true, minChars: 5000 });
    expect(sanitizeFetchPrefs("junk")).toEqual({ auto: true, minChars: 300 });
  });

  it("本地无 fetch 偏好时 initRemote 采用服务端 fetch_prefs", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify(DEFAULT_READER_PREFS)); // 仅本地有阅读偏好
    vi.mocked(api).mockResolvedValue({ fetch_prefs: { auto: false, minChars: 500 } });
    const store = useSettingsStore();
    store.initLocal();
    await store.initRemote();
    expect(store.fetchPrefs).toEqual({ auto: false, minChars: 500 });
  });

  it("updateFetchPrefs 写本地并防抖推送(与阅读偏好同一 PUT 双键)", async () => {
    vi.mocked(api).mockResolvedValue({ ok: true });
    const store = useSettingsStore();
    store.initLocal();
    store.updateFetchPrefs({ minChars: 800 });
    expect(JSON.parse(localStorage.getItem("readly_fetch_prefs")!).minChars).toBe(800);
    await vi.advanceTimersByTimeAsync(1100);
    const call = vi.mocked(api).mock.calls.at(-1)!;
    expect(call[0]).toBe("/api/settings");
    const kv = (call[1]!.body as { kv: Record<string, unknown> }).kv;
    expect(kv.reader_prefs).toBeDefined();
    expect((kv.fetch_prefs as { minChars: number }).minChars).toBe(800);
  });
```

Run: 该文件 Expected: FAIL(导出缺失)。

`web/src/stores/settings.ts` 实现(逐处):

1. import 行扩为 `import { DEFAULT_READER_PREFS, SETTING_KEYS, type FetchPrefs, type ReaderPrefs } from "@readly/shared";`
2. 顶部常量与 sanitize 追加:

```ts
const FETCH_LS_KEY = "readly_fetch_prefs";

export const DEFAULT_FETCH_PREFS: FetchPrefs = { auto: true, minChars: 300 };

export function sanitizeFetchPrefs(raw: unknown): FetchPrefs {
  const d = DEFAULT_FETCH_PREFS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    auto: o.auto !== false,
    minChars: clampNumber(o.minChars, 50, 5000, d.minChars),
  };
}

function readLocalFetch(): FetchPrefs | null {
  const raw = localStorage.getItem(FETCH_LS_KEY);
  if (!raw) return null;
  try {
    return sanitizeFetchPrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}
```

3. store 内新增状态与基线:

```ts
  const fetchPrefs = ref<FetchPrefs>({ ...DEFAULT_FETCH_PREFS });
  let fetchServerCopy: string | null = null;
```

4. `initLocal` 追加(`apply()` 之后):

```ts
    const localFetch = readLocalFetch();
    if (localFetch) fetchPrefs.value = localFetch;
```

5. `initRemote` 整体替换为(阅读偏好语义保持不变;两侧各自独立短路):

```ts
  async function initRemote(): Promise<void> {
    if (readLocal() !== null && readLocalFetch() !== null) {
      serverCopy = JSON.stringify(readLocal());
      fetchServerCopy = JSON.stringify(readLocalFetch());
      return;
    }
    const all = await api<Record<string, unknown>>("/api/settings");
    if (readLocal() === null) {
      const serverPrefs = all[SETTING_KEYS.readerPrefs];
      if (serverPrefs !== undefined) {
        serverCopy = JSON.stringify(sanitizePrefs(serverPrefs));
        // GET 在途期间本地被写入时,本地为真源,不再套用服务端快照
        if (readLocal() === null) {
          prefs.value = sanitizePrefs(serverPrefs);
          apply();
        }
      }
    }
    if (readLocalFetch() === null) {
      const serverFetch = all[SETTING_KEYS.fetchPrefs];
      if (serverFetch !== undefined) {
        fetchServerCopy = JSON.stringify(sanitizeFetchPrefs(serverFetch));
        if (readLocalFetch() === null) {
          fetchPrefs.value = sanitizeFetchPrefs(serverFetch);
        }
      }
    }
  }
```

6. `updateFetchPrefs` 与 `pushRemote` 双键:

```ts
  function updateFetchPrefs(patch: Partial<FetchPrefs>): void {
    fetchPrefs.value = sanitizeFetchPrefs({ ...fetchPrefs.value, ...patch });
  }

  async function pushRemote(): Promise<void> {
    const serialized = JSON.stringify(prefs.value);
    const serializedFetch = JSON.stringify(fetchPrefs.value);
    if (serialized === serverCopy && serializedFetch === fetchServerCopy) return;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          kv: {
            [SETTING_KEYS.readerPrefs]: prefs.value,
            [SETTING_KEYS.fetchPrefs]: fetchPrefs.value,
          },
        },
      });
      serverCopy = serialized;
      fetchServerCopy = serializedFetch;
    } catch {
      // 静默:本地为真源,下次变更再试
    }
  }
```

7. 第二个 watch(fetchPrefs,与 prefs 同款:写本地 + 共用 putTimer 防抖)与 return 导出:

```ts
  watch(
    fetchPrefs,
    () => {
      localStorage.setItem(FETCH_LS_KEY, JSON.stringify(fetchPrefs.value));
      if (putTimer) clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        void pushRemote();
      }, PUT_DEBOUNCE_MS);
    },
    { deep: true, flush: "sync" }
  );

  return { prefs, fetchPrefs, ready, initLocal, initRemote, initSystemWatch, updatePrefs, updateFetchPrefs, resetPrefs, flushPrefs };
```

Run: 该文件 PASS;全量 web 套件与 typecheck。

- [ ] **Step 2: reader store 抓取流程(失败测试→实现)**

`web/src/stores/__tests__/reader.test.ts`:

```ts
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/modules/extract", () => ({
  extractFromHtml: vi.fn(() => ({ title: "T", html: "<p>完整正文</p>", textLength: 4 })),
  plainTextLength: vi.fn(() => 100),
}));

const ARTICLE = {
  id: 1, feedId: 1, feedTitle: "F", feedIconUrl: null, title: "标题", url: "https://n.example.com/a",
  author: null, publishedAt: "2026-01-01T00:00:00.000Z", excerpt: "短摘要", imageUrl: null,
  isRead: false, isStarred: false, isLater: false, hasFullText: false,
  content: "<p>短</p>", contentFull: null, aiSummary: null, aiTranslation: null, extractedAt: null,
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
});

describe("reader 全文抓取", () => {
  it("自动抓取:短文+auto=true 时 open 后走代理→提取→持久化", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.resolve({ html: "<html>…</html>", finalUrl: ARTICLE.url, truncated: false });
      if (path === "/api/articles/1/fulltext" && opts?.method === "POST") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal(); // 默认 auto=true, minChars=300;plainTextLength mock 返回 100 < 300
    const reader = useReaderStore();
    await reader.open(1);
    await vi.waitFor(() => expect(reader.article?.contentFull).toBe("<p>完整正文</p>"));
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/proxy/html", expect.objectContaining({ query: { url: ARTICLE.url } }));
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/articles/1/fulltext", expect.objectContaining({ method: "POST" }));
    expect(reader.fullTextError).toBeNull();
  });

  it("auto=false 不自动抓取;手动 fetchFullText 仍可用", async () => {
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.resolve({ html: "<html/>", finalUrl: ARTICLE.url, truncated: false });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    settings.updateFetchPrefs({ auto: false });
    const reader = useReaderStore();
    await reader.open(1);
    await Promise.resolve();
    expect(vi.mocked(api).mock.calls.some(([p]) => p === "/api/proxy/html")).toBe(false);
    await reader.fetchFullText();
    expect(reader.article?.contentFull).toBe("<p>完整正文</p>");
  });

  it("抓取失败写入 fullTextError", async () => {
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...ARTICLE });
      if (path === "/api/proxy/html") return Promise.reject(new Error("抓取超时"));
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    settings.initLocal();
    const reader = useReaderStore();
    await reader.open(1);
    await expect(reader.fetchFullText()).rejects.toThrow("抓取超时");
    expect(reader.fullTextError).toBe("抓取超时");
  });
});
```

Run: `pnpm --filter @readly/web test src/stores/__tests__/reader.test.ts`
Expected: FAIL。

`web/src/stores/reader.ts` 实现:import 区追加:

```ts
import { extractFromHtml, plainTextLength } from "@/modules/extract";
import { useSettingsStore } from "./settings";
```

store 内新增:

```ts
  const fullTextLoading = ref(false);
  const fullTextError = ref<string | null>(null);
  const fullTextNote = ref<string | null>(null);
```

`open()` 改为(其余不动):

```ts
  async function open(id: number): Promise<void> {
    loading.value = true;
    fullTextError.value = null;
    fullTextNote.value = null;
    try {
      article.value = await api<ArticleDetail>(`/api/articles/${id}`);
      useArticlesStore().currentId = id;
    } finally {
      loading.value = false;
    }
    maybeAutoExtract();
  }
```

新增函数:

```ts
  function maybeAutoExtract(): void {
    const a = article.value;
    if (!a || !a.url || a.contentFull) return;
    const fp = useSettingsStore().fetchPrefs;
    if (!fp.auto) return;
    if (plainTextLength(a.content ?? a.excerpt) >= fp.minChars) return;
    void fetchFullText().catch(() => undefined);
  }

  async function fetchFullText(): Promise<void> {
    const a = article.value;
    if (!a || !a.url || fullTextLoading.value) return;
    fullTextLoading.value = true;
    fullTextError.value = null;
    fullTextNote.value = null;
    try {
      const res = await api<{ html: string }>("/api/proxy/html", { query: { url: a.url } });
      const result = extractFromHtml(res.html, a.url);
      if (article.value?.id !== a.id) return; // 中途切文,丢弃结果
      if (result.html.length > 512 * 1024) {
        article.value.contentFull = result.html;
        fullTextNote.value = "文章较长,本次仅在本地显示";
        return;
      }
      article.value.contentFull = result.html;
      article.value.extractedAt = new Date().toISOString();
      useArticlesStore().patchItemLocally(a.id, { hasFullText: true });
      try {
        await api(`/api/articles/${a.id}/fulltext`, { method: "POST", body: { content_full: result.html } });
      } catch {
        fullTextNote.value = "全文已提取,但保存失败(本次仅本地可见)";
      }
    } catch (e) {
      fullTextError.value = e instanceof Error ? e.message : "抓取失败";
      throw e;
    } finally {
      fullTextLoading.value = false;
    }
  }
```

return 追加 `fullTextLoading, fullTextError, fullTextNote, fetchFullText`。

Run: 该文件 PASS;全量 web。

- [ ] **Step 3: ReaderPane UI(失败测试→实现)**

`web/src/components/__tests__/reader-fulltext.test.ts`:

```ts
// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { api } from "@/api/client";
import ReaderPane from "@/components/ReaderPane.vue";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/modules/extract", () => ({
  extractFromHtml: vi.fn(() => ({ title: "T", html: "<p>完整正文</p>", textLength: 4 })),
  plainTextLength: vi.fn(() => 9999),
}));

const BASE = {
  id: 1, feedId: 1, feedTitle: "F", feedIconUrl: null, title: "标题", url: "https://n.example.com/a",
  author: null, publishedAt: "2026-01-01T00:00:00.000Z", excerpt: "短摘要", imageUrl: null,
  isRead: true, isStarred: false, isLater: false, hasFullText: false,
  content: "<p>订阅摘要正文</p>", contentFull: null, aiSummary: null, aiTranslation: null, extractedAt: null,
};

let app: App | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

async function mountWith(article: Record<string, unknown>) {
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/articles/1") return Promise.resolve({ ...BASE, ...article });
    if (path === "/api/proxy/html") return Promise.resolve({ html: "<html/>", finalUrl: BASE.url, truncated: false });
    return Promise.resolve({});
  });
  const settings = useSettingsStore();
  settings.initLocal();
  settings.updateFetchPrefs({ auto: false });
  app = createApp(ReaderPane);
  app.use(createPinia());
  app.mount(host!);
  const reader = useReaderStore();
  await reader.open(1);
  await nextTick();
}

describe("ReaderPane 全文 UI", () => {
  it("已有全文:默认显示全文+来源条,切「显示摘要」回摘要", async () => {
    await mountWith({ contentFull: "<p>抓取后的完整正文</p>", hasFullText: true });
    expect(host!.textContent).toContain("抓取后的完整正文");
    expect(host!.querySelector("[data-fulltext-source]")).not.toBeNull();
    host!.querySelector<HTMLButtonElement>("[data-toggle-original]")!.click();
    await nextTick();
    expect(host!.textContent).toContain("订阅摘要正文");
    expect(host!.textContent).not.toContain("抓取后的完整正文");
  });

  it("无全文:点「抓取全文」调 store,失败显示中文错误", async () => {
    await mountWith({});
    const btn = host!.querySelector<HTMLButtonElement>("[data-fetch-fulltext]")!;
    btn.click();
    await vi.waitFor(() => expect(host!.textContent).toContain("完整正文"));
    // 失败路径
    await mountWith({});
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles/1") return Promise.resolve({ ...BASE });
      if (path === "/api/proxy/html") return Promise.reject(new Error("抓取超时"));
      return Promise.resolve({});
    });
    host!.querySelector<HTMLButtonElement>("[data-fetch-fulltext]")!.click();
    await vi.waitFor(() => expect(host!.textContent).toContain("抓取超时"));
  });
});
```

Run: 该文件 Expected: FAIL(选择器不存在)。

`web/src/components/ReaderPane.vue` 实现:

1. script 追加:

```ts
const showOriginal = ref(false);
const useFull = computed(() => Boolean(reader.article?.contentFull) && !showOriginal.value);
const html = computed(() => {
  const a = reader.article;
  if (!a) return "";
  return sanitizeArticleHtml(useFull.value && a.contentFull ? a.contentFull : a.content);
});
watch(
  () => reader.article?.id,
  () => {
    showOriginal.value = false;
  }
);
```

(原 `const html = computed(...)` 行删除并以上替代。)

2. 工具栏按钮组:`Aa 主题` 按钮之前插入:

```vue
            <button
              v-if="reader.article.url"
              data-fetch-fulltext
              :class="[btn, 'disabled:opacity-50']"
              :disabled="reader.fullTextLoading"
              @click="void reader.fetchFullText().catch(() => undefined)"
            >
              {{ reader.fullTextLoading ? "抓取中…" : reader.article.contentFull ? "重新抓取" : "抓取全文" }}
            </button>
```

3. header 内错误与提示行(h2 之后):

```vue
        <p v-if="reader.fullTextError" class="mt-1 text-xs text-red-600 dark:text-red-400">抓取失败:{{ reader.fullTextError }}</p>
```

4. 来源条:滚动容器内 `article` 之前插入:

```vue
          <div
            v-if="reader.article.contentFull"
            data-fulltext-source
            class="mx-auto mt-3 flex w-full max-w-[var(--reader-width,720px)] items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
          >
            <span>全文来自原文页{{ reader.fullTextNote ? ` · ${reader.fullTextNote}` : "" }}</span>
            <button data-toggle-original class="shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="showOriginal = !showOriginal">
              {{ showOriginal ? "显示全文" : "显示摘要" }}
            </button>
          </div>
```

Run: 该文件 PASS;全量 web。

- [ ] **Step 4: ThemePanel「全文抓取」区**

在「已读策略」section 之后追加:

```vue
    <div :class="section">
      <p :class="label">全文抓取</p>
      <label class="mt-1.5 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" :checked="settings.fetchPrefs.auto" class="accent-[var(--accent)]" @change="settings.updateFetchPrefs({ auto: ($event.target as HTMLInputElement).checked })" />
        摘要过短时自动抓取原文
      </label>
      <label class="mt-1 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        阈值(字)
        <input
          type="number"
          min="50"
          max="5000"
          step="50"
          :value="settings.fetchPrefs.minChars"
          class="w-20 rounded-md border border-neutral-300 bg-transparent px-2 py-0.5 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
          @change="settings.updateFetchPrefs({ minChars: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>
    </div>
```

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build` 全绿。

- [ ] **Step 5: README 更新**

`README.md` 功能第 3 条:去掉「(计划 03)」标注,改为:

```markdown
3. 全文抓取:摘要过短时自动抓取原文(浏览器端 Readability 提取,服务端仅做代理)
```

- [ ] **Step 6: Chrome 实测(浅+深)**

`web/scripts/verify-fulltext.mjs`(一次性,验后删):构建产物 + 独立端口 4499 桩(`/api/articles/1` 返回短摘要文章;`/api/proxy/html` 返回 ≥4 段的 fixture 文章页;支持 `?fail=1` 变体返回 403 以测错误路径;注入 `readly_token`),CDP 驱动,断言并记录:
1. 打开短文 → 自动抓取:正文出现 fixture 特征段落、来源条 `[data-fulltext-source]` 出现、`POST /api/articles/1/fulltext` 已被调用;
2. 点「显示摘要」→ 回订阅摘要;再点「显示全文」→ 回全文;
3. 失败路径:`/api/proxy/html` 返回 403 桩变体 → 头部出现「抓取失败:…」中文提示,无崩溃;
4. 手动「抓取全文」按钮在无全文时存在且可点;
5. 切暗色重测 1–2 的 DOM 断言;记录来源条与错误文本的对比度(≥4.5:1);
6. 截图 `/tmp/readly-fulltext-light.png`、`/tmp/readly-fulltext-dark.png`、失败态 `/tmp/readly-fulltext-error.png`。

Run: `pnpm build && node web/scripts/verify-fulltext.mjs`
Expected: 全部断言通过;数值与截图名记入报告;验后删除脚本。

- [ ] **Step 7: 提交**

```bash
git add web README.md
git commit -m "feat(web): 全文抓取接线(自动/手动、来源切换、抓取偏好设置)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 后续计划索引

- **计划 04 — 本地分析(M4)**:IDB 镜像、事件聚类、关键词监控(全程本地计算)。
- **计划 05 — TTS + AI(M5+M6)**:朗读与摘要翻译(引入 /settings 设置页)。
- **计划 06 — 收尾(M7)**。

## 自检记录(writing-plans self-review)

- **规格覆盖**:设计 §8.3 全项——客户端流水线(代理→解析→清洗→绝对化→渲染→持久化)→ Task 1/2/3;自动条件(auto + minChars 300)→ Task 3 store;手动词条与失败提示文案 → Task 3 UI;「全文来自原文页」来源标记与摘要切换 → Task 3;抓取偏好设置 → Task 3 面板区。
- **与冻结接口**:`FetchPrefs/SETTING_KEYS.fetchPrefs/ArticleDetail.extractedAt/POST fulltext(512KB)` 全部复用;`fetchText` 仅加字段(buffer)不改既有语义(既有 115 测试须全绿)。
- **有意决策**:① 提取在主线程(页面级一次性操作,不上 worker;记录为已知取舍);② >512KB 不持久化(规格上限)仅内存展示 + 提示;③ 片段回归测试 mock `@/modules/extract`(jsdom 里的 Readability 由 Task 2 单测覆盖,store/组件测试只钉接线);④ 既有 settings「零请求」用例需同 seed 两个本地键(报告须披露)。
- **类型一致性**:`extractFromHtml/plainTextLength` 三处调用(store/测试/未来 plan)签名一致;reader store 新导出五件在 ReaderPane 与测试中同名;选择器 `data-fetch-fulltext/data-fulltext-source/data-toggle-original` 三处一致。
