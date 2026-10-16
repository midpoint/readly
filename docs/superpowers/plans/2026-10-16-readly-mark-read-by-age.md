# Readly 标已读时间档 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「全部标已读」扩展出时间档(3 天/1 周/1 月/1 年以上):`POST /api/articles/mark-all-read` 支持可选 `olderThanDays`,前端主按钮旁加 ▾ 菜单;无时间档行为逐字节不变。

**Architecture:** 服务端在原 SQL 的三个 scope 分支统一追加可选 `AND a.published_at < ?`(ISO 字典序即时间序);前端 store 仅在传值时附字段(契约零扰动),`ArticleList` 复用侧栏 ⋯ 菜单的弹层交互模式。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- 设计文档:`docs/superpowers/specs/2026-10-16-mark-read-by-age-design.md`(已评审)。行为以其 §1 语义为准。
- 校验:`olderThanDays` 若存在必须是整数且 `1 ≤ d ≤ 36500`,否则 `400 { code: "invalid_days", message: "天数非法" }`(与既有 fail 结构一致);缺失 = 不限。
- **无档契约逐字节不变**:请求体 `{ scope }`、SQL 文本(无 ageClause 时)、返回;既有 worker 用例(`标全部已读(按源)…`)与 web 用例(:114 精确体断言)必须零改动通过。
- 选择器契约(冻结):`[data-mark-age-toggle]`、`[data-mark-age-menu]`、`[data-mark-age="3|7|30|365"]`;主按钮文案「全部标已读」不变(`@click` 必须写 `markAllAsRead()`,防 click 事件被当作参数字传入)。`aria-label="更多标已读范围"`、`aria-expanded`。
- 菜单交互与侧栏同款:开启按钮与菜单容器 `@click.stop`、document click 关、Esc 关、选中即关;`markingAllRead` 期间主按钮与菜单项禁用。
- 无 `any`;strict;不新增偏好字段;样式含深浅配对(`hover:bg-neutral-100 dark:hover:bg-neutral-800` 等沿用侧栏 menuItem)。
- 视觉验收必须实测(纪律 1):Chrome 浅/深截图 + DOM 断言;样板 `/tmp/readly-final-verify-final.mjs`;不触碰 5173/8787。
- 每任务一个 commit,消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

---

### Task 1: 服务端 olderThanDays + store 契约 + ▾ 菜单 + 双端测试

**Files:**
- Modify: `worker/src/routes/articles.ts`(mark-all-read 处理器,173-199 行整体替换)
- Modify: `worker/test/articles.test.ts`(在「标全部已读(按源)…」用例之后追加 3 用例;文件已 import `env` 与 `apiFetch`)
- Modify: `web/src/stores/feeds.ts`(`markAllRead` 签名与 body)
- Modify: `web/src/components/ArticleList.vue`(脚本:选项常量/菜单态/监听器/执行函数;模板:按钮块替换)
- Modify: `web/src/components/__tests__/article-list-toolbar.test.ts`(追加 3 用例)

**Interfaces:**
- Consumes:`seed()`(worker 测试,返回 `{ feedId, ids }` 5 篇固定 2025-10-1x 日期)、`mountList`/`flush`/`articleQueries`(web 测试)、`feedsStore.markAllRead` 既有调用方(ArticleList)与返回 `{ updated }`。
- Produces:`markAllRead(scope, olderThanDays?)` 新签名;`[data-mark-age-*]` 选择器(Task 2 Chrome 依赖)。

- [ ] **Step 1: 写 worker 失败测试**

`worker/test/articles.test.ts`,紧跟「标全部已读(按源),保留已有收藏」用例之后追加:

```ts
  it("标已读时间档:仅置读距今天数超过档位的未读文章", async () => {
    const { feedId, ids } = await seed();
    // ids[0..1] 改近(1 天前),ids[2..4] 保持 2025 旧日期(远超 30 天)
    const recent = new Date(Date.now() - 86400000).toISOString();
    await env.DB.prepare("UPDATE articles SET published_at = ? WHERE id = ?").bind(recent, ids[0]!).run();
    await env.DB.prepare("UPDATE articles SET published_at = ? WHERE id = ?").bind(recent, ids[1]!).run();

    // all scope + 30 天档
    const r1 = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "all" }, olderThanDays: 30 } });
    expect(((await r1.json()) as { updated: number }).updated).toBe(3);
    const near = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { isRead: boolean };
    expect(near.isRead).toBe(false); // 近文保持未读
    const old = (await (await apiFetch(`/api/articles/${ids[2]}`)).json()) as { isRead: boolean };
    expect(old.isRead).toBe(true); // 旧文已置读
  });

  it("标已读时间档:feed 分支同样生效且不影响近文", async () => {
    const { feedId, ids } = await seed();
    const recent = new Date(Date.now() - 86400000).toISOString();
    for (const id of [ids[0]!, ids[1]!]) {
      await env.DB.prepare("UPDATE articles SET published_at = ? WHERE id = ?").bind(recent, id).run();
    }
    const r = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "feed", id: feedId }, olderThanDays: 30 } });
    expect(((await r.json()) as { updated: number }).updated).toBe(3);
    const near = (await (await apiFetch(`/api/articles/${ids[0]}`)).json()) as { isRead: boolean };
    expect(near.isRead).toBe(false);
  });

  it("标已读时间档:天数非法报 400 invalid_days,库内不变", async () => {
    await seed();
    for (const bad of [0, -1, 1.5, "3"] as unknown[]) {
      const r = await apiFetch("/api/articles/mark-all-read", { method: "POST", body: { scope: { type: "all" }, olderThanDays: bad } });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("invalid_days");
    }
    const states = await env.DB.prepare("SELECT COUNT(*) c FROM article_states").first<{ c: number }>();
    expect(states!.c).toBe(0);
  });
```

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm -C worker exec vitest run test/articles.test.ts`
Expected: 新增 3 用例 FAIL(`olderThanDays` 目前被忽略:第一条 `updated` 为 5 而非 3;非法值返回 200 而非 400)。

- [ ] **Step 3: 实现 worker 路由**

`worker/src/routes/articles.ts` 的 `articles.post("/articles/mark-all-read", ...)` 处理器(173-199 行)整体替换为:

```ts
articles.post("/articles/mark-all-read", async (c) => {
  const body = await c.req
    .json<{ scope?: { type?: unknown; id?: unknown }; olderThanDays?: unknown }>()
    .catch(() => ({}) as { scope?: { type?: unknown; id?: unknown }; olderThanDays?: unknown });
  const scope = body.scope;
  if (!scope || typeof scope.type !== "string" || !["all", "feed", "category"].includes(scope.type)) {
    return fail(c, 400, "invalid_scope", "scope 非法");
  }
  // 可选时间档:仅置读发布时间早于 now - N 天的未读文章;缺省不限(行为与既往逐字节一致)
  let ageClause = "";
  let cutoff: string | null = null;
  if (body.olderThanDays !== undefined) {
    const d = body.olderThanDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 36500) {
      return fail(c, 400, "invalid_days", "天数非法");
    }
    cutoff = new Date(Date.now() - d * 86400000).toISOString();
    ageClause = " AND a.published_at < ?";
  }
  const now = new Date().toISOString();
  let sql: string;
  let binds: (string | number)[] = [now, now];
  if (scope.type === "all") {
    sql = `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
           SELECT a.id, 1, ?, ? FROM articles a WHERE COALESCE((SELECT is_read FROM article_states WHERE article_id = a.id), 0) = 0${ageClause}
           ON CONFLICT(article_id) DO UPDATE SET is_read = 1, read_at = excluded.read_at, updated_at = excluded.updated_at`;
    if (cutoff !== null) binds.push(cutoff);
  } else {
    if (typeof scope.id !== "number") return fail(c, 400, "invalid_scope", "缺少 id");
    const join = scope.type === "feed" ? "a.feed_id = ?" : "f.category_id = ?";
    sql = `INSERT INTO article_states (article_id, is_read, read_at, updated_at)
           SELECT a.id, 1, ?, ? FROM articles a JOIN feeds f ON f.id = a.feed_id
           WHERE ${join} AND COALESCE((SELECT is_read FROM article_states WHERE article_id = a.id), 0) = 0${ageClause}
           ON CONFLICT(article_id) DO UPDATE SET is_read = 1, read_at = excluded.read_at, updated_at = excluded.updated_at`;
    binds = [now, now, scope.id];
    if (cutoff !== null) binds.push(cutoff);
  }
  const res = await c.env.DB.prepare(sql).bind(...binds).run();
  return ok(c, { updated: res.meta.changes ?? 0 });
});
```

- [ ] **Step 4: 运行确认 GREEN(含既有回归)**

Run: `pnpm -C worker exec vitest run test/articles.test.ts`
Expected: 全过(含既有「标全部已读(按源)…」零改动 5→5)。

- [ ] **Step 5: 写 web 失败测试**

`web/src/components/__tests__/article-list-toolbar.test.ts`,在「feed 过滤下点『全部标已读』…」用例之后追加(复用同文件既有的 `mountList`/`flush`/`articleQueries` 与 beforeEach mock 装配):

```ts
  it("▾ 时间档菜单:选「1 月以上」发精确体(含 olderThanDays:30)并关闭菜单、重载列表", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const articles = useArticlesStore();
    await articles.setFilter("all", FEED.id, null);
    const container = await mountList(pinia);

    const toggle = container.querySelector<HTMLButtonElement>("[data-mark-age-toggle]")!;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const menu = container.querySelector("[data-mark-age-menu]");
    expect(menu).toBeTruthy();
    expect(menu!.querySelectorAll("[data-mark-age]")).toHaveLength(4);

    const queriesBefore = articleQueries().length;
    container.querySelector<HTMLButtonElement>('[data-mark-age="30"]')!.click();
    await flush();

    // 契约:精确请求体(scope + olderThanDays),不多不少
    expect(api).toHaveBeenCalledWith("/api/articles/mark-all-read", {
      method: "POST",
      body: { scope: { type: "feed", id: 3 }, olderThanDays: 30 },
    });
    expect(container.querySelector("[data-mark-age-menu]")).toBeNull(); // 选中即关
    const queries = articleQueries();
    expect(queries.length).toBe(queriesBefore + 1); // 列表重载
    expect(queries[queries.length - 1]!.feed_id).toBe(3);
  });

  it("▾ 菜单:点外关闭,且不发请求", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const articles = useArticlesStore();
    await articles.setFilter("all", null, null);
    const container = await mountList(pinia);

    container.querySelector<HTMLButtonElement>("[data-mark-age-toggle]")!.click();
    await flush();
    expect(container.querySelector("[data-mark-age-menu]")).not.toBeNull();

    document.body.click();
    await flush();
    expect(container.querySelector("[data-mark-age-menu]")).toBeNull();
    expect(api).not.toHaveBeenCalledWith("/api/articles/mark-all-read", expect.anything());
  });

  it("▾ 菜单:Esc 关闭", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const articles = useArticlesStore();
    await articles.setFilter("all", null, null);
    const container = await mountList(pinia);

    container.querySelector<HTMLButtonElement>("[data-mark-age-toggle]")!.click();
    await flush();
    expect(container.querySelector("[data-mark-age-menu]")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(container.querySelector("[data-mark-age-menu]")).toBeNull();
  });
```

- [ ] **Step 6: 运行确认 RED**

Run: `pnpm -C web exec vitest run src/components/__tests__/article-list-toolbar.test.ts`
Expected: 3 新用例 FAIL(`[data-mark-age-toggle]` 不存在,`!` 断言先炸);既有用例通过。

- [ ] **Step 7: 实现 store 契约**

`web/src/stores/feeds.ts` 的 `markAllRead` 整体替换为:

```ts
  async function markAllRead(scope: { type: "all" | "feed" | "category"; id?: number }, olderThanDays?: number): Promise<number> {
    // 契约:无时间档时请求体与既往逐字节一致(既有精确体测试守护)
    const res = await api<{ updated: number }>("/api/articles/mark-all-read", {
      method: "POST",
      body: olderThanDays === undefined ? { scope } : { scope, olderThanDays },
    });
    await load();
    return res.updated;
  }
```

- [ ] **Step 8: 实现 ArticleList(脚本 + 模板)**

**8a. 脚本区** —— `const markingAllRead = ref(false);` 之后插入:

```ts
// 标已读时间档(发布日期早于 N 天的未读文章);菜单交互随侧栏 ⋯ 菜单同款
const MARK_AGE_OPTIONS = [
  { days: 3, label: "3 天以上标已读" },
  { days: 7, label: "1 周以上标已读" },
  { days: 30, label: "1 月以上标已读" },
  { days: 365, label: "1 年以上标已读" },
] as const;
const markMenuOpen = ref(false);
```

`markAllAsRead` 整体替换为(注意 `@click` 调用处必须带括号):

```ts
async function markAllAsRead(olderThanDays?: number): Promise<void> {
  if (markingAllRead.value) return;
  markingAllRead.value = true;
  markMenuOpen.value = false;
  try {
    const scope: { type: "all" | "feed" | "category"; id?: number } =
      articles.feedId !== null
        ? { type: "feed", id: articles.feedId }
        : articles.categoryId !== null
          ? { type: "category", id: articles.categoryId }
          : { type: "all" };
    await feedsStore.markAllRead(scope, olderThanDays);
    await articles.load(true);
  } catch {
    // 失败静默:侧栏计数与列表保持原状,可重试
  } finally {
    markingAllRead.value = false;
  }
}

function onDocumentClick(): void {
  if (markMenuOpen.value) markMenuOpen.value = false;
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && markMenuOpen.value) markMenuOpen.value = false;
}
```

`onMounted`/`onUnmounted` 各加两行(document 监听注册/注销):

```ts
onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void articles.loadMore().catch(() => undefined);
  });
  const sentinel = document.getElementById("list-sentinel");
  if (sentinel) observer.observe(sentinel);
});

onUnmounted(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
  observer?.disconnect();
});
```

**8b. 模板区** —— 「全部标已读」按钮(现 119-126 行)整体替换为:

```html
        <div class="relative flex shrink-0 items-center">
          <button
            class="rounded-md px-2 py-1 font-medium text-neutral-500 hover:bg-neutral-200/60 disabled:opacity-50 dark:hover:bg-neutral-800"
            :disabled="markingAllRead"
            @click="markAllAsRead()"
          >
            全部标已读
          </button>
          <button
            data-mark-age-toggle
            class="rounded-md px-1 py-1 font-medium text-neutral-400 hover:bg-neutral-200/60 disabled:opacity-50 dark:hover:bg-neutral-800"
            :disabled="markingAllRead"
            aria-label="更多标已读范围"
            :aria-expanded="markMenuOpen"
            @click.stop="markMenuOpen = !markMenuOpen"
          >
            ▾
          </button>
          <div
            v-if="markMenuOpen"
            data-mark-age-menu
            class="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            @click.stop
          >
            <button
              v-for="opt in MARK_AGE_OPTIONS"
              :key="opt.days"
              :data-mark-age="opt.days"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              :disabled="markingAllRead"
              @click="markAllAsRead(opt.days)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
```

- [ ] **Step 9: 运行确认 GREEN(文件 + 全量双端 + typecheck)**

Run: `pnpm -C web exec vitest run src/components/__tests__/article-list-toolbar.test.ts`
Expected: 全过(既有 + 3 新)。
Run: `pnpm -r test`
Expected: worker 146 + web 270 = 416 全绿(既有断言零改动;不符须查明,不得改数字)。
Run: `pnpm -r typecheck`
Expected: 无错误。

- [ ] **Step 10: Commit**

```bash
git add worker/src/routes/articles.ts worker/test/articles.test.ts web/src/stores/feeds.ts web/src/components/ArticleList.vue web/src/components/__tests__/article-list-toolbar.test.ts
git commit -m "feat: 标已读时间档(3天/1周/1月/1年以上)——API olderThanDays + 工具栏 ▾ 菜单

服务端可选早于 N 天过滤(1..36500,非法 400 invalid_days);无档请求体与
SQL 逐字节不变;前端主按钮旁 ▾ 菜单四档,交互随侧栏菜单(点外/Esc/选中关闭)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Chrome 浅/深实测

**Files:**
- Create(验后删):`/tmp/readly-markage-verify.mjs`;截图 `/tmp/readly-markage-{menu-light,menu-dark,after}.png`。

**Interfaces:**
- Consumes:`web/dist`、样板 `/tmp/readly-final-verify-final.mjs`、`[data-mark-age-*]` 选择器。

- [ ] **Step 1: 全量验证与构建**

Run: `pnpm -r test`(期望 416 全绿)→ `pnpm -r typecheck` → `pnpm build`。

- [ ] **Step 2: Chrome 实测**

样板模式(桩 API `127.0.0.1:5105`,CDP 9539,profile `/tmp/readly-markage-profile` 先删;预置 `localStorage.readly_token`;不碰 5173/8787)。桩数据:同一源两篇——A「近文」`publishedAt` = 1 天前;B「旧文」= 40 天前;均未读(侧栏 unread 2)。动线(浅色):

1. 打开 `/` → 断言两行均有未读点、侧栏未读 = 2;
2. 点 `[data-mark-age-toggle]` → 断言菜单出现、4 项(截图 `/tmp/readly-markage-menu-light.png`)→ Esc 或点外再开;
3. 点 `[data-mark-age="30"]` → 等待列表重载 → 断言:「旧文」行未读点消失(标题转灰)、「近文」行未读点仍在;侧栏未读 = 1;菜单已关;截图 `/tmp/readly-markage-after.png`;
4. 加 `html.dark` → 再开菜单截图 `/tmp/readly-markage-menu-dark.png`;
5. 零未捕获异常、零意外 4xx/5xx;验后删脚本。

- [ ] **Step 3: 记录**

断面值(菜单项数、重载前后未读点数、侧栏计数)、截图路径写入交付汇报;任一断言不符停下报告。

---

## Self-Review 记录

- 规格覆盖:§1 语义 → T1 Step 3(SQL)/Step 1 测试;§2 校验 → Step 1 第 3 用例 + Step 3;§3 前端 → Step 7/8;§4 测试矩阵 → Step 1/5;§5 验收 → T2;§6 不做项 → 计划无附加功能。
- 占位符扫描:无 TBD/TODO;全部代码逐字。
- 一致性:选择器三处(实现 Step 8b / web 测试 Step 5 / T2 动线)逐字一致;`markAllAsRead()` 显式括号防止 click 事件入参;bind 顺序在四个 SQL 变体下与占位符文本顺序一致(all: now,now,cutoff;feed/category: now,now,scopeId,cutoff)。
- 计数核对:worker 143+3=146;web 267+3=270;合计 416。以实际为准,不符须查明原因。
