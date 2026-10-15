# Readly 分隔线拖拽调宽 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三栏布局的两条中间分隔线支持鼠标拖拽调宽(实时)、双击恢复默认、宽度持久化并跨设备同步;<1600px 视口时拖拽线隐藏、布局退回现有固定/响应式宽度。

**Architecture:** 宽度存进 `ReaderPrefs`(二次扩展两个数值字段,经既有 localStorage+D1 双写与 sanitizePrefs 钳制);布局宽度经 CSS 变量下发(侧栏/列表各一变量,DOM 内联 style 绑定);拖拽用原生 Pointer Events(pointerdown → setPointerCapture → pointermove 计算 → pointerup 结束),无需引入任何库;分隔线是一个 4px 命中区、2px 视觉细线的独立元素(onPointerDown 只挂在该元素上,不污染既有区域)。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- `ReaderPrefs` 二次扩展(经批准):仅新增 `sidebarWidth: number`(默认 **256**,钳制 **[200, 420]** 整数)与 `listWidth: number`(默认 **380**,钳制 **[300, 600]** 整数),既有字段一律不动;`DEFAULT_READER_PREFS` 与 `sanitizePrefs` 同步(既有的 `clampNumber` 复用)。
- 拖拽语义:pointerdown 记录起点与当前宽;pointermove 以 `start + (clientX - startX)` 更新;pointerup/pointercancel 结束并**持久化**(拖拽过程中的所有更新经既有 1000ms 防抖 PUT 自然合并,无需额外逻辑);**双击 = 恢复该分隔线默认值**。
- 响应式门控:`< 1600px` 不渲染任何分隔线元素(用 `window.innerWidth` 响应式 ref + resize 监听判定;现有 `md:` 断点行为完全不变);侧栏与列表在 ≥1600px 时宽度为 `var(--side-w, 256px)` / `var(--list-w, 380px)`,<1600px 时仍为现有 Tailwind 类(`w-64` / `md:w-[380px]` 等)——两套宽度来源以「是否渲染内联变量样式」切换。
- 拖拽期间禁止选中文本/iframe 吞事件:`user-select: none` 由拖拽态类附加到根容器(body 级不做全局污染);`pointer-events` 保持默认(pin 到 handler 上,拖出元素也持续收到 pointermove)。
- 无 any;strict;文案中文;深色配对;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付;**视觉/交互验收必须实测**(headless Chrome,独立端口 4899,勿动用户 5173/8787),浅色+深色。
- 选择器契约:`[data-resize-handle="sidebar"]`、`[data-resize-handle="list"]`(测试与实测依赖)。

---

### Task 1: 分隔线拖拽(偏好扩展 + 布局变量 + 拖拽实现 + 实测)

**Files:**
- Modify: `shared/src/index.ts`(`ReaderPrefs` + `DEFAULT_READER_PREFS` 各加两项)
- Modify: `web/src/stores/settings.ts`(`sanitizePrefs` 加两项钳制)
- Modify: `web/src/stores/__tests__/settings.test.ts`(追加断言)
- Modify: `web/src/views/Inbox.vue`(CSS 变量 + 两个分隔线元素 + 拖拽/双击/视口门控)
- Create: `web/src/views/__tests__/inbox-resize.test.ts`
- Create(验后删): `web/scripts/verify-resize.mjs`

**Interfaces:**
- Produces(冻结):
  - `ReaderPrefs.sidebarWidth: number` / `ReaderPrefs.listWidth: number`(shared)
  - Inbox 内 `resizeSidebar(deltaX: number): void`、`resizeList(deltaX: number): void`(导出常量 `SIDEBAR_MIN/MAX`、`LIST_MIN/MAX` 供测试;`clampNumber` 复用 settings 的既有钳制风格)
  - 分隔线元素契约:`[data-resize-handle="sidebar"|"list"]`,含 `role="separator"`、`aria-orientation="vertical"`、`title="拖拽调节宽度,双击恢复默认"`

- [ ] **Step 1: shared 与 sanitize(先类型后实现)**

`shared/src/index.ts`:`ReaderPrefs` 在 `collapsedCategoryIds` 之后加:

```ts
  sidebarWidth: number;
  listWidth: number;
```

`DEFAULT_READER_PREFS` 在 `collapsedCategoryIds: [],` 之后加:

```ts
  sidebarWidth: 256,
  listWidth: 380,
```

`web/src/stores/settings.ts` 的 `sanitizePrefs` 返回对象在 `collapsedCategoryIds` 之后加:

```ts
    sidebarWidth: clampNumber(o.sidebarWidth, 200, 420, d.sidebarWidth),
    listWidth: clampNumber(o.listWidth, 300, 600, d.listWidth),
```

`web/src/stores/__tests__/settings.test.ts`:
- 「非法字段回退默认」用例断言组追加 `expect(p.sidebarWidth).toBe(256);` 与 `expect(p.listWidth).toBe(380);`
- 新增用例:

```ts
  it("sidebarWidth/listWidth 钳制与保留", () => {
    expect(sanitizePrefs({ sidebarWidth: 100 }).sidebarWidth).toBe(200);
    expect(sanitizePrefs({ sidebarWidth: 999 }).sidebarWidth).toBe(420);
    expect(sanitizePrefs({ listWidth: 100 }).listWidth).toBe(300);
    expect(sanitizePrefs({ listWidth: 999 }).listWidth).toBe(600);
    expect(sanitizePrefs({ sidebarWidth: 320, listWidth: 450 }).sidebarWidth).toBe(320);
  });
```

Run: `pnpm --filter @readly/web test src/stores/__tests__/settings.test.ts`
Expected: 先红(字段缺失)后绿;`typecheck` 通过。

- [ ] **Step 2: 布局变量与分隔线(失败测试→实现)**

`web/src/views/__tests__/inbox-resize.test.ts`(沿用 inbox-mount 的挂载与 mock seam;fake timers 非必需):

```ts
// @vitest-environment jsdom
// 说明:jsdom 无布局引擎,不做像素断言;本文件钉「交互 → 偏好/变量」链路
// 1. ≥1600px:两条 [data-resize-handle] 存在;缩到 1000px(重派 resize 事件)→ 两条均不存在
// 2. 拖拽 sidebar 把手 +150px:派发 pointerdown(startX=300)→ pointermove(clientX=450)→ pointerup;
//    断言 store.prefs.sidebarWidth === 406(256+150);根容器 style 的 --side-w 为 "406px"
//    注意:jsdom 无 setPointerCapture —— 实现须用 try/catch 包住该调用(守卫写法见实现)
// 3. 拖到越界:piepeline 同 2 但 +1000px → sidebarWidth === 420(上限)
// 4. 双击把手 → sidebarWidth 回到 256;list 把手同理回 380
// 5. list 拖拽 -200px:listWidth === 380-200? (注意最小 300:380-200=180→钳到 300)
```

(完整断言按上述五项实现;`window.innerWidth` 在 jsdom 可经 `Object.defineProperty` 或 `window.resizeTo` 变通——执行时以本环境可行者为准并披露。)

Run: 该文件 Expected: FAIL。

`web/src/views/Inbox.vue` 实现:

1. import 行补 `computed`(已含)与 `DEFAULT_READER_PREFS`;

2. script 追加:

```ts
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 420;
const LIST_MIN = 300;
const LIST_MAX = 600;

const wideEnough = ref(typeof window !== "undefined" ? window.innerWidth >= 1600 : false);
function onWindowResize(): void {
  wideEnough.value = window.innerWidth >= 1600;
}
onMounted(() => window.addEventListener("resize", onWindowResize));
onUnmounted(() => window.removeEventListener("resize", onWindowResize));

const layoutStyle = computed(() =>
  wideEnough.value
    ? {
        "--side-w": `${settings.prefs.sidebarWidth}px`,
        "--list-w": `${settings.prefs.listWidth}px`,
      }
    : undefined
);

function resizeSidebar(deltaX: number): void {
  settings.updatePrefs({ sidebarWidth: settings.prefs.sidebarWidth + deltaX });
}
function resizeList(deltaX: number): void {
  settings.updatePrefs({ listWidth: settings.prefs.listWidth + deltaX });
}

const dragging = ref(false);
function startDrag(kind: "sidebar" | "list", e: PointerEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const handle = e.currentTarget as HTMLElement;
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    /* jsdom 等环境无 setPointerCapture */
  }
  dragging.value = true;
  // 拖拽全程:以起点为基准做增量(每次 move 都相对 startX,避免累计漂移)
  let base = kind === "sidebar" ? settings.prefs.sidebarWidth : settings.prefs.listWidth;
  const move = (ev: PointerEvent): void => {
    const next = base + (ev.clientX - startX);
    if (kind === "sidebar") settings.updatePrefs({ sidebarWidth: next });
    else settings.updatePrefs({ listWidth: next });
    // 钳制会被 sanitizePrefs 处理;base 保持不动,delta 始终对起点计算
  };
  const cleanup = (): void => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", cleanup);
    handle.removeEventListener("pointercancel", cleanup);
    window.removeEventListener("pointerup", cleanup);
    dragging.value = false;
    base = kind === "sidebar" ? settings.prefs.sidebarWidth : settings.prefs.listWidth;
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", cleanup);
  handle.addEventListener("pointercancel", cleanup);
  window.addEventListener("pointerup", cleanup);
}

function resetDivider(kind: "sidebar" | "list"): void {
  if (kind === "sidebar") settings.updatePrefs({ sidebarWidth: DEFAULT_READER_PREFS.sidebarWidth });
  else settings.updatePrefs({ listWidth: DEFAULT_READER_PREFS.listWidth });
}
```

注意:拖拽增量以 `startX` 为唯一基准(不依赖上一次 move),钳制由 sanitizePrefs 兜底;`startDrag` 内的 `base` 变量在 cleanup 中赋值属冗余,实现时可删除(保持最小)。

3. 模板:

根 div 追加 `:style="layoutStyle"` 与拖拽态类:

```vue
  <div class="flex h-full flex-col md:flex-row" :class="dragging ? 'select-none' : ''" :style="layoutStyle" tabindex="0" @keydown="onKey">
```

侧栏宽度侧(现有 `<Sidebar class="hidden md:flex" />` 替换为):

```vue
    <Sidebar class="hidden md:flex" :style="wideEnough ? { width: 'var(--side-w)' } : undefined" />
    <div
      v-if="wideEnough"
      data-resize-handle="sidebar"
      role="separator"
      aria-orientation="vertical"
      title="拖拽调节宽度,双击恢复默认"
      class="hidden w-1 shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-[var(--accent)] md:block dark:bg-neutral-800"
      @pointerdown="startDrag('sidebar', $event)"
      @dblclick="resetDivider('sidebar')"
    />
```

列表列(现有 `<div class="w-full shrink-0 overflow-hidden md:w-[380px] ...">` 替换 class 为条件式):

```vue
      <div
        class="w-full shrink-0 overflow-hidden md:border-r md:border-neutral-200 dark:md:border-neutral-800"
        :class="reader.article ? 'hidden md:block' : 'block'"
        :style="wideEnough ? { width: 'var(--list-w)' } : undefined"
      >
```

(注意:原 class 串含 `md:w-[380px]`——**在宽屏分支下必须去掉**,否则与内联 width 竞争;上面写法把 `md:w-[380px]` 移除并以变量承接;`md:border-r` 保留。)

阅读区前插入第二条把手(仅当文章打开即中间两条都在时才有意义;但允许在无文章时也显示——它此时分隔列表与占位区,拖拽同样有效):

```vue
      <div
        v-if="wideEnough && reader.article"
        data-resize-handle="list"
        role="separator"
        aria-orientation="vertical"
        title="拖拽调节宽度,双击恢复默认"
        class="hidden w-1 shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-[var(--accent)] md:block dark:bg-neutral-800"
        @pointerdown="startDrag('list', $event)"
        @dblclick="resetDivider('list')"
      />
```

- [ ] **Step 3: 全量验证**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build`
Expected: 全绿(inbox-mount 等既有挂载测试若因新增元素/监听受影响,按最小修复并披露)。

- [ ] **Step 4: Chrome 实测(浅+深)**

`web/scripts/verify-resize.mjs`(一次性,验后删):构建产物 + 独立端口 4899 桩(最小 `/api` 桩 + 注入 `readly_token`),CDP:
1. 视口 1600×900:两条 `[data-resize-handle]` 存在;记录 `aside` 与列表列 `getBoundingClientRect().width`;
2. 对 sidebar 把手:dispatchMouseEvent 序列(mousePressed at 把手中心 → mouseMoved +120 → mouseReleased)——**注意 Pointer Events**:CDP `Input.dispatchMouseEvent` 会产生 pointer 事件,如环境只派发 mouse 事件不触发 pointerdown,则用 `page.dispatchEvent` 等价注入 PointerEvent,报告说明所用方式;
   → 断言侧栏宽度 ≈ 起点+120、`--side-w` 变量同步、localStorage `readly_prefs.sidebarWidth` 已写;
3. 双击把手(`dblclick` 注入)→ 宽度回 256;
4. 刷新页面 → 拖拽后的宽度保持(先再做一次拖动再刷新);
5. 视口缩到 1000×800 → 两条把手均不存在;恢复 1600 → 回归;
6. 拖拽进行中根容器带 `select-none`(取样 className);
7. 切暗色重测 1/5 的 DOM 断言;记录把手 hover 态与暗色下可视性(把手颜色 vs 两侧背景,记录色值;hover 变 accent 色);
8. 截图 `/tmp/readly-resize-light.png`、`/tmp/readly-resize-dark.png`。

Run: `pnpm build && node web/scripts/verify-resize.mjs`
Expected: 全部断言通过;数值与截图名记入报告;验后删除脚本。

- [ ] **Step 5: 提交**

```bash
git add shared web
git commit -m "feat(web): 分隔线拖拽调宽(偏好持久化/双击复位/1600px 门控)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 后续计划索引

- **计划 07 — AI 翻译(M6b)**;**计划 08 — 收尾(M7)**(含既有 M7 交接项)。

## 自检记录(writing-plans self-review)

- **规格覆盖**:两条分隔线可拖(实时)、双击复位、持久化跨设备、边界钳制、窄屏门控与移动端零影响——单任务全覆盖。
- **有意决策**:①宽度进 ReaderPrefs(与 unreadOnly/collapsedCategoryIds 同机制);②`<1600px` 不渲染把手(而非禁用),对既有断点零侵入;③pointer 增量以起点为唯一基准;④`md:w-[380px]` 从列表列移除改由变量承接(宽屏),窄屏仍走 `w-full`;⑤jsdom 无布局/捕获 API 已注明守卫。
- **类型一致性**:`sidebarWidth/listWidth` 四端同名同型(shared/DEFAULT/sanitize/Inbox);把手契约两处一致。
- **无占位符**:Step 2 实现中一处冗余赋值明示「实现时可删除」;测试五项与实测八项均给出具体断言。
