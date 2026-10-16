# Readly 侧栏精简 + 功能入设置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏底栏只留「设置/刷新订阅」;「导入导出 OPML」「快捷键」迁入设置页(OPML 为唯一入口,AddFeed 移除 OPML 标签页;快捷键浮层由设置页自挂)。

**Architecture:** 纯前端迁移:OPML 的导入/导出逻辑从 `AddFeed.vue` 整体搬到 `Settings.vue` 新「订阅数据」区块;`ShortcutHelp` 沿用「宿主视图挂载」惯例挂进设置页;侧栏删两项。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- 设计文档:`docs/superpowers/specs/2026-10-16-sidebar-slim-settings-design.md`(已评审)。
- 选择器契约(冻结):`[data-opml-import]`、`[data-opml-export]`、`[data-shortcut-help-open]`。
- 迁移逐字原则:OPML 的 importOpml/doExport 及其文案(「导入完成:成功 N 个源」「订阅列表…」失败列表)、`ShortcutHelp` 组件本体(含 `onUnmounted(closeShortcutHelp)`)不改逻辑;AddFeed 保留部分(单个/批量/发现/直接订阅)零行为变化。
- 侧栏底栏保留项「设置」「刷新订阅」逐字不动(busy 文案/disabled 保留)。
- Inbox/App 零改动;移动端 MoreSheet 零改动;不新增偏好;无 `any`;strict;样式含深浅配对。
- 视觉验收必须实测(纪律 1):Chrome 浅/深截图;样板 `/tmp/readly-final-verify-final.mjs`;不触碰 5173/8787。
- 每任务一个 commit,消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

---

### Task 1: 迁移实现(Sidebar 删除 · AddFeed 移除 OPML · Settings 新两区块)+ 测试迁移

**Files:**
- Modify: `web/src/components/Sidebar.vue`
- Modify: `web/src/views/AddFeed.vue`
- Modify: `web/src/views/Settings.vue`
- Modify: `web/src/views/__tests__/add-feed.test.ts`
- Modify: `web/src/components/__tests__/sidebar-actions.test.ts`
- Modify: `web/src/views/__tests__/settings-mount.test.ts`

**Interfaces:**
- Consumes:`parseOpml`/`exportOpml`/`OpmlFeed`(`@/modules/opml`)、`useFeedsStore`、`useArticlesStore().markStale`、`useShortcutHelp().openShortcutHelp`、`ShortcutHelp` 组件。
- Produces:设置页两区块与三个选择器契约(Task 2 依赖)。

- [ ] **Step 1: 改测试(先定契约)**

**1a. `sidebar-actions.test.ts`** —— 把「『快捷键』按钮打开帮助浮层开关(模块级单例)」整个用例替换为:

```ts
  it("底栏精简:仅保留 设置 与 刷新订阅,OPML/快捷键已移除", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const feedsStore = useFeedsStore();
    await feedsStore.load();
    const container = await mountSidebar(pinia, flush);

    expect(findButton(container, "设置")).toBeTruthy();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim().startsWith("刷新订阅"))).toBe(true);
    expect(findButton(container, "导入 / 导出 OPML")).toBeUndefined();
    expect(findButton(container, "快捷键")).toBeUndefined();
  });
```

顶部 import 中 `useShortcutHelp` 若因此不再被引用,删除该 import 行(`grep -n "useShortcutHelp" web/src/components/__tests__/sidebar-actions.test.ts` 复核为 0)。

**1b. `add-feed.test.ts`** —— 删除「AddFeed OPML 导入」整个 describe(原 75-97 行)与文件顶部的 `OPML` 常量(14-24 行);删除后 `grep -n "useArticlesStore\|OPML" web/src/views/__tests__/add-feed.test.ts` 复核,如 `useArticlesStore` 已无其他使用则同步移除其 import。

**1c. `settings-mount.test.ts`** —— 顶部追加 imports:

```ts
import { useArticlesStore } from "@/stores/articles";
import { useShortcutHelp } from "@/composables/useShortcutHelp";

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>订阅列表</title></head>
  <body>
    <outline text="科技">
      <outline type="rss" text="少数派" title="少数派" xmlUrl="https://sspai.com/feed" htmlUrl="https://sspai.com"/>
    </outline>
    <outline text="独立源" type="rss" xmlUrl="https://blog.example.com/atom.xml" title="独立博客"/>
  </body>
</opml>`;
```

`beforeEach` 的 api mock(现有实现)在末尾 `return Promise.resolve({})` 之前补:

```ts
    if (path === "/api/categories" && opts?.method === "POST")
      return Promise.resolve({ id: 1, name: "科技", sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    if (path === "/api/feeds" && opts?.method === "POST") return Promise.resolve({ created: [{ id: 1 }], failed: [] });
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
```

describe 末尾追加 3 用例(若文件无 describe 包裹,加在最末):

```ts
  it("订阅数据:导入 OPML 后标记列表失效并给出结果", async () => {
    const { container } = await mountSettings(); // 内部 setActivePinia,之后才可用 store
    const articles = useArticlesStore();
    expect(articles.stale).toBe(false);

    const input = container.querySelector<HTMLInputElement>("[data-opml-import]");
    expect(input).toBeTruthy();
    // jsdom 未实现 Blob.prototype.text();按组件消费面桩最小 File(text() 返回 OPML 文本)
    const file = { name: "readly.opml", text: async () => OPML } as unknown as File;
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();

    // 1 分类(1 源)+ 1 未分类源
    expect(container.textContent).toContain("导入完成:成功 2 个源");
    expect(useArticlesStore().stale).toBe(true);
  });

  it("订阅数据:点导出触发 Blob 下载", async () => {
    const createUrl = vi.fn(() => "blob:mock");
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createUrl, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeUrl, configurable: true, writable: true });
    try {
      const { container } = await mountSettings();
      container.querySelector<HTMLButtonElement>("[data-opml-export]")!.click();
      await flush();
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(revokeUrl).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("帮助:点「查看快捷键」在设置页打开浮层(宿主自挂)", async () => {
    const { container } = await mountSettings();
    expect(container.querySelector("[data-shortcut-help]")).toBeNull();
    container.querySelector<HTMLButtonElement>("[data-shortcut-help-open]")!.click();
    await flush();
    expect(useShortcutHelp().showShortcutHelp.value).toBe(true);
    expect(container.querySelector("[data-shortcut-help]")).not.toBeNull();
    useShortcutHelp().closeShortcutHelp(); // 复位单例,避免外溢
  });
```

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm -C web exec vitest run src/views/__tests__/settings-mount.test.ts src/views/__tests__/add-feed.test.ts src/components/__tests__/sidebar-actions.test.ts`
Expected: settings 3 用例 FAIL(选择器不存在/浮层未挂);sidebar 底栏用例 FAIL(两项仍在);add-feed 因 describe 已删其相关用例不再运行(该文件仍绿)。

- [ ] **Step 3: 侧栏删除两项**

`web/src/components/Sidebar.vue`:
- 顶部 import 区删除:`import { useShortcutHelp } from "@/composables/useShortcutHelp";`
- 删除 `const { openShortcutHelp } = useShortcutHelp();`
- 底栏(「设置」按钮之前)删除两个按钮(逐字):

```html
      <button class="w-full rounded-lg px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="router.push('/add')">
        导入 / 导出 OPML
      </button>
      <button
        class="w-full rounded-lg px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
        @click="openShortcutHelp"
      >
        快捷键
      </button>
```

「设置」「刷新订阅」两个按钮与其余文件内容不动。

- [ ] **Step 4: AddFeed 移除 OPML**

`web/src/views/AddFeed.vue`:
1. `import { onMounted, ref } from "vue";` → `import { ref } from "vue";`
2. 删除 `import { exportOpml, parseOpml, type OpmlFeed } from "@/modules/opml";`
3. `const tab = ref<"single" | "batch" | "opml">("single");` → `const tab = ref<"single" | "batch">("single");`
4. 删除整个 `onMounted(...)` 块(含「订阅列表加载失败,导出可能不完整」文案)。
5. 删除 `async function importOpml(e: Event) {...}` 与 `function doExport() {...}` 两个函数整体。
6. 模板删除 OPML tab 按钮:`<button :class="tabCls(tab === 'opml')" @click="tab = 'opml'">OPML 导入/导出</button>`。
7. 模板删除 ``<div v-else class="mt-6 space-y-4">…OPML 文件导入…导出全部订阅(OPML)…</div>`` 整个分支(即 `v-else-if="tab === 'batch'"` 之后原 `v-else` 块)。
其余(单个/批量/发现/直接订阅/消息/失败列表)不动。

- [ ] **Step 5: Settings 新增两区块**

`web/src/views/Settings.vue`:

**脚本区**:imports 区追加:

```ts
import ShortcutHelp from "@/components/ShortcutHelp.vue";
import { exportOpml, parseOpml, type OpmlFeed } from "@/modules/opml";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";
```

`const ai = useAiStore();` 之后追加:

```ts
const store = useFeedsStore();
const { openShortcutHelp } = useShortcutHelp();
const busy = ref(false);
const message = ref("");
const failures = ref<{ url: string; error: string }[]>([]);
```

`onSave/onDelete` 函数之后追加(自 AddFeed 迁移,`store` 引用对齐、`markListStale` 同款):

```ts
// 订阅集合已变(OPML 导入):标记文章列表失效,返回阅读器时由 Inbox 自动重拉
function markListStale(): void {
  useArticlesStore().markStale();
}

async function importOpml(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const text = await file.text();
  busy.value = true;
  message.value = "";
  failures.value = [];
  try {
    const parsed = parseOpml(text);
    let created = 0;
    for (const cat of parsed.categories) {
      const c = await store.createCategory(cat.name);
      const r = await store.addFeeds(cat.feeds.map((f) => f.url), c.id);
      created += r.created;
      failures.value.push(...r.failed);
    }
    if (parsed.uncategorized.length > 0) {
      const r = await store.addFeeds(parsed.uncategorized.map((f) => f.url), null);
      created += r.created;
      failures.value.push(...r.failed);
    }
    markListStale();
    message.value = `导入完成:成功 ${created} 个源`;
  } catch (err) {
    message.value = err instanceof Error ? err.message : "OPML 解析失败";
  } finally {
    busy.value = false;
  }
}

function doExport(): void {
  const categories = store.categories.map((c) => ({
    name: c.name,
    feeds: store.feeds
      .filter((f) => f.categoryId === c.id)
      .map((f): OpmlFeed => ({ url: f.url, title: f.title, siteUrl: f.siteUrl })),
  }));
  const uncategorized = store.feeds
    .filter((f) => f.categoryId === null)
    .map((f): OpmlFeed => ({ url: f.url, title: f.title, siteUrl: f.siteUrl }));
  if (uncategorized.length > 0) categories.push({ name: "未分类", feeds: uncategorized });
  const xml = exportOpml(categories);
  const blob = new Blob([xml], { type: "text/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "readly-subscriptions.opml";
  a.click();
  URL.revokeObjectURL(a.href);
}
```

注意:`doExport` 需要 `store.feeds/categories` 已加载 → 进入设置页时 load 一次。在既有 `onMounted` 里补一行(与 ai.init 并列):

```ts
  void store.load().catch(() => undefined);
```

**模板区**:在「AI 服务商」section 的 `</section>` 之后、`<ProviderEditor ...>` 之前插入:

```html
    <section class="mt-8">
      <h2 class="text-base font-semibold">订阅数据</h2>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">OPML 是通用的订阅列表格式,可在其它阅读器间迁移。</p>
      <div class="mt-4 flex flex-wrap gap-2">
        <label class="cursor-pointer rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
          导入 OPML
          <input type="file" accept=".opml,.xml" class="hidden" data-opml-import @change="importOpml" />
        </label>
        <button
          data-opml-export
          :disabled="busy"
          class="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="doExport"
        >
          导出全部订阅(OPML)
        </button>
      </div>
      <div v-if="message" class="mt-4 rounded-lg bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-900">{{ message }}</div>
      <ul v-if="failures.length" class="mt-2 space-y-1 text-xs text-red-600 dark:text-red-400">
        <li v-for="f in failures" :key="f.url">{{ f.url }}:{{ f.error }}</li>
      </ul>
    </section>

    <section class="mt-8">
      <h2 class="text-base font-semibold">帮助</h2>
      <button
        data-shortcut-help-open
        class="mt-4 rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        @click="openShortcutHelp"
      >
        查看快捷键
      </button>
    </section>

    <ShortcutHelp />
```

- [ ] **Step 6: 运行确认 GREEN(三文件 + 全量 + typecheck)**

Run: `pnpm -C web exec vitest run src/views/__tests__/settings-mount.test.ts src/views/__tests__/add-feed.test.ts src/components/__tests__/sidebar-actions.test.ts`
Expected: 三文件全过。
Run: `pnpm --filter @readly/web test`
Expected: 272(270 −1 迁移出 +3 新增;侧栏为替换持平)。不符须查明原因,不得改数字。
Run: `pnpm -r typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Sidebar.vue web/src/views/AddFeed.vue web/src/views/Settings.vue web/src/views/__tests__/add-feed.test.ts web/src/components/__tests__/sidebar-actions.test.ts web/src/views/__tests__/settings-mount.test.ts
git commit -m "feat(web): 侧栏精简——OPML 与快捷键迁入设置页(OPML 唯一入口)

侧栏底栏仅留 设置/刷新订阅;设置页新增「订阅数据」(导入/导出 OPML,逻辑
自添加页整体迁移)与「帮助」(快捷键浮层,宿主自挂);AddFeed 移除 OPML 标签页。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Chrome 浅/深实测

**Files:**
- Create(验后删):`/tmp/readly-slim-verify.mjs`;截图 `/tmp/readly-slim-{settings,help,sidebar}-{light,dark}.png`(按需 4-6 张)。

**Interfaces:**
- Consumes:`web/dist`、样板 `/tmp/readly-final-verify-final.mjs`、选择器 `[data-opml-import]`/`[data-opml-export]`/`[data-shortcut-help-open]`/`[data-shortcut-help]`。

- [ ] **Step 1: 全量验证与构建**

Run: `pnpm -r test`(期望 worker 146 + web 272 = 418 全绿)→ `pnpm -r typecheck` → `pnpm build`。

- [ ] **Step 2: Chrome 实测**

样板模式(桩 API `127.0.0.1:5106`,CDP 9540,profile `/tmp/readly-slim-profile` 先删;预置 `localStorage.readly_token`;不碰 5173/8787;桩最小端点:categories/feeds/stats/articles)。动线(浅色):

1. 打开 `/`:断言侧栏底栏按钮文案集合 = {设置, 刷新订阅…} 且**不含**「导入 / 导出 OPML」「快捷键」→ 截图 `/tmp/readly-slim-sidebar-light.png`;
2. 点「设置」→ 断言出现「订阅数据」(含 `[data-opml-import]`、`[data-opml-export]`)与「帮助」(含 `[data-shortcut-help-open]`)→ 截图 `/tmp/readly-slim-settings-light.png`;
3. 点「查看快捷键」→ 断言 `[data-shortcut-help]` 出现 → 截图 `/tmp/readly-slim-help-light.png` → 点遮罩关闭,浮层消失(点外关闭在本页可用);
4. 加 `html.dark` → 设置页截图 `/tmp/readly-slim-settings-dark.png`、浮层重开截图 `/tmp/readly-slim-help-dark.png`;
5. 零未捕获异常、零意外 4xx/5xx;验后删脚本。

- [ ] **Step 3: 记录**

断言逐条(底栏文案集合、两区块选择器、浮层开合)、截图路径写入交付汇报;任一不符停下报告。

---

## Self-Review 记录

- 规格覆盖:§1 → Step 3;§2 → Step 5;§3 → Step 4;§4 → Step 1/6;§5 → T2;§6 不做项 → 计划无相关触碰。
- 占位符扫描:无 TBD/TODO;全部代码逐字。
- 一致性:三个选择器在 Step 1c/5/T2 三处逐字一致;`store`(feeds)/`markStale` 引用与 AddFeed 原版语义相同;`URL.createObjectURL` 桩用 defineProperty + Reflect 清理(无 any)。
- 计数核对:web 270−1+3=272;worker 146;合计 418。以实际为准,不符须查明原因。
