# Readly「只看未读」功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「只看未读」模式开关:开启后侧栏只显示有未读的源/分类,文章列表对所有视图叠加「仅未读」过滤;开关为持久化偏好(跨设备同步),侧栏过滤即时生效,列表切换时重载。

**Architecture:** worker 的 `GET /api/articles` 增加可选 `unread=1` 参数(与 view/scope 组合,SQL 叠加一个条件即可,游标分页不受影响);web 端在冻结的 `ReaderPrefs` 上**有意扩展**一个 `unreadOnly: boolean` 字段,复用既有 localStorage+D1 双写与 sanitizePrefs 校验;UI 入口两处——ArticleList 工具栏快捷开关(主入口)+ ThemePanel「已读策略」区 checkbox,二者写同一偏好。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- `ReaderPrefs` 是计划 01 冻结类型,本次是**经批准的有意扩展**:仅新增 `unreadOnly: boolean`(默认 `false`),不改动任何既有字段;所有构造点(`DEFAULT_READER_PREFS`、`sanitizePrefs`)必须同步。
- worker 组合过滤语义:`unread=1` 与任何 `view`、任何 scope(feed/category)以 AND 叠加;`view=unread` 与 `unread=1` 同时出现时条件重复但结果不变,无需特判。
- 侧栏过滤纯展示层:不改数据、不改未读计数;`未分类` 头与分类头在无可见源时一并隐藏。
- 开关切换后列表立即 `load(true)` 重载(不依赖 watcher);分页请求自动携带该参数。
- 视觉与行为验收**必须实测**(headless Chrome,独立端口,勿动用户后台 pnpm dev 的 5173/8787):浅色与深色下各验证一次;任何新增 UI 元素必须同时具备深色文字/底色配对(教训纪律)。
- TypeScript strict;禁止 any;文案中文;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付。

---

### Task 1: 「只看未读」全栈实现

**Files:**
- Modify: `shared/src/index.ts`(`ReaderPrefs` + `DEFAULT_READER_PREFS` 各加一行)
- Modify: `worker/src/routes/articles.ts`(`GET /articles` 叠加 unread 条件)
- Modify: `worker/test/articles.test.ts`(追加 1 用例)
- Modify: `web/src/stores/settings.ts`(`sanitizePrefs` 加字段)
- Modify: `web/src/stores/__tests__/settings.test.ts`(追加断言)
- Modify: `web/src/stores/articles.ts`(`fetchPage` 携带参数)
- Modify: `web/src/stores/__tests__/articles.test.ts`(追加 1 用例)
- Modify: `web/src/components/Sidebar.vue`(过滤展示)
- Modify: `web/src/components/ArticleList.vue`(工具栏开关)
- Modify: `web/src/components/ThemePanel.vue`(已读策略区 checkbox)
- Modify: `web/src/components/__tests__/article-list-toolbar.test.ts`(追加 1 用例)
- Modify: `web/src/components/__tests__/sidebar-actions.test.ts`(追加 1 用例)
- Create: `web/scripts/verify-unread-only.mjs`(Chrome 实测脚本,一次性,验后可删)

**Interfaces:**
- Consumes: 既有 `api` 客户端、`useSettingsStore`、`useArticlesStore`、`useFeedsStore`、`Stats.perFeed/perCategory`(未读计数)、`ArticleList` 既有工具栏。
- Produces(冻结):
  - `ReaderPrefs.unreadOnly: boolean`(shared 导出)
  - worker:`GET /api/articles?...&unread=1` → 结果 AND `is_read=0`
  - `articles store`:`load/loadMore/setFilter` 路径均自动携带 `unread`(由 `useSettingsStore().prefs.unreadOnly` 决定)
  - `Sidebar` 内部 `visibleCategories` / `visibleFeeds(categoryId)` 过滤函数;`ArticleList` 工具栏「只看未读」按钮与 `ThemePanel` 同名 checkbox,均调 `settings.updatePrefs({ unreadOnly })` 后 `articles.load(true)`

- [ ] **Step 1: shared 扩展(先改类型,后跑受影响套件)**

`shared/src/index.ts`:`ReaderPrefs` 接口在 `autoMarkReadOnScroll` 之后加:

```ts
  unreadOnly: boolean;
```

`DEFAULT_READER_PREFS` 在 `autoMarkReadOnScroll: true` 之后加:

```ts
  unreadOnly: false,
```

Run: `pnpm --filter @readly/web typecheck`
Expected: 仅 `settings.ts` 的 `sanitizePrefs` 报缺字段(下一步补);worker/settings 其余编译通过。

- [ ] **Step 2: 失败测试(worker 组合过滤)**

`worker/test/articles.test.ts` 追加:

```ts
  it("unread=1 与 view 组合过滤", async () => {
    const { ids } = await seed();
    await apiFetch(`/api/articles/${ids[0]}`, { method: "PATCH", body: { is_starred: true } });
    await apiFetch(`/api/articles/${ids[1]}`, { method: "PATCH", body: { is_starred: true } });
    await apiFetch(`/api/articles/${ids[1]}`, { method: "PATCH", body: { is_read: true } });
    const starred = (await (await apiFetch("/api/articles?view=starred")).json()) as { items: unknown[] };
    expect(starred.items).toHaveLength(2);
    const starredUnread = (await (await apiFetch("/api/articles?view=starred&unread=1")).json()) as { items: unknown[] };
    expect(starredUnread.items).toHaveLength(1);
    const allUnread = (await (await apiFetch("/api/articles?unread=1")).json()) as { items: unknown[] };
    expect(allUnread.items).toHaveLength(4);
  });
```

Run: `pnpm --filter @readly/worker test test/articles.test.ts`
Expected: 新用例 FAIL(starredUnread 为 2)。

- [ ] **Step 3: worker 实现**

`worker/src/routes/articles.ts` 的 `articles.get("/articles", ...)` 中,在 `view` 过滤之后、`feed_id` 之前插入:

```ts
  const unreadParam = c.req.query("unread");
  if (unreadParam === "1" || unreadParam === "true") where.push("COALESCE(s.is_read, 0) = 0");
```

Run: `pnpm --filter @readly/worker test`
Expected: 全绿(114 → 115)。

- [ ] **Step 4: web 偏好层(失败测试→实现)**

`web/src/stores/__tests__/settings.test.ts`:

在 `sanitizePrefs` 的「非法字段回退默认」用例断言组追加:

```ts
    expect(p.unreadOnly).toBe(false);
```

在「保留合法自定义值」用例的输入与断言追加:

```ts
    const p = sanitizePrefs({ accent: "#22c55e", readingTheme: "night", fontSize: 19, autoMarkReadOnScroll: false, unreadOnly: true });
    // ...既有断言...
    expect(p.unreadOnly).toBe(true);
```

Run: `pnpm --filter @readly/web test src/stores/__tests__/settings.test.ts`
Expected: FAIL(字段缺失)。

`web/src/stores/settings.ts` 的 `sanitizePrefs` 返回对象末尾(`autoMarkReadOnScroll` 之后)加:

```ts
    unreadOnly: o.unreadOnly === true,
```

Run: 同上,Expected: PASS。

- [ ] **Step 5: articles store 携带参数(失败测试→实现)**

`web/src/stores/__tests__/articles.test.ts` 追加(沿用文件级 fake timers 与既有 `item()` 工厂):

```ts
  it("unreadOnly 开启时列表与分页请求携带 unread=1", async () => {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles") {
        const q = opts?.query as Record<string, unknown>;
        expect(q.unread).toBe(1);
        return Promise.resolve({ items: [item(1)], nextCursor: "c1" });
      }
      return Promise.resolve({});
    });
    const { useSettingsStore } = await import("@/stores/settings");
    useSettingsStore().initLocal();
    useSettingsStore().updatePrefs({ unreadOnly: true });
    const store = useArticlesStore();
    await store.load(true);
    vi.mocked(api).mockResolvedValueOnce({ items: [item(2)], nextCursor: null });
    await store.loadMore();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
  });
```

Run: `pnpm --filter @readly/web test src/stores/__tests__/articles.test.ts`
Expected: FAIL(未携带 unread)。

`web/src/stores/articles.ts`:顶部 import 区加:

```ts
import { useSettingsStore } from "./settings";
```

`fetchPage` 的 query 对象加一行(在 `limit` 之后):

```ts
          unread: useSettingsStore().prefs.unreadOnly ? 1 : undefined,
```

Run: 同上,Expected: PASS;再跑全量 `pnpm --filter @readly/web test` 确认既有用例不受影响(默认 false → 参数为 undefined)。

- [ ] **Step 6: Sidebar 过滤(失败测试→实现)**

`web/src/components/__tests__/sidebar-actions.test.ts` 追加(沿用既有挂载助手;若无 feeds/stats 注入助手则先按其模式 mock `/api/feeds` 两份——一个 `unreadCount: 0`、一个 `unreadCount: 2`,`/api/stats` 零值即可):

```ts
  it("unreadOnly 开启时侧栏隐藏零未读源,关闭后恢复", async () => {
    // mock: /api/categories→[{id:1,name:"科技"}], /api/feeds→[
    //   { id: 1, title: "有未读", categoryId: 1, unreadCount: 2, ... },
    //   { id: 2, title: "零未读", categoryId: 1, unreadCount: 0, ... }]
    // mount Sidebar; await store.load() 后:
    expect(host!.textContent).toContain("有未读");
    expect(host!.textContent).toContain("零未读");
    useSettingsStore().updatePrefs({ unreadOnly: true });
    await nextTick();
    expect(host!.textContent).toContain("有未读");
    expect(host!.textContent).not.toContain("零未读");
    useSettingsStore().updatePrefs({ unreadOnly: false });
    await nextTick();
    expect(host!.textContent).toContain("零未读");
  });
```

(完整 mock 数据按 `Feed` 冻结类型补全字段;挂载与 flush 助手照抄文件内既有模式。)

Run: 该文件
Expected: FAIL(零未读源仍显示)。

`web/src/components/Sidebar.vue` 实现:

1. 顶部 import 加 `import { computed } from "vue";`(并入既有)与 `import { useSettingsStore } from "@/stores/settings";`;setup 内加 `const settings = useSettingsStore();`
2. 现有 `feedsOf(categoryId)` 函数替换为过滤版:

```ts
function visibleFeeds(categoryId: number | null) {
  return feedsStore.feeds.filter(
    (f) =>
      (categoryId === null ? f.categoryId === null : f.categoryId === categoryId) &&
      (!settings.prefs.unreadOnly || f.unreadCount > 0)
  );
}

const visibleCategories = computed(() =>
  settings.prefs.unreadOnly
    ? feedsStore.categories.filter((c) => visibleFeeds(c.id).length > 0)
    : feedsStore.categories
);
```

3. 模板:`v-for="cat in feedsStore.categories"` → `v-for="cat in visibleCategories"`;两处 `feedsOf(...)` → `visibleFeeds(...)`;「未分类」头按钮包一层 `v-if="visibleCategories.length >= 0 && (!settings.prefs.unreadOnly || visibleFeeds(null).length > 0)"`(等价简写:`v-if="!settings.prefs.unreadOnly || visibleFeeds(null).length > 0"`)。
4. 若 Sidebar 模板中存在「全部文章/未读/收藏/稍后读」之外会展示计数的地方,不新增改动。

Run: 该文件 PASS。

- [ ] **Step 7: 工具栏开关(失败测试→实现)**

`web/src/components/__tests__/article-list-toolbar.test.ts` 追加:

```ts
  it("「只看未读」开关写入偏好并重载列表", async () => {
    // mock /api/articles 记录 query;挂载(既有助手)后:
    const btn = Array.from(host!.querySelectorAll("button")).find((b) => b.textContent?.includes("只看未读"))!;
    btn.click();
    await flush();
    const last = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/articles").at(-1)!;
    expect((last[1]!.query as Record<string, unknown>).unread).toBe(1);
    const { useSettingsStore } = await import("@/stores/settings");
    expect(useSettingsStore().prefs.unreadOnly).toBe(true);
  });
```

Run: 该文件
Expected: FAIL(按钮不存在)。

`web/src/components/ArticleList.vue`:
1. import 区加 `import { useSettingsStore } from "@/stores/settings";`;setup 内加 `const settings = useSettingsStore();`
2. script 加:

```ts
async function toggleUnreadOnly(): Promise<void> {
  settings.updatePrefs({ unreadOnly: !settings.prefs.unreadOnly });
  await articles.load(true);
}
```

3. 工具栏右侧按钮组:在「全部标已读」按钮**之前**插入:

```vue
      <button
        class="shrink-0 rounded-md px-2 py-1 font-medium hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
        :class="settings.prefs.unreadOnly ? 'text-[var(--accent)]' : 'text-neutral-500'"
        :title="settings.prefs.unreadOnly ? '显示全部文章' : '只显示未读'"
        @click="toggleUnreadOnly"
      >
        只看未读
      </button>
```

(工具栏容器已是 `justify-between`,两个按钮放同一侧:把两按钮包进 `<div class="flex shrink-0 items-center gap-1">`。)

Run: 该文件 PASS。

- [ ] **Step 8: ThemePanel 同步入口**

`web/src/components/ThemePanel.vue` 「已读策略」section 内,两 checkbox 之后追加:

```vue
      <label class="mt-1 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" :checked="prefs.unreadOnly" class="accent-[var(--accent)]" @change="settings.updatePrefs({ unreadOnly: ($event.target as HTMLInputElement).checked })" />
        列表与侧栏只显示未读
      </label>
```

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build`
Expected: 全绿(web 预计 68 个用例)。

- [ ] **Step 9: Chrome 实测(浅色+深色)**

`web/scripts/verify-unread-only.mjs`(一次性脚本):构建产物 + 本地桩(独立端口 4299;`/api` 桩返回 1 个分类、2 个源(一个 unreadCount 2、一个 0)、列表 2 篇(1 已读 1 未读)),CDP 驱动 headless Chrome,断言并记录:
1. 初始:侧栏含"零未读"源;列表含已读条目;
2. 点击「只看未读」:侧栏不含"零未读"、含"有未读";列表请求带 `unread=1` 且已读条目消失;按钮变强调色;
3. 刷新页面:开关保持(偏好持久化)且效果仍在;
4. 切「暗色」(面板或 localStorage 注入)重测步骤 2 的 DOM 级断言,并抽样「只看未读」按钮的对比度(激活态 ≥4.5:1);
5. 截图 `/tmp/readly-unread-light.png`、`/tmp/readly-unread-dark.png`。

Run: `pnpm build && node web/scripts/verify-unread-only.mjs`
Expected: 全部断言通过;记录数值与截图名到报告。验证后删除该脚本(不入库)。

- [ ] **Step 10: 提交**

```bash
git add shared worker web && git commit -m "feat: 只看未读模式(侧栏过滤零未读源+列表叠加未读过滤)
Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自检记录(writing-plans self-review)

- **规格覆盖**:开关持久化(ReaderPrefs 扩展+双写复用)→ Step 1/4;侧栏隐藏零未读源与空分类 → Step 6;列表全视图叠加过滤(worker 组合参数)→ Step 2/3/5;两处 UI 入口 → Step 7/8;实测验收(浅色+深色)→ Step 9。
- **有意决策**:① `ReaderPrefs` 冻结类型的扩展是本次功能的前提,已明确为「新字段、默认 false、不动既有」;② 开关不写入 URL(持久偏好语义;URL 已承载 view/feed/category/a,避免参数爆炸);③ `view=unread` 与 `unread=1` 并存产生重复 SQL 条件,刻意不特判(结果不变,少一处分支)。
- **类型一致性**:`unreadOnly` 在 shared/sanitizePrefs/DEFAULT/两处 UI/toolbar 测试中的字段名与布尔语义一致;worker 参数名 `unread` 三处(路由/测试/store query)一致。
- **无占位符**:各步给出可执行代码;Step 6/7 的测试片段依赖文件内既有 mock 助手,已注明「照抄既有模式」与需要补全的字段来源(Feed 冻结类型)。
