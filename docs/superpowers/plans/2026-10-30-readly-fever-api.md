# Fever API 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Readly 通过独立 Fever 密码向 Reeder Classic、Unread、FeedMe 等客户端提供 Fever API 的读取与已读/收藏写操作。

**Architecture:** 在现有 Hono Worker 根部新增独立 Fever 子应用,复用 D1 的 `categories` / `feeds` / `articles` / `article_states` / `settings` 表;不新增表、不改 `/api/*` 鉴权。Fever 凭据以 `settings.fever_auth` 保存,由设置页管理;API key 用内置 MD5 校验。前端新增与 GReader 同构的 `FeverSettings` 组件。

**Tech Stack:** TypeScript, Hono, Cloudflare Workers + D1, Vue 3, Vitest, `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Fever 未配置或鉴权失败:HTTP 200,响应体只有 `{"api_version":3,"auth":0}`;不得返回 401。
- 成功响应必须包含 `api_version: 3`、`auth: 1`、`last_refreshed_on_time`(Unix 秒,数字)。
- `api_key = md5(username + ":" + password)`,比较大小写不敏感且使用 `timingSafeEqualStr`。
- 密码为 32 位小写 hex,明文存 `settings.fever_auth`,不新增数据库迁移。
- 每条 `items` 最多 50 条;`total_items` 始终是全部文章数。
- 所有 Fever 响应带 `Cache-Control: no-store`,仅 JSON(不支持 XML)。
- 所有 D1 批量 ID 操作使用 `json_each(?)`,不得拼接逗号字符串进 SQL,不得依赖超过 100 个绑定参数。
- 不实现 favicon 字节、Hot Links、Sparks、XML、订阅 CRUD、刷新、稍后读映射。
- 收藏映射为 `article_states.is_starred`;已读映射为 `is_read`。
- 设置页新组件必须同时声明浅色/深色文本与背景类名。

---

### Task 1: 共享类型与 MD5

**Files:**
- Modify: `shared/src/index.ts`
- Create: `worker/src/lib/md5.ts`
- Test: `worker/test/md5.test.ts`

**Interfaces:**
- Produces: `FeverAuth { username: string; password: string }`, `FEVER_USERNAME = "readly"`, `SETTING_KEYS.feverAuth = "fever_auth"`.
- Produces: `md5Hex(input: string): string` — UTF-8 输入,输出 32 位小写 hex。

- [ ] **Step 1: 写失败测试** `worker/test/md5.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/lib/md5";

describe("md5Hex", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
    ["中文", "a7bac2239fcdcb3a067903d8077c4a07"],
    ["readly:0123456789abcdef0123456789abcdef", "b580a0c062176f0a30727fa9b23682f2"],
  ])("md5(%j) = %s", (input, expected) => {
    expect(md5Hex(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/worker exec vitest run test/md5.test.ts`
Expected: FAIL,`Cannot find module ../src/lib/md5`。

- [ ] **Step 3: 加共享类型**

在 `shared/src/index.ts` 的 `GReaderAuth` 后加入:

```ts
export interface FeverAuth {
  username: string;
  password: string;
}

export const FEVER_USERNAME = "readly";
```

并在 `SETTING_KEYS` 内追加 `feverAuth: "fever_auth",`。

- [ ] **Step 4: 实现 MD5**

`worker/src/lib/md5.ts`:实现 RFC 1321 MD5。使用 `TextEncoder` 得到 UTF-8 字节;补 `0x80`、补零到 56 mod 64、追加 64 位小端 bit 长度;64 字节分组,四轮 64 步,常量 `K[i] = floor(abs(sin(i+1)) * 2^32) >>> 0`,移位表按轮分别为 `[7,12,17,22]`、`[5,9,14,20]`、`[4,11,16,23]`、`[6,10,15,21]`;输出 a/b/c/d 小端 hex。不要引入依赖。

- [ ] **Step 5: 运行测试与类型检查**

Run:
```bash
pnpm --filter @readly/worker exec vitest run test/md5.test.ts
pnpm --filter @readly/shared typecheck 2>/dev/null || true
```
Expected: 7 passed。

- [ ] **Step 6: 提交**

```bash
git add shared/src/index.ts worker/src/lib/md5.ts worker/test/md5.test.ts
git commit -m "feat(fever): 添加共享凭据类型与 MD5"
```

---

### Task 2: Fever 读端点与认证

**Files:**
- Create: `worker/src/routes/fever.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/fever.test.ts`

**Interfaces:**
- Consumes: `GETTING_KEYS.feverAuth`, `FEVER_USERNAME`, `md5Hex`, `timingSafeEqualStr`, `getSetting`, `unixSeconds`.
- Produces: 默认导出 `fever` Hono 子应用;在 `GET|POST /fever`、`/fever/`、`/fever.php` 返回 JSON。

- [ ] **Step 1: 写鉴权与读取测试**

在 `worker/test/fever.test.ts` 建立测试脚手架:

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FEVER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { md5Hex } from "../src/lib/md5";
import { putSetting } from "../src/lib/settings";

const PASSWORD = "0123456789abcdef0123456789abcdef";
const KEY = md5Hex(`${FEVER_USERNAME}:${PASSWORD}`);

async function enable(): Promise<void> {
  await putSetting(env.DB, SETTING_KEYS.feverAuth, { username: FEVER_USERNAME, password: PASSWORD });
}

function fever(query = "", init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://example.com/fever/?${query}`, init);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
});
```

测试至少覆盖:
- 未配置时 `GET /fever/?api` 返回 200 `{api_version:3,auth:0}` 且无 `last_refreshed_on_time`。
- 配置后 `POST /fever/?api` 带 `api_key` 表单返回 `{api_version:3,auth:1,last_refreshed_on_time:0}`。
- 大写 `api_key` 也可用;错误 key 返回 auth 0;配置为 null 返回 auth 0。
- `/fever`、`/fever/`、`/fever.php` 均可访问;`Cache-Control: no-store`。
- seed 两个分类(其中一个空)、三个源(其中一个未分类、两个有 `last_fetched_at`),断言 `groups`、`feeds`、`feeds_groups` 的完整字段与排序。
- `favicons`、`links` 空数组。
- 无 Bearer 访问 Fever 成功;`/api/articles` 无 Bearer 仍 401。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/worker exec vitest run test/fever.test.ts`
Expected: FAIL,路由 404。

- [ ] **Step 3: 实现参数与鉴权**

`worker/src/routes/fever.ts`:

```ts
import { Hono } from "hono";
import { FEVER_USERNAME, SETTING_KEYS, type FeverAuth } from "@readly/shared";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth";
import { md5Hex } from "../lib/md5";
import { getSetting } from "../lib/settings";
import { unixSeconds } from "../lib/greader";

const NO_STORE = { "Cache-Control": "no-store" };
const fever = new Hono<{ Bindings: Env }>();

async function loadCredentials(db: D1Database): Promise<FeverAuth | null> {
  const value = await getSetting<FeverAuth | null>(db, SETTING_KEYS.feverAuth, null);
  if (!value || typeof value.username !== "string" || !value.username) return null;
  if (typeof value.password !== "string" || !value.password) return null;
  return { username: value.username, password: value.password };
}

async function collectParams(c: Context<{ Bindings: Env }>): Promise<Map<string, string>> {
  const params = new Map<string, string>();
  new URL(c.req.url).searchParams.forEach((value, key) => params.set(key, value));
  if (c.req.method === "POST") {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      for (const [key, value] of Object.entries(body)) if (typeof value === "string") params.set(key, value);
    } else {
      const form = await c.req.raw.formData().catch(() => null);
      form?.forEach((value, key) => { if (typeof value === "string") params.set(key, value); });
    }
  }
  return params;
}
```

认证失败仅返回 `c.json({ api_version: 3, auth: 0 }, 200, NO_STORE)`。成功基线用 `SELECT MAX(last_fetched_at) AS t FROM feeds`,经 `unixSeconds` 转数字。

- [ ] **Step 4: 实现 groups / feeds / favicons / links**

- 分类: `SELECT id, title FROM categories ORDER BY sort_order, id`。
- 源: `SELECT id, url, site_url, title, category_id, last_fetched_at FROM feeds ORDER BY sort_order, id`。
- `feeds_groups` 仅含 `category_id` 非空且有源的分类;feed_ids 升序逗号连接。
- `groups` 键存在时附加 `groups` + `feeds_groups`;`feeds` 键存在时附加 `feeds` + `feeds_groups`;两者同时存在时只输出一次 `feeds_groups`。
- 每个 feed 对象:`{id, favicon_id:0, title, url, site_url: site_url ?? "", is_spark:0, last_updated_on_time: unixSeconds(last_fetched_at)}`。
- `favicons` → `[]`;`links` → `[]`。

- [ ] **Step 5: 注册路由**

`worker/src/index.ts` 引入 `fever` 并 `app.route("/", fever)`。在 `worker/src/routes/fever.ts` 中注册三条路径,均 `fever.on(["GET","POST"], path, handler)`。

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @readly/worker exec vitest run test/fever.test.ts`
Expected: 鉴权与读取测试通过。

- [ ] **Step 7: 提交**

```bash
git add worker/src/routes/fever.ts worker/src/index.ts worker/test/fever.test.ts
git commit -m "feat(fever): 认证与读取端点"
```

---

### Task 3: items、ids 与写操作

**Files:**
- Modify: `worker/src/routes/fever.ts`
- Test: `worker/test/fever.test.ts`

**Interfaces:**
- Produces: `items` / `unread_item_ids` / `saved_item_ids` 响应;`mark=item|feed|group` 写操作。
- Consumes: D1 表结构;`json_each(?)`;`unixSeconds`。

- [ ] **Step 1: 写失败测试**

在 `worker/test/fever.test.ts` 追加:
- 120 篇文章(按 id 递增)。`items&max_id=0` 返回最新 50 条且降序;`max_id=100` 返回 id<100 的 50 条降序;`since_id=100` 返回 id>100 的 50 条升序;`with_ids=...` 按升序、去重、非正数忽略;无参数返回最旧 50 条;`total_items` 恒为 120。
- item 字段:`html` 三级回退(`content_full` 优先、`content`、`excerpt`、空串),`author`/`url` 缺省为空串,`is_read`/`is_saved` 0/1,`created_on_time` Unix 秒。
- `unread_item_ids` / `saved_item_ids` 升序 CSV,无状态行视为未读;全部已读时为空串。
- `mark=item&id=N&as=read` 只改 is_read,保留收藏/稍后;返回 `unread_item_ids`;`as=unread` 清空 `read_at`;`as=saved` 保留 `starred_at` 首次;`as=unsaved` 清空 `starred_at` 并返回 `saved_item_ids`。
- `mark=feed&id=N&as=read&before=T` 只标该源 `published_at < T` 的未读;`mark=group&id=0` 全部;`id=-1` 无操作;`id=分类` 只标该分类;毫秒/微秒 before 归一;非法 `as` 不落库;响应附带 `unread_item_ids`。
- 一次请求可同时 `items` + `mark`;写先执行,读区块仍返回最新状态。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/worker exec vitest run test/fever.test.ts`
Expected: FAIL,items/写操作缺失。

- [ ] **Step 3: 实现 items**

- `total_items` 用 `SELECT COUNT(*) AS n FROM articles`。
- 读取 SQL 统一 `LEFT JOIN article_states s ON s.article_id = a.id`,字段 `COALESCE(s.is_read,0) AS is_read`、`COALESCE(s.is_starred,0) AS is_saved`。
- 选择器:
  - `max_id` 存在且可解析为非负安全整数:值为 0 → `ORDER BY a.id DESC LIMIT 50`;大于 0 → `WHERE a.id < ? ORDER BY a.id DESC LIMIT 50`。
  - 否则 `with_ids` 存在:按逗号切分,保留 `/^\d+$/` 且 `Number.isSafeInteger` 且 >0,去重后取前 50;全非法返回空数组;SQL `WHERE a.id IN (SELECT value FROM json_each(?)) ORDER BY a.id ASC`。
  - 否则 `since_id`(缺省 0):`WHERE a.id > ? ORDER BY a.id ASC LIMIT 50`。
- `html: row.content_full ?? row.content ?? row.excerpt ?? ""`。

- [ ] **Step 4: 实现 ids**

- 未读:`SELECT id FROM articles a LEFT JOIN article_states s ... WHERE COALESCE(s.is_read,0)=0 ORDER BY a.id ASC`,CSV。
- 收藏:`COALESCE(s.is_starred,0)=1` 且 `WHERE is_starred` 明确为 1(避免 left join 误选),升序 CSV。
- 空结果 `""`。

- [ ] **Step 5: 实现写操作**

- 单条 item:解析 `id` 逗号列表;按 `as` 调 UPSERT。复用 GReader 的语义:
  - read: `INSERT ... SELECT a.id,1,?,? FROM articles a WHERE a.id IN (json_each(?)) ON CONFLICT DO UPDATE SET is_read=1, read_at=COALESCE(article_states.read_at, excluded.read_at), updated_at=excluded.updated_at`。
  - unread: `is_read=0, read_at=NULL`。
  - saved: `is_starred=1, starred_at=COALESCE(article_states.starred_at, excluded.starred_at)`。
  - unsaved: `is_starred=0, starred_at=NULL`。
- feed/group read:
  - 解析 `before`:数字 >1e14 按微秒、>1e10 按毫秒,否则按秒;非法/≤0 取当前时间。
  - SQL `INSERT ... SELECT a.id,1,?,? FROM articles a JOIN feeds f ... LEFT JOIN article_states s ... WHERE COALESCE(s.is_read,0)=0 AND a.published_at < ? [AND f.id=? | AND f.category_id=?] ON CONFLICT ...`。
  - `group id=0` 不按分类过滤;`id=-1` 直接跳过;`id>0` 按 `f.category_id`。
- 写操作成功后按 `as` 附加 ids:read/unread/feed/group → `unread_item_ids`;saved/unsaved → `saved_item_ids`。
- 不合法 `mark`/`as`/id 只返回基线或仅附加对应读区块。

- [ ] **Step 6: 运行测试与类型检查**

Run:
```bash
pnpm --filter @readly/worker exec vitest run test/fever.test.ts
pnpm --filter @readly/worker typecheck
```
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add worker/src/routes/fever.ts worker/test/fever.test.ts
git commit -m "feat(fever): items 与读写同步"
```

---

### Task 4: 部署路径与安全回归

**Files:**
- Modify: `worker/wrangler.toml`
- Test: `worker/test/fever.test.ts`

- [ ] **Step 1: 更新 `run_worker_first`**

```toml
run_worker_first = ["/api/*", "/accounts", "/accounts/*", "/reader", "/reader/*", "/fever", "/fever/*", "/fever.php"]
```

- [ ] **Step 2: 补安全测试**

断言 `/fever.php?api` 与 `/fever?api` 不走 SPA、`/api/articles` 无 Bearer 仍 401、Fever 路径无 Bearer 可访问。确认 `wrangler deploy --dry-run` 能解析配置。

- [ ] **Step 3: 提交**

```bash
git add worker/wrangler.toml worker/test/fever.test.ts
git commit -m "chore(fever): 增加 Worker 路由优先级"
```

---

### Task 5: 设置页

**Files:**
- Create: `web/src/components/FeverSettings.vue`
- Modify: `web/src/views/Settings.vue`
- Test: `web/src/components/__tests__/fever-settings.test.ts`

**Interfaces:**
- Consumes: `FEVER_USERNAME`, `SETTING_KEYS.feverAuth`, `FeverAuth`, `api`.
- Produces: 设置页 Fever 区块,数据属性 `data-fever-*` 与设计文档一致。

- [ ] **Step 1: 写失败测试**

复制 `google-reader-settings.test.ts` 的结构,新增 `fever-settings.test.ts`:
- `mount(null)` → 存在 `[data-fever-enable]`;点击后 PUT 的 kv 精确为 `{fever_auth:{username:"readly",password:/^[0-9a-f]{32}$/}}`,并显示 endpoint `location.origin + "/fever/"`、用户名、密码。
- 已配置时直接渲染,不显示启用按钮。
- 重置生成新密码;停用 PUT null 并回到未启用。
- 复制按钮写入密码;加载失败提示「Fever 设置加载失败」。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/web exec vitest run src/components/__tests__/fever-settings.test.ts`
Expected: FAIL,组件不存在。

- [ ] **Step 3: 实现组件**

按 `GoogleReaderSettings.vue` 同构实现,差异:
- 导入 `FeverAuth`、`FEVER_USERNAME`;endpoint `location.origin + "/fever/"`。
- 数据属性全部用 `data-fever-*`。
- 文案:兼容 Reeder Classic / Unread / FeedMe;收藏 = 客户端 Saved;不支持 favicon / 热点;密码泄露后重置;新文章由后台定时刷新。
- 加载失败文案「Fever 设置加载失败」。

- [ ] **Step 4: 挂载到设置页**

`Settings.vue` 在 `<GoogleReaderSettings />` 后加 `<FeverSettings />`,并 import。

- [ ] **Step 5: 运行 web 测试与类型检查**

Run:
```bash
pnpm --filter @readly/web exec vitest run src/components/__tests__/fever-settings.test.ts
pnpm --filter @readly/web typecheck
```
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/FeverSettings.vue web/src/views/Settings.vue web/src/components/__tests__/fever-settings.test.ts
git commit -m "feat(web): 设置页管理 Fever 凭据"
```

---

### Task 6: 文档与最终验收

**Files:**
- Create: `docs/fever-api.md`
- Modify: `README.md`, `docs/README.md`, `docs/development.md`, `docs/superpowers/README.md`, `docs/architecture.md` (if needed)

- [ ] **Step 1: 写 `docs/fever-api.md`**

覆盖:启用步骤、客户端选择 Fever、服务器地址 `https://<域名>/fever/`、邮箱 `readly`、密码;认证 `api_key` 与 md5;端点表;items 分页;写操作;限制(favicon/hot links/XML/刷新/明文密码);排错表。

- [ ] **Step 2: 更新 README / 文档索引 / 开发指南**

- README 功能表第三方客户端行补充 Fever;第三方客户端章节增加 Fever 子节;安全限制补充 Fever 密码;测试计数按实际更新。
- `docs/README.md` 使用文档表增加 Fever API。
- `docs/development.md` 测试基线更新,单测示例增加 fever。
- `docs/superpowers/README.md` 增加设计/计划索引。

- [ ] **Step 3: 全量门禁**

```bash
pnpm build && pnpm -r test && pnpm -r typecheck
pnpm --filter @readly/worker exec wrangler deploy --dry-run
```
Expected: 全绿;记录实际测试计数并同步文档。

- [ ] **Step 4: curl 验收**

在本地或已部署实例执行:
1. 计算 `api_key=md5("readly:<password>")`。
2. `POST /fever/?api` 表单 `api_key=...` → auth 1。
3. `?api&groups`、`?api&feeds`、`?api&items&max_id=0`。
4. `POST /fever/?api` 表单 `api_key=...&mark=item&as=read&id=<id>` → `unread_item_ids` 不含该 id。
5. `mark=feed`/`mark=group` 后回读未读 ids。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/
git commit -m "docs: Fever API 使用与配置说明"
```

---

## Self-Review

- 覆盖 spec 的认证、读取、items 分页、写操作、设置页、部署路径、文档和测试。
- 无数据库迁移;无新增依赖。
- 所有用户可见文案为中文,深浅色成对。
- 关键风险:MD5 长度填充、items 选择器优先级、feed/group 写操作的 `before` 边界、`json_each` 参数、`/fever` 被 SPA 吞掉。
