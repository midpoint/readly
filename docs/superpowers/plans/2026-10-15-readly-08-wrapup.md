# Readly 收尾(计划 08 / M7)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收尾清单一次清账:AI 残留(AbortSignal.any 兼容、超时文案、上限反馈、陈旧写守卫、error 分支测试)、交互一致性(移动端入口、把手键盘可达、切文监听清理)、全局扫描(深色配对/aria/「本地匹配中」提示),并以终局验证(全量测试 + Chrome 核心动线冒烟 + dry-run 部署)结束全部开发。

**Architecture:** 全部为既有代码上的定向小修,无新模块;唯一新 UI 是 `MobileNav` 的「更多」底部弹层(事件/关键词/设置/快捷键四个入口)。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- 不改任何已冻结接口语义;既有 353 测试(worker 128 + web 225)全绿是每步底线。
- a11y 目标:分隔线可 Tab 聚焦、方向键调宽(±16px)、`aria-valuenow/min/max` 同步;布局切换 `aria-pressed`;窄屏 scopeLabel 有 `title`。
- 移动端不破坏既有底部 Tab 行为;新「更多」弹层沿用 ShortcutHelp 的遮罩模式,深色配对。
- 用户后台 pnpm dev(5173/8787)不要动;Chrome 实测独立端口 5099。
- 无 any;strict;文案中文;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付。

---

### Task 1: AI 收尾(兼容/文案/反馈/守卫/测试)

**Files:**
- Modify: `web/src/modules/ai.ts`(`mergeSignals` 兼容封装 + 超时文案映射)
- Modify: `web/src/views/Settings.vue`(20 上限反馈)
- Modify: `web/src/stores/ai.ts`(切文陈旧写守卫 + 注释)
- Modify: `web/src/modules/__tests__/ai.test.ts`(追加 2 用例)
- Modify: `web/src/stores/__tests__/ai.test.ts`(追加 1 用例)
- Modify: `web/src/components/__tests__/ai-summary.test.ts`(追加 error 分支 1 用例)

**Interfaces:**
- Produces: `mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal`(从 ai.ts 导出;`AbortSignal.any` 可用时直接用,**否则回退实现**:新建 AbortController,任一侧 abort 时转发 `abort(reason)` 并清理监听)。浏览器兼容性注记随之写入 README(见 Task 3)。

- [ ] **Step 1: 失败测试**

`modules/__tests__/ai.test.ts` 追加:

```ts
describe("mergeSignals 兼容回退", () => {
  it("AbortSignal.any 缺失时仍能合并(任一侧 abort 均传导)", async () => {
    const { mergeSignals } = await import("@/modules/ai");
    const original = AbortSignal.any;
    // @ts-expect-error 临时移除以走回退分支
    AbortSignal.any = undefined;
    try {
      const caller = new AbortController();
      const timeout = AbortSignal.timeout(50_000);
      const merged = mergeSignals(caller.signal, timeout);
      expect(merged.aborted).toBe(false);
      caller.abort();
      expect(merged.aborted).toBe(true);
    } finally {
      AbortSignal.any = original;
    }
  });
  it("超时信号给出中文「请求超时」(fetch 抛 TimeoutError 时)", async () => {
    // stubGlobal fetch → 监听 init.signal,abort 时 reject(new DOMException("x","TimeoutError"))
    // 以 timeoutMs=20 调用 chatStream 任一路径 → rejects /请求超时/
  });
});
```

`stores/__tests__/ai.test.ts` 追加:

```ts
  it("切文后旧生成落地不写 degraded/流文本(seq+id 守卫)", async () => {
    // 手控生成器:generateSummary(A) 在途 → resetSummary() → 释放生成器 → 断言
    // summaryStream 仍为空、无 POST、summaryState==="idle"
  });
```

`components/__tests__/ai-summary.test.ts` 追加:

```ts
  it("生成失败:错误行渲染且组件不崩,流式卡收起", async () => {
    // chatStream rejects("服务商返回错误(HTTP 500)") → 点击后 [data-ai-error] 出现、
    // 无 [data-ai-card]、按钮恢复可点
  });
```

Run: 三文件 Expected: 新用例 FAIL(`mergeSignals` 未导出;超时文案仍英文;error 分支未覆盖)。

- [ ] **Step 2: 实现**

`modules/ai.ts`:

```ts
export function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(a ? [a, b] : [b]);
  // 兼容回退(Chrome <116 等):任一 abort 传导到合并信号
  const controller = new AbortController();
  const forward = (from: AbortSignal): void => controller.abort(from.reason);
  if (a?.aborted || b.aborted) controller.abort(a?.aborted ? a.reason : b.reason);
  a?.addEventListener("abort", () => forward(a), { once: true });
  b.addEventListener("abort", () => forward(b), { once: true });
  return controller.signal;
}
```

`chatStream` 内两处 fetch 的 `signal` 改用 `mergeSignals(opts.signal, AbortSignal.timeout(120_000))`(替换既有 `mergedAbortSignal` 实现,保持行为);**超时文案**:在 fetch 的 catch 中:

```ts
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("请求超时");
    throw e;
  }
```

(直连与代理两处同加;取消(caller abort)仍以 AbortError 原样抛出——store 依 `controller.signal.aborted` 静默,语义不变。)

`Settings.vue`:`[data-new-provider]` 按钮 `:disabled="ai.providers.length >= 20"`,并在服务商区标题旁加提示 `v-if="ai.providers.length >= 20"`「最多 20 个服务商」。补断言(置 20 条 → 按钮 disabled)。

`stores/ai.ts`:确认/补「切文陈旧写守卫」——`runSummary` 续段在写 `summaryStream/summaryState/aiDegraded` 前统一校验 `seq === summarySeq`;若当前实现缺少 `aiDegraded` 的守卫,补上并加注释「切文(resetSummary)后旧续段不得写任何可见状态」;`aiDegraded` 旁注明「仅在 state=done 下被消费」。

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck` 全绿(web 预计 231+)。

- [ ] **Step 3: 提交**

```bash
git add web
git commit -m "fix(web): AI 收尾(信号合并兼容/超时文案/上限反馈/陈旧写守卫)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 交互一致性(移动端入口 / 把手键盘可达 / 卸载清理)

**Files:**
- Create: `web/src/components/MoreSheet.vue`(底部弹层:事件/关键词/设置/快捷键)
- Modify: `web/src/components/MobileNav.vue`(加「更多」入口)
- Modify: `web/src/views/Inbox.vue`(把手键盘可达 + 拖拽中卸载清理)
- Modify: `web/src/components/ArticleList.vue`(scopeLabel `title` + 布局切换 `aria-pressed`)
- Modify: `web/src/components/__tests__/`(对应文件追加断言)

**Interfaces:**
- Produces:
  - `MoreSheet.vue`(`defineEmits<{ close: [] }>()`;四个入口分别 `router.push` `/events`、`/keywords`、`/settings`,以及 `openShortcutHelp()`;入口选择器 `[data-more-item="events"|"keywords"|"settings"|"shortcuts"]`)
  - `MobileNav` 第六个 tab `[data-more]`(文案「更多」)
  - 把手:`tabindex="0"`、`aria-valuenow/min/max`、`@keydown.left/right`(±16px;`Shift` 加速 ×4=64px)

- [ ] **Step 1: 失败测试**

- `sidebar-actions` 或新建 `more-sheet.test.ts`:MobileNav 点「更多」→ 弹层出现且含四个入口;点「事件」→ router 路径 `/events`;Esc/遮罩关闭。
- `inbox-resize.test.ts` 追加:把手 `Tab` 可聚焦(tabindex 存在);`keydown ArrowRight` → `sidebarWidth +16`;`Shift+ArrowLeft` → `-64`;`aria-valuenow` 随宽度更新。
- 既有 toolbar 断言追加 `aria-pressed` 双向。

Run: Expected FAIL。

- [ ] **Step 2: 实现**

`MoreSheet.vue`:沿用 ShortcutHelp 遮罩模式(底部对齐卡片,`fixed inset-x-0 bottom-0 z-50` 圆角上边;四个入口行按钮 + 图标字符文本;深色配对;`@click.self` 关闭;Esc 监听与 Inbox onKey 的浮层优先级一致——**用独立 ref 还是并入 useShortcutHelp?** 采用本地 `showMore` ref 于 MobileNav 内管理,不做全局——弹层挂在 MobileNav 内即可,避免再增全局态)。

`MobileNav.vue`:第五个 tab 后加:

```vue
    <button data-more class="flex-1 py-2.5 text-center text-xs text-neutral-500" @click="showMore = true">更多</button>
    <MoreSheet v-if="showMore" @close="showMore = false" />
```

`Inbox.vue`:把手元素补 `tabindex="0"`、`:aria-valuenow`、`:aria-valuemin="kind==='sidebar'?SIDEBAR_MIN:LIST_MIN"`、`:aria-valuemax`、`@keydown.right.prevent`/`@keydown.left.prevent` 调 `resizeSidebar/±16`(Shift → ±64);拖拽清理:`startDrag` 内注册的 window 监听在 `cleanup` 之外,再挂一份到组件级——实现为模块内 `activeDragCleanup: (() => void) | null`,startDrag 赋值、cleanup 置空,`onUnmounted(() => activeDragCleanup?.())`。

`ArticleList.vue`:scopeLabel span 加 `:title="scopeLabel"`;布局切换按钮加 `:aria-pressed="settings.prefs.articleLayout === 'list'"`。

Run: 全量 + typecheck + build 全绿。

- [ ] **Step 3: 提交**

```bash
git add web
git commit -m "feat(web): 移动端更多入口、把手键盘可达与卸载清理

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 全局清账 + 终局验证

**Files:**
- Modify: `web/src/views/Keywords.vue` / `KeywordDetail.vue`(命中计算中提示)
- Modify: `README.md`(浏览器要求注记 + 终审错别/事实复核)
- 全局扫描(见 Step 1)
- Create(验后删): `web/scripts/verify-final.mjs`

- [ ] **Step 1: 深色配对/aria 残余扫描与修复**

Run(扫描):

```bash
grep -rn "text-neutral-500" web/src/components web/src/views | grep -v "dark:text-neutral" | grep -v "__tests__"
```

规则:命中行若属**已验收的弱化文本档**(计数徽标、次级说明,4.18:1)保留并核对台账;其余补齐 `dark:text-neutral-400`(由执行者逐条记录分类)。同时扫描 `bg-neutral` 类深底无配对文字的组合(模式:`bg-neutral-\d00` 行邻近 `text-` 缺失 dark)。

- [ ] **Step 2: 命中计算中提示**

`Keywords.vue` 规则区头部与 `KeywordDetail.vue` 列表头部:当 `analysis.hitsState === "computing"` 显示 `[data-hits-computing]` 小字「本地匹配中…」(浅/深配对);补一条 KeywordDetail 断言(置 hitsState='computing' → 出现)。

- [ ] **Step 3: README 终审**

- 部署节补一句浏览器要求:「需较新的现代浏览器(Chrome 116+ / Safari 17.4+ / Firefox 124+;更旧浏览器 AI 直连的超时合并会回退为内置兼容实现,无功能损失)」——核对 `mergeSignals` 回退后措辞准确;
- 通读全文核对功能清单与实际交付一致(尤其是:无 TTS、无翻译;含布局切换/分隔线/AI 摘要);
- 本地开发节命令与实际脚本复核(`pnpm build && pnpm dev`、`pnpm -r test`)。

- [ ] **Step 4: 终局验证(全量 + 冒烟 + dry-run)**

1. `pnpm build && pnpm -r test && pnpm -r typecheck` 全绿;
2. `pnpm --filter @readly/worker exec wrangler deploy --dry-run`(占位 database_id 下 dry-run 应通过);
3. Chrome 冒烟 `verify-final.mjs`(一次性,独立端口 5099;桩 API):**核心动线一遍**——登录页(令牌桩)→ 加源(桩 feed)→ 列表渲染 → 打开文章(自动已读)→ 主题面板切暗色 → AI 摘要(桩 SSE)→ 事件视图出组 → 关键词规则命中打点 → 分隔线拖拽 → 布局切换 → 移动视口(360px)底部「更多」→ 设置页;浅色/暗色各半程;断言零未捕获异常、零 4xx/5xx(预期外);截图 4 张(`/tmp/readly-final-*.png`)。
4. 验证后删脚本。

- [ ] **Step 5: 提交**

```bash
git add web README.md
git commit -m "chore: 收尾清账(配对/提示/README)与终局验证脚本清理

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自检记录

- 覆盖台账 fix-soon 全部条目(AbortSignal.any、TimeoutError 文案、20 上限、陈旧写守卫与测试、移动端入口、把手 a11y/键盘、卸载清理、aria-pressed、scopeLabel title、配对扫描、命中计算提示、README/部署复核)+ 终局验证;TTS 与翻译取消已同步进设计文档与 README(e7fe371 后随本计划提交)。
- 无占位符:每步含实现要点与断言要求;扫描类步骤给出命令与分类规则;冒烟给出 12 步动线清单。
