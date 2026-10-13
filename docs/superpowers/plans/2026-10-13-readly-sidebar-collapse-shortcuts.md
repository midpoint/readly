# Readly 分类折叠 + 快捷键浏览 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ①侧栏分类可折叠(箭头点折叠、点名字仍是筛选,折叠状态持久化跨设备);②快捷键浏览升级——`j`/`k` 跳到下/上一个**未读**文章(到末尾自动加载一页再找),新增 `?` 快捷键帮助浮层与侧栏入口,保留 `s`/`m`/`v`/`Esc`。

**Architecture:** 折叠状态扩展 `ReaderPrefs.collapsedCategoryIds: number[]`(复用既有 localStorage+D1 双写与 sanitizePrefs);快捷键为纯前端逻辑:未读跳转函数在 `Inbox`(基于 `articles.items` + `loadMore`),帮助浮层用模块级单例 composable(`useShortcutHelp`)让 `Sidebar` 与 `ShortcutHelp` 共享一个开关,浮层组件挂在 Inbox。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- `ReaderPrefs` 二次扩展(经批准):仅新增 `collapsedCategoryIds: number[]`(默认 `[]`),既有字段一律不动;`DEFAULT_READER_PREFS` 与 `sanitizePrefs` 同步。
- 折叠语义:chevron(`▸/▾`)点击=折叠/展开;分类名点击=**仍为筛选该分类**(与 `select('all', null, cat.id)` 完全一致);未读计数在折叠后仍显示于分类名右侧;「未分类」组**不做折叠**。
- 折叠状态变化**不触发**文章列表重载(纯展示)。
- j/k 语义:从当前文章位置出发,沿列表方向找到第一个 `!isRead` 且非当前项的文章并打开(打开即走既有 `selectArticle`,受「打开即已读」偏好约束);无当前位置时 j 从列表头、k 从列表尾开始;`j` 方向在列表耗尽且 `hasMore` 时自动 `loadMore()` 一次再找(最多重试一轮,找不到即静默停止,无循环)。
- `?` 浮层:Escape 优先级为「浮层打开时先关浮层,不关文章」;输入框聚焦时所有快捷键不生效(既有守卫保持);浮层与新增控件必须带深色配对(项目纪律)。
- 视觉验收**必须实测**(headless Chrome,独立端口 4399,勿动用户后台 pnpm dev 的 5173/8787):浅色与深色各一轮;记录对比度数值。
- 不改动既有行为:URL 联动、pendingReset、只看未读过滤、源管理菜单、刷新状态机一律零回归。
- TypeScript strict;禁止 any;文案中文;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付。

---

### Task 1: 分类折叠

**Files:**
- Modify: `shared/src/index.ts`(`ReaderPrefs` + `DEFAULT_READER_PREFS` 各加一项)
- Modify: `web/src/stores/settings.ts`(`sanitizePrefs` 加字段)
- Modify: `web/src/components/Sidebar.vue`(分类头改造)
- Modify: `web/src/stores/__tests__/settings.test.ts`(追加断言/用例)
- Modify: `web/src/components/__tests__/sidebar-actions.test.ts`(追加 1 用例)
- Create(验后删): `web/scripts/verify-collapse.mjs`

**Interfaces:**
- Consumes: 既有 `useSettingsStore.updatePrefs`、`navItem` 常量、`visibleFeeds`。
- Produces(冻结):
  - `ReaderPrefs.collapsedCategoryIds: number[]`(shared)
  - `Sidebar` 内 `isCollapsed(categoryId: number): boolean`、`toggleCollapse(categoryId: number): void`;chevron 按钮带 `data-collapse="<categoryId>"` 与 `aria-expanded`(测试与实测依赖此属性)

- [ ] **Step 1: shared 与 sanitize(先类型后实现)**

`shared/src/index.ts`:`ReaderPrefs` 在 `unreadOnly` 之后加:

```ts
  collapsedCategoryIds: number[];
```

`DEFAULT_READER_PREFS` 在 `unreadOnly: false,` 之后加:

```ts
  collapsedCategoryIds: [],
```

`web/src/stores/settings.ts` 的 `sanitizePrefs` 返回对象,在 `unreadOnly` 之后加:

```ts
    collapsedCategoryIds: Array.isArray(o.collapsedCategoryIds)
      ? [...new Set(o.collapsedCategoryIds.filter((v): v is number => typeof v === "number" && Number.isInteger(v)))].slice(0, 200)
      : [],
```

`web/src/stores/__tests__/settings.test.ts`:
- 「非法字段回退默认」用例断言组追加:

```ts
    expect(p.collapsedCategoryIds).toEqual([]);
```

- 新增用例:

```ts
  it("collapsedCategoryIds 去重、过滤非整数、缺省为空", () => {
    expect(sanitizePrefs({ collapsedCategoryIds: [3, 3, 7, "x", 2.5, null] }).collapsedCategoryIds).toEqual([3, 7]);
    expect(sanitizePrefs({}).collapsedCategoryIds).toEqual([]);
    expect(sanitizePrefs({ collapsedCategoryIds: "junk" }).collapsedCategoryIds).toEqual([]);
  });
```

Run: `pnpm --filter @readly/web test src/stores/__tests__/settings.test.ts`
Expected: 先红(字段缺失)后绿;随后 `pnpm --filter @readly/web typecheck` 全通过。

- [ ] **Step 2: Sidebar 折叠(失败测试→实现)**

`web/src/components/__tests__/sidebar-actions.test.ts` 追加(沿用文件内既有挂载/`flush` 助手与 feeds/stats mock;分类数据至少 1 个、其下 1 个源):

```ts
  it("分类折叠:点箭头隐藏源并持久化,点分类名仍是筛选,再点恢复", async () => {
    // mock /api/categories→[{ id: 1, name: "科技", sortOrder: 0, createdAt: "…" }]
    // /api/feeds→[{ id: 1, title: "源甲", categoryId: 1, unreadCount: 1, …其余 Feed 字段 }]
    // /api/stats→零值;挂载 Sidebar 并 await feedsStore.load()
    expect(host!.textContent).toContain("源甲");
    const chevron = host!.querySelector<HTMLButtonElement>('[data-collapse="1"]')!;
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    chevron.click();
    await flush();
    expect(host!.textContent).not.toContain("源甲");
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    const { useSettingsStore } = await import("@/stores/settings");
    expect(useSettingsStore().prefs.collapsedCategoryIds).toContain(1);
    // 点分类名仍是筛选(不等同折叠)
    const nameBtn = Array.from(host!.querySelectorAll("button")).find((b) => b.textContent?.includes("科技"))!;
    nameBtn.click();
    await flush();
    expect(useArticlesStore().categoryId).toBe(1);
    expect(host!.textContent).not.toContain("源甲"); // 折叠未因筛选被重置
    chevron.click();
    await flush();
    expect(host!.textContent).toContain("源甲");
    expect(useSettingsStore().prefs.collapsedCategoryIds).not.toContain(1);
  });
```

(顶部按需 `import { useArticlesStore } from "@/stores/articles";`;mock 数据按 `Category`/`Feed` 冻结类型补全。)

Run: 该文件
Expected: 新用例 FAIL(`[data-collapse]` 不存在)。

`web/src/components/Sidebar.vue` 实现:

1. script:在 `visibleCategories` 之后加:

```ts
const catNavItem =
  "flex min-w-0 flex-1 items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm font-medium text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800";

function isCollapsed(categoryId: number): boolean {
  return settings.prefs.collapsedCategoryIds.includes(categoryId);
}

function toggleCollapse(categoryId: number): void {
  const ids = settings.prefs.collapsedCategoryIds;
  settings.updatePrefs({
    collapsedCategoryIds: ids.includes(categoryId) ? ids.filter((id) => id !== categoryId) : [...ids, categoryId],
  });
}
```

2. 模板:把分类头按钮(即 `<button :class="[navItem, 'mt-2 font-medium text-neutral-500']" @click="select('all', null, cat.id)">…</button>`)整体替换为:

```vue
        <div class="mt-2 flex items-center">
          <button
            class="shrink-0 rounded-md px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            :aria-label="isCollapsed(cat.id) ? '展开分类' : '折叠分类'"
            :aria-expanded="!isCollapsed(cat.id)"
            :data-collapse="cat.id"
            @click="toggleCollapse(cat.id)"
          >
            {{ isCollapsed(cat.id) ? "▸" : "▾" }}
          </button>
          <button :class="catNavItem" @click="select('all', null, cat.id)">
            <span class="truncate">{{ cat.name }}</span>
            <span v-if="stats?.perCategory[cat.id]" class="text-xs">{{ stats.perCategory[cat.id] }}</span>
          </button>
        </div>
        <template v-if="!isCollapsed(cat.id)">
          <div v-for="feed in visibleFeeds(cat.id)" :key="feed.id" class="group relative flex items-center">
            <!-- 原分类内 feed 行整体(含重命名输入框、⋯按钮、菜单)原样搬入此处,不改任何内容 -->
          </div>
        </template>
```

(注意:v-for 的 `<div v-for="feed …">` 与其内部全部子节点**逐字保留**,只外层套 `<template v-if="!isCollapsed(cat.id)">`;`navItem` 仍被未分类区与其他按钮使用,不要删除。)

3. 折叠不触发列表重载:确认 `toggleCollapse` 无任何 `articles.load/setFilter` 调用。

Run: 该文件 PASS;再跑 `pnpm --filter @readly/web test` 全量(69)与 `typecheck`。

- [ ] **Step 3: Chrome 实测(浅+深)**

`web/scripts/verify-collapse.mjs`(一次性,验后删):构建产物 + 独立端口 4399 桩(`/api` 桩:1 分类 + 2 源 + 空列表;注入 `readly_token`),CDP 驱动 headless Chrome,断言并记录:
1. 初始:分类下 2 个源可见,chevron 为 ▾、`aria-expanded=true`;
2. 点 chevron:2 个源消失、chevron 变 ▸;未被折叠的其它区域不受影响;
3. **刷新页面**:折叠保持(持久化生效);
4. 点分类名:列表请求带 `category=1`(筛选行为未被折叠吞掉);
5. 切暗色重测 1–2 的 DOM 断言 + chevron 对比度记录(≥4.5:1 或说明为图标控件);
6. 截图 `/tmp/readly-collapse-light.png`、`/tmp/readly-collapse-dark.png`。

Run: `pnpm build && node web/scripts/verify-collapse.mjs`
Expected: 全部断言通过;数值与截图名记入报告;验后删除脚本。

- [ ] **Step 4: 提交**

```bash
git add shared web && git commit -m "feat: 侧栏分类可折叠(状态持久化,点名字仍为筛选)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 快捷键浏览(j/k 跳未读 + `?` 帮助浮层)

**Files:**
- Create: `web/src/composables/useShortcutHelp.ts`
- Create: `web/src/components/ShortcutHelp.vue`
- Modify: `web/src/views/Inbox.vue`(jumpUnread 替换 j/k;`?` 与 Esc 优先级;挂 `ShortcutHelp`)
- Modify: `web/src/components/Sidebar.vue`(底部「快捷键」入口)
- Modify: `web/src/views/__tests__/inbox-mount.test.ts`(追加用例)
- Modify: `web/src/components/__tests__/sidebar-actions.test.ts`(追加 1 用例)
- Create(验后删): `web/scripts/verify-shortcuts.mjs`

**Interfaces:**
- Produces(冻结):
  - `useShortcutHelp(): { showShortcutHelp: Ref<boolean>; openShortcutHelp(): void; closeShortcutHelp(): void; toggleShortcutHelp(): void }`(模块级单例)
  - `ShortcutHelp.vue`(无 props;自读单例)
  - `Inbox` 内 `jumpUnread(dir: 1 | -1): Promise<void>`

- [ ] **Step 1: composable + 浮层组件**

`web/src/composables/useShortcutHelp.ts`:

```ts
import { ref } from "vue";

// 模块级单例:Sidebar 的入口按钮与 Inbox 里的浮层共享同一个开关
const showShortcutHelp = ref(false);

export function useShortcutHelp() {
  return {
    showShortcutHelp,
    openShortcutHelp: () => {
      showShortcutHelp.value = true;
    },
    closeShortcutHelp: () => {
      showShortcutHelp.value = false;
    },
    toggleShortcutHelp: () => {
      showShortcutHelp.value = !showShortcutHelp.value;
    },
  };
}
```

`web/src/components/ShortcutHelp.vue`:

```vue
<script setup lang="ts">
import { useShortcutHelp } from "@/composables/useShortcutHelp";

const { showShortcutHelp, closeShortcutHelp } = useShortcutHelp();

const shortcuts: { keys: string; action: string }[] = [
  { keys: "j", action: "下一个未读文章" },
  { keys: "k", action: "上一个未读文章" },
  { keys: "s", action: "收藏 / 取消收藏当前文章" },
  { keys: "m", action: "切换已读 / 未读" },
  { keys: "v", action: "加入 / 移出稍后读" },
  { keys: "Esc", action: "关闭文章 / 关闭本浮层" },
  { keys: "?", action: "打开 / 关闭本浮层" },
];
</script>

<template>
  <div
    v-if="showShortcutHelp"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    data-shortcut-help
    @click.self="closeShortcutHelp"
  >
    <div class="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <div class="flex items-center justify-between">
        <h3 class="text-base font-semibold">快捷键</h3>
        <button class="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="closeShortcutHelp">
          关闭
        </button>
      </div>
      <dl class="mt-4 space-y-2 text-sm">
        <div v-for="s in shortcuts" :key="s.keys" class="flex items-center justify-between gap-4">
          <dt>
            <kbd class="rounded-md border border-neutral-300 bg-neutral-100 px-2 py-0.5 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-800">{{ s.keys }}</kbd>
          </dt>
          <dd class="text-right text-neutral-600 dark:text-neutral-300">{{ s.action }}</dd>
        </div>
      </dl>
      <p class="mt-4 text-xs text-neutral-500 dark:text-neutral-400">在列表中按 j 即从当前位置跳到下一个未读。</p>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Inbox 接线(失败测试→实现)**

`web/src/views/__tests__/inbox-mount.test.ts` 追加(沿用文件内挂载/flush 助手与 api mock;items 工厂按文件内既有形态):

```ts
  it("j/k 跳到下/上一个未读,跳过已读;? 开浮层,Esc 先关浮层", async () => {
    const items = [
      { ...item(1), isRead: true },
      { ...item(2), isRead: false },
      { ...item(3), isRead: true },
      { ...item(4), isRead: false },
    ];
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/articles" && !opts?.method) return Promise.resolve({ items, nextCursor: null });
      if (path === "/api/articles/2" || path === "/api/articles/4") return Promise.resolve({ ...items[3], id: Number(path.split("/").pop()) });
      if (path.startsWith("/api/articles/") && opts?.method === "PATCH") return Promise.resolve({});
      if (path === "/api/categories") return Promise.resolve([]);
      if (path === "/api/feeds") return Promise.resolve([]);
      if (path === "/api/stats") return Promise.resolve({ unreadTotal: 2, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
      return Promise.resolve({});
    });
    await mountInbox(); // 文件内既有挂载助手(裸 "/")
    const root = host!.firstElementChild as HTMLElement;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await flush();
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/articles/2", expect.anything()); // 跳过已读的 1,打开未读的 2
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    await flush();
    // 当前为 2,往前找未读:2 之前(索引 0)是已读 1,无可跳,停留
    const opened = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/articles/4");
    // (? 浮层用例放下一段)
  });
```

(具体断言以实际 DOM/请求为准;若文件内挂载助手名称不同,按其模式调整。`k` 用例更稳的构造:先 `reader.open(4)`(经 store)再按 k,断言打开 `/api/articles/2`。)

追加第二段用例:

```ts
  it("? 打开帮助浮层,Esc 关闭浮层且不关闭文章", async () => {
    // mock 同上(可简化);mountInbox 后先 j 打开一篇文章
    const root = host!.firstElementChild as HTMLElement;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flush();
    expect(host!.querySelector("[data-shortcut-help]")).not.toBeNull();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host!.querySelector("[data-shortcut-help]")).toBeNull();
    expect(useReaderStore().article).not.toBeNull(); // 文章未被 Esc 关闭
  });
```

Run: 该文件
Expected: FAIL(`?` 无浮层;j 仍是顺序翻页)。

`web/src/views/Inbox.vue` 实现:

1. import 区加:

```ts
import ShortcutHelp from "@/components/ShortcutHelp.vue";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
```

setup 内加:

```ts
const { showShortcutHelp, toggleShortcutHelp, closeShortcutHelp } = useShortcutHelp();
```

2. 在 `closeArticle` 之后新增:

```ts
// 找到方向上的第一个未读并打开;到列表尾部(j 方向)自动加载一页再找一次
async function jumpUnread(dir: 1 | -1): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = articles.items;
    if (list.length > 0) {
      const cur = list.findIndex((i) => i.id === articles.currentId);
      let idx = cur === -1 ? (dir === 1 ? 0 : list.length - 1) : cur + dir;
      while (idx >= 0 && idx < list.length) {
        const item = list[idx];
        if (item && !item.isRead && item.id !== articles.currentId) {
          await selectArticle(item.id);
          return;
        }
        idx += dir;
      }
    }
    if (dir === 1 && attempt === 0 && articles.hasMore) {
      await articles.loadMore();
      continue;
    }
    return;
  }
}
```

3. `onKey` 整体替换为:

```ts
function onKey(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === "?") {
    toggleShortcutHelp();
    return;
  }
  if (e.key === "Escape" && showShortcutHelp.value) {
    closeShortcutHelp();
    return;
  }
  if (e.key === "j") {
    void jumpUnread(1).catch(() => undefined);
  } else if (e.key === "k") {
    void jumpUnread(-1).catch(() => undefined);
  } else if (e.key === "Escape") {
    closeArticle();
  } else if (reader.article) {
    if (e.key === "s")
      void articles.setState(reader.article.id, { isStarred: !reader.article.isStarred }).catch(() => undefined);
    if (e.key === "m")
      void articles.setState(reader.article.id, { isRead: !reader.article.isRead }).catch(() => undefined);
    if (e.key === "v")
      void articles.setState(reader.article.id, { isLater: !reader.article.isLater }).catch(() => undefined);
  }
}
```

4. 模板:在 `<MobileNav v-if="!reader.article" />` 之后加 `<ShortcutHelp />`。

Run: 该文件 PASS;全量 `pnpm --filter @readly/web test`。

- [ ] **Step 3: Sidebar 入口(小改)**

`web/src/components/Sidebar.vue`:script 加 `import { useShortcutHelp } from "@/composables/useShortcutHelp";` 与 `const { openShortcutHelp } = useShortcutHelp();`;底部按钮区在 OPML 按钮之后加:

```vue
      <button
        class="w-full rounded-lg px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
        @click="openShortcutHelp"
      >
        快捷键
      </button>
```

`web/src/components/__tests__/sidebar-actions.test.ts` 追加:

```ts
  it("「快捷键」按钮打开帮助浮层开关", async () => {
    // mount Sidebar
    const btn = Array.from(host!.querySelectorAll("button")).find((b) => b.textContent?.includes("快捷键"))!;
    btn.click();
    await flush();
    const { useShortcutHelp } = await import("@/composables/useShortcutHelp");
    expect(useShortcutHelp().showShortcutHelp.value).toBe(true);
    useShortcutHelp().closeShortcutHelp(); // 复位单例,避免污染其它用例
  });
```

Run: 该文件 PASS。

- [ ] **Step 4: Chrome 实测(浅+深)**

`web/scripts/verify-shortcuts.mjs`(一次性,验后删):构建产物 + 独立端口 4399 桩 + CDP(用 `Input.dispatchKeyEvent` 真实按键),断言并记录:
1. 初始按 `j`:打开列表里第一个未读(GET `/api/articles/{id}` 命中桩记录)、已读被跳过;连按 `j` 依次落在未读上;`k` 回退到上一个未读;
2. 按 `?`:浮层出现(选择器 `[data-shortcut-help]`);按 `Esc`:浮层消失且文章仍打开;再按 `Esc`:文章关闭(`?a=` 清除);
3. 侧栏「快捷键」按钮:点击后浮层出现;
4. 切暗色:重测 2、3 的 DOM 断言;记录浮层卡片与 kbd 的对比度(目标 ≥4.5:1);
5. 截图 `/tmp/readly-shortcuts-light.png`、`/tmp/readly-shortcuts-dark.png`。

Run: `pnpm build && node web/scripts/verify-shortcuts.mjs`
Expected: 全部断言通过;数值与截图名记入报告;验后删除脚本。

- [ ] **Step 5: 提交**

```bash
git add web && git commit -m "feat: 快捷键升级(j/k 跳未读)与 ? 帮助浮层

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自检记录(writing-plans self-review)

- **需求覆盖**:#1 折叠(箭头折叠/名字仍筛选/持久化/计数保留)→ Task 1;#2 j/k 跳未读(含自动加载一页)、`?` 浮层、侧栏入口、保留 s/m/v/Esc → Task 2;浅深实测 → 两任务各自 Step。
- **有意决策**:① 折叠状态放 `ReaderPrefs`(与 unreadOnly 同机制,跨设备);② 「未分类」不折叠;③ j/k 采用「直接打开」语义(沿用现状,仅把顺序翻页改为跳过已读);④ 浮层用模块级单例 composable 而非 Pinia store(单个布尔,不过度设计);⑤ `?` 仅键盘触发(侧栏按钮兜底发现性)。
- **类型一致性**:`collapsedCategoryIds` 四端同名同型(shared/DEFAULT/sanitize/Sidebar);`useShortcutHelp` 四个导出在浮层/Inbox/Sidebar/测试一致;`data-collapse` 与 `data-shortcut-help` 是测试与实测共用的稳定选择器。
- **风险提示(执行者)**:Task 1 搬移 feed 行时务必逐字保留(含 WeakSet 重命名逻辑与菜单);Task 2 的 jumpUnread 循环边界 `attempt < 2` 是防死循环上限,不要放大;两任务的测试 mock 数据须按 `Category`/`Feed`/`ArticleListItem` 冻结类型补全字段。
