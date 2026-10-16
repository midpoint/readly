# Readly 列表模式行内容精简 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 列表模式每行精简为单行「标题 + 状态标记」(移除源名·时间);抽 `ArticleMarks.vue` 供双布局共用;卡片模式零视觉变更。

**Architecture:** `ArticleListItem.vue` 模板按 `layout` 分两个分支(list=单行带右侧聚簇 / card=现结构不变);标记聚簇(命中点≤3 + 「+n」+ ★ + 🕘)连同其色点逻辑迁入新组件 `ArticleMarks.vue`,两分支共用,组件输出逐字等价(类名/选择器冻结)。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- 设计文档:`docs/superpowers/specs/2026-10-16-list-mode-minimal-design.md`(已评审)。行为以其为准。
- 契约冻结(多处测试依赖,逐字保留):`data-article-row`、`data-layout`、`data-hit-dot`、`data-rule-id`、`py-1.5`/`py-3`、`line-clamp-1`/`line-clamp-2`、未读点 class 特征(含 `bg-[var(--accent)]` 与 `rounded-full`)、`select` emit。
- **卡片模式零视觉变更**:副信息行/摘要/缩略图结构与类名不变;标记聚簇迁入组件后内部 gap 用 `gap-2`(与外层一致 → 逐像素等价);聚簇容器自带 `text-xs`(卡片继承不变、列表模式显式定档)。
- 列表模式:不再渲染 `feedTitle` 与 `relative(publishedAt)`;h3 保留 `text-sm font-medium line-clamp-1 min-w-0 flex-1`;根按钮 list 分支加 `items-center`(card 分支不加)。
- 无 `any`;strict;不引入新偏好开关。
- 视觉验收必须实测(纪律 1):Chrome 浅/深截图 + DOM 文本断言;对照样板 `/tmp/readly-final-verify-final.mjs`(桩 API + CDP 直连);不触碰用户 5173/8787。
- 每任务一个 commit,消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

---

### Task 1: ArticleMarks 抽取 + ArticleListItem 双分支 + 测试

**Files:**
- Create: `web/src/components/ArticleMarks.vue`
- Modify: `web/src/components/ArticleListItem.vue`(全文件重写为下述版本)
- Modify: `web/src/components/__tests__/article-list-item.test.ts`(列表用例改断言 2 行 + 新增 1 用例)

**Interfaces:**
- Consumes:`useAnalysisStore`(`hitsFor`/`rules`,现有)、`ArticleListItem` 类型(`@readly/shared`)。
- Produces:`ArticleMarks` props `{ item: ArticleListItem }`,渲染选择器契约 `[data-hit-dot]`/`[data-rule-id]`/`title=规则名`/`+n`/`★`/`🕘`(Task 2 的 Chrome 断言依赖)。

- [ ] **Step 1: 改测试(先写失败断言)**

`web/src/components/__tests__/article-list-item.test.ts`:

① 「列表布局」用例中这两行:

```ts
    // meta 行(来源·时间)保持
    expect(root.textContent).toContain("示例源");
```

替换为:

```ts
    // 精简:不再渲染源名与时间(只显示标题+状态标记)
    expect(root.textContent).not.toContain("示例源");
    expect(root.textContent).not.toMatch(/刚刚|分钟前|小时前|天前|\d{4}\/\d{1,2}\/\d{1,2}/);
    expect(root.textContent).toContain("待读文章");
```

② 文件末尾(第三个用例后)追加:

```ts
  it("列表布局:命中超过 3 条时渲染 3 个色点 + 「+n」", async () => {
    const pinia = makePinia();
    const analysis = useAnalysisStore();
    const rule = (id: string, color: string) => ({ id, name: id, keyword: "k", isRegex: false, caseSensitive: false, color, enabled: true });
    analysis.rules = [rule("r1", "#ef4444"), rule("r2", "#22c55e"), rule("r3", "#f59e0b"), rule("r4", "#8b5cf6")];
    analysis.hits = { 7: [{ ruleId: "r1", count: 1 }, { ruleId: "r2", count: 1 }, { ruleId: "r3", count: 1 }, { ruleId: "r4", count: 1 }] };
    useSettingsStore().updatePrefs({ articleLayout: "list" });
    const { root } = await mountItem(pinia);

    expect(hitDots(root)).toHaveLength(3);
    expect(root.textContent).toContain("+1");
  });
```

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm -C web exec vitest run src/components/__tests__/article-list-item.test.ts`
Expected: 「列表布局」用例 FAIL(`toContain("示例源")` 反转后仍渲染源名);新用例在旧实现下**通过**(旧 meta 行已有 `+n` 分支——它是迁移护栏,非判别用例,属预期);以反转断言失败为准进入实现。

- [ ] **Step 3: 新建 `web/src/components/ArticleMarks.vue`**

```vue
<script setup lang="ts">
import { computed } from "vue";
import type { ArticleListItem } from "@readly/shared";
import { useAnalysisStore } from "@/stores/analysis";

const props = defineProps<{ item: ArticleListItem }>();
const analysis = useAnalysisStore();
const hitDots = computed(() => analysis.hitsFor(props.item.id).slice(0, 3));
const hitMore = computed(() => Math.max(0, analysis.hitsFor(props.item.id).length - 3));
const FALLBACK_DOT_COLOR = "#94a3b8";

function dotColor(ruleId: string): string {
  return analysis.rules.find((r) => r.id === ruleId)?.color ?? FALLBACK_DOT_COLOR;
}
function dotTitle(ruleId: string): string {
  return analysis.rules.find((r) => r.id === ruleId)?.name ?? ruleId;
}
</script>

<template>
  <!-- 状态标记聚簇:命中色点(≤3)+ 溢出数 + ★ + 🕘;卡片/列表双布局共用(gap-2 与外层一致,卡片逐像素等价) -->
  <span class="flex shrink-0 items-center gap-2 text-xs">
    <span
      v-for="h in hitDots"
      :key="h.ruleId"
      data-hit-dot
      :data-rule-id="h.ruleId"
      :title="dotTitle(h.ruleId)"
      class="h-2 w-2 shrink-0 rounded-full"
      :style="{ background: dotColor(h.ruleId) }"
    />
    <span v-if="hitMore > 0" class="shrink-0 text-[10px] text-neutral-400">+{{ hitMore }}</span>
    <span v-if="item.isStarred" class="shrink-0 text-amber-500">★</span>
    <span v-if="item.isLater" class="shrink-0 text-sky-500">🕘</span>
  </span>
</template>
```

- [ ] **Step 4: 重写 `web/src/components/ArticleListItem.vue`**

整文件替换为:

```vue
<script setup lang="ts">
import { computed } from "vue";
import type { ArticleListItem } from "@readly/shared";
import { useSettingsStore } from "@/stores/settings";
import ArticleMarks from "./ArticleMarks.vue";

const props = defineProps<{ item: ArticleListItem; active: boolean }>();
defineEmits<{ select: [id: number] }>();

const settings = useSettingsStore();
// 布局偏好(卡片/紧凑列表):组件自读 store,切换即时生效,无需父级重载
const layout = computed(() => settings.prefs.articleLayout);

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
</script>

<template>
  <button
    data-article-row
    :data-layout="layout"
    class="flex w-full gap-3 border-b border-neutral-100 px-4 text-left transition-colors dark:border-neutral-800"
    :class="[layout === 'list' ? 'items-center py-1.5' : 'py-3', active ? 'bg-[var(--accent)]/10' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900']"
    @click="$emit('select', item.id)"
  >
    <!-- 列表模式:单行——标题 + 右侧状态标记;不再渲染源名与时间 -->
    <template v-if="layout === 'list'">
      <span v-if="!item.isRead" class="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
      <h3
        class="min-w-0 flex-1 text-sm font-medium line-clamp-1"
        :class="item.isRead ? 'text-neutral-500' : 'text-neutral-900 dark:text-neutral-100'"
      >
        {{ item.title }}
      </h3>
      <ArticleMarks :item="item" />
    </template>

    <!-- 卡片模式:副信息行(源·时间)· 标题两行 · 摘要 · 缩略图(结构不变) -->
    <template v-else>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span v-if="!item.isRead" class="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
          <span class="truncate">{{ item.feedTitle }}</span>
          <span class="shrink-0">·</span>
          <span class="shrink-0">{{ relative(item.publishedAt) }}</span>
          <ArticleMarks :item="item" />
        </div>
        <h3
          class="mt-1 text-sm font-medium line-clamp-2"
          :class="item.isRead ? 'text-neutral-500' : 'text-neutral-900 dark:text-neutral-100'"
        >
          {{ item.title }}
        </h3>
        <p v-if="item.excerpt" class="mt-1 line-clamp-1 text-xs text-neutral-500">{{ item.excerpt }}</p>
      </div>
      <img
        v-if="item.imageUrl"
        :src="item.imageUrl"
        alt=""
        loading="lazy"
        class="h-14 w-14 shrink-0 rounded-lg object-cover"
      />
    </template>
  </button>
</template>
```

- [ ] **Step 5: 运行确认 GREEN(文件 + 全量 web + typecheck)**

Run: `pnpm -C web exec vitest run src/components/__tests__/article-list-item.test.ts`
Expected: 4 passed(3 原 + 1 新)。
Run: `pnpm --filter @readly/web test`
Expected: 267 passed(266 + 1)。若其他文件意外失败:**停下查明(可能是别处测试依赖列表模式渲染源名),如实报告,不擅自放宽断言**。
Run: `pnpm --filter @readly/web typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ArticleMarks.vue web/src/components/ArticleListItem.vue web/src/components/__tests__/article-list-item.test.ts
git commit -m "feat(web): 列表模式精简为纯标题+状态标记;标记聚簇抽为 ArticleMarks

列表行移除源名与时间(未读靠标题颜色,标记右置);卡片模式渲染等价。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Chrome 浅/深实测

**Files:**
- Create(验后删):`/tmp/readly-listmin-verify.mjs`;截图 `/tmp/readly-listmin-{light,dark}.png`。

**Interfaces:**
- Consumes:`web/dist`(`pnpm build` 产物)、样板 `/tmp/readly-final-verify-final.mjs`。
- Produces:实测证据(行高差、文本断言、截图)。

- [ ] **Step 1: 全量验证与构建**

Run: `pnpm -r test` → 期望 worker 143 + web 267 = 410 全绿。
Run: `pnpm -r typecheck` → 0 错误。
Run: `pnpm build` → 成功。

- [ ] **Step 2: Chrome 实测**

参照样板(桩 API `127.0.0.1:5104`,CDP 9538,profile `/tmp/readly-listmin-profile` 先删旧;预置 `localStorage.readly_token`;不碰 5173/8787)。桩数据:1 篇文章(`title:"列表精简验收文章"`,feedTitle:`"示例源"`,isStarred/isLater 均 true,未读;`publishedAt` 取 3 小时前使相对时间为「3 小时前」)。动线:

1. 打开 `/`(默认卡片):记录 `[data-article-row]` 的高度(`getBoundingClientRect().height`)与 `textContent`(含「示例源」)→ 截图 `/tmp/readly-listmin-light.png` 前先切列表:
2. 点工具栏 `[data-layout-toggle]` 切到列表 → 断言:
   - `data-layout` = `list`;
   - `textContent` 含「列表精简验收文章」、含「★」「🕘」;**不含「示例源」**、不匹配 `/刚刚|分钟前|小时前|天前/`;
   - 行高显著小于卡片(断言 `listHeight < cardHeight`,`≈ 单行`);
   - 未读点存在:`row.querySelector('span.bg-\\[var\\(--accent\\)\\]')` 非空(或按 class 过滤,与测试同判据);
   - 命中点场景:桩 analysis 无规则/命中,`[data-hit-dot]` 期望 0(如实记录;命中渲染已由 jsdom 用例覆盖);
   - 截图 `/tmp/readly-listmin-light.png`;
3. 加 `html.dark` → 截图 `/tmp/readly-listmin-dark.png`;
4. 零未捕获异常、零意外 4xx/5xx;验后删脚本。

- [ ] **Step 3: 记录**

实测值(卡片/列表行高、文本断言逐条、截图路径)写入交付汇报;任一断言不符停下报告(不得目视放行)。

---

## Self-Review 记录

- 规格覆盖:§1 列表结构 → T1 Step 4(list 分支);§2 ArticleMarks → T1 Step 3;§3 卡片零变更 → T1 Step 4(card 分支结构与类名逐字保留;聚簇 gap-2/text-xs 等价说明);§4 契约冻结 → Global Constraints + 测试保留断言;§5 测试 → Step 1 反转 + 新用例;§6 验收 → T1 Step 5 + T2(截图/DOM/行高)。
- 占位符扫描:无 TBD/TODO;全部代码逐字给出。
- 一致性:`ArticleMarks` 的 props/选择器在 T1 Step 3、Step 4 两处引用一致;测试判据(未读点 class)与实现一致;计数 267 = 266+1,合计 410。
