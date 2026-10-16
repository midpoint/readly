# Readly 正文默认排版升级(中文书籍派)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中文文章正文升级为「中文书籍派」版式(首行缩进 2 字、段距 0.8em、两端对齐、标点挤压、字距 +0.01em),西文文章保持现状;通用改进(引用块竖线/列表项距/图片居中)不分语言;行距默认 1.7→1.85。

**Architecture:** 纯前端展示层改动。语言判定在渲染侧(复用既有 `detectTextLang`,与 `html` computed 同源);判定结果以 `reader-zh` class 落在 `.reader-body` 上,全部版式差异由 scoped CSS 承载(与 5 套阅读主题正交,不新增偏好字段、不新增控件)。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- 设计文档:`docs/superpowers/specs/2026-10-16-reader-typography-design.md`(已评审)。一切行为以该文档为准。
- 无 `any`;strict;不新增文字颜色(引用竖线为装饰色 `color-mix(in srgb, currentColor 30%, transparent)`,对比度零回归)。
- **仅中文**:缩进/两端对齐/标点挤压/字距只随 `reader-zh` 类生效;西文文章的排版必须与升级前逐位一致(不得出现缩进、两端对齐、字距)。
- 判定契约:`.reader-body` 上的 `reader-zh` class;判定源必须与 `html` computed 同源(`useFull.value && a.contentFull ? a.contentFull : (a.content ?? "")`),摘要/全文切换、抓取全文后 reactive 重判。
- 数值:`DEFAULT_READER_PREFS.lineHeight` 1.7 → 1.85(sanitize 区间 1.4–2.2 已覆盖,`web/src/stores/settings.ts:12` 不动);字号 17px、宽度 720px、字体族、四个滑块均不动。
- 样式只增不改:现有 `.reader-body` 基样式、`img` 的 max-width/圆角、`a` 颜色不动;行内图片(段落中的表情等)不得被 `display:block` 破坏——只对「纯图片段/图容器」做 block+居中。
- 视觉验收必须实测(纪律 1):headless Chrome 浅/深截图 + computed style 实测,参照 `/tmp/readly-final-verify-final.mjs` 的「桩 API + CDP 直连」模式;不触碰用户 `pnpm dev`(5173/8787)。
- 每任务一个 commit,消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

---

### Task 1: 实现(shared 默认值 + ReaderPane 判定/CSS)+ 契约测试

**Files:**
- Modify: `shared/src/index.ts:164`(`DEFAULT_READER_PREFS.lineHeight`)
- Modify: `web/src/components/ReaderPane.vue`(脚本:`html` computed 之后;模板:242 行 article 元素;样式块:253 行起的 scoped style)
- Test: `web/src/components/__tests__/reader-typography.test.ts`(新建)

**Interfaces:**
- Consumes:`detectTextLang`、`aiTextOf`(`@/modules/ai`,ReaderPane 第 6 行已 import,直接用)、`useFull`/`html`(本文件内既有)。
- Produces:`.reader-body.reader-zh` 的 class 契约与 CSS 规则集(Task 2 依赖其对 `.reader-body`、`p`、`blockquote`、`li`、纯图片段、`pre`、`figcaption` 的最终样式)。

- [ ] **Step 1: 写失败测试**

新建 `web/src/components/__tests__/reader-typography.test.ts`:

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

async function mountWith(article: Record<string, unknown>): Promise<HTMLElement> {
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/articles/1") return Promise.resolve({ ...BASE, ...article });
    return Promise.resolve({});
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.initLocal();
  settings.updateFetchPrefs({ auto: false });
  app = createApp(ReaderPane);
  app.use(pinia);
  setActivePinia(pinia);
  app.mount(host!);
  await useReaderStore().open(1);
  await nextTick();
  return host!;
}

function bodyOf(el: HTMLElement): HTMLElement {
  const body = el.querySelector<HTMLElement>(".reader-body");
  expect(body).not.toBeNull();
  return body!;
}

describe("ReaderPane 中文版式判定", () => {
  it("中文文章:reader-body 带 reader-zh", async () => {
    const el = await mountWith({});
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(true);
  });

  it("英文文章:不带 reader-zh", async () => {
    const el = await mountWith({
      title: "Hello",
      content: "<p>This is an English article about RSS readers and typography.</p>",
      excerpt: "English excerpt",
    });
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(false);
  });

  it("无文本内容:不带 reader-zh", async () => {
    const el = await mountWith({ title: "123", content: null, contentFull: null, excerpt: null });
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(false);
  });

  it("有全文时默认显示全文并按其判定;切回摘要后重判", async () => {
    const el = await mountWith({
      content: "<p>中文摘要正文</p>",
      contentFull: "<p>This full text is written entirely in English.</p>",
      hasFullText: true,
    });
    // 默认显示全文(英文)→ 不带类
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(false);
    // 切回摘要(中文)→ 重判为中文
    el.querySelector<HTMLButtonElement>("[data-toggle-original]")!.click();
    await nextTick();
    expect(bodyOf(el).classList.contains("reader-zh")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C web exec vitest run src/components/__tests__/reader-typography.test.ts`
Expected: 用例 1 与 4(后半)FAIL(不带 `reader-zh`);用例 2/3/4(前半)可能已通过(类不存在恰与期望一致)——以用例 1 的失败为准进入实现。

- [ ] **Step 3: 实现**

**3a.** `shared/src/index.ts` 第 164 行:

```ts
  lineHeight: 1.85,
```

**3b.** `web/src/components/ReaderPane.vue` 脚本区,紧接 `html` computed(第 77-81 行)之后:

```ts
// 中文版式判定:与 html 同源的渲染内容,复用 AI 模块的 detectTextLang(与入库侧同算法);
// 摘要/全文切换或抓取全文后随之重判
const isZh = computed(() => {
  const a = reader.article;
  if (!a) return false;
  const source = useFull.value && a.contentFull ? a.contentFull : (a.content ?? "");
  return detectTextLang(aiTextOf(source)) === "zh";
});
```

**3c.** 模板第 242 行改为:

```html
          <article ref="articleBody" class="reader-body mx-auto w-full px-6 py-6" :class="{ 'reader-zh': isZh }" v-html="html" />
```

**3d.** scoped `<style>` 块(第 253 行起)在现有规则之后追加:

```css
/* —— 中文书籍派版式(reader-zh;西文不加此类,保持现状) —— */
.reader-body.reader-zh {
  text-align: justify;
  text-spacing-trim: space-first; /* 标点挤压;旧浏览器忽略该属性,无副作用 */
  letter-spacing: 0.01em;
}
.reader-body.reader-zh :deep(p) {
  text-indent: 2em;
  margin: 0.8em 0;
}
/* 非段落例外:不首行缩进 */
.reader-body.reader-zh :deep(blockquote p),
.reader-body.reader-zh :deep(li p),
.reader-body.reader-zh :deep(pre),
.reader-body.reader-zh :deep(figcaption) {
  text-indent: 0;
}
.reader-body.reader-zh :deep(p:has(> img:only-child)) {
  text-indent: 0;
}
/* —— 语言无关的通用版式改进 —— */
.reader-body :deep(blockquote) {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent);
}
.reader-body :deep(ul),
.reader-body :deep(ol) {
  padding-left: 1.8em;
}
.reader-body :deep(li) {
  margin: 0.35em 0;
}
/* 独立图片居中留白;行内图片(段落中的表情等)不受影响 */
.reader-body :deep(p > img:only-child),
.reader-body :deep(figure img) {
  display: block;
  margin: 1em auto;
}
```

- [ ] **Step 4: 运行确认通过(文件 + 全量 web)**

Run: `pnpm -C web exec vitest run src/components/__tests__/reader-typography.test.ts`
Expected: 4 passed。
Run: `pnpm --filter @readly/web test`
Expected: 264 passed(260 + 4)。若与预期不符须查明原因而非改数字。
Run: `pnpm --filter @readly/web typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add shared/src/index.ts web/src/components/ReaderPane.vue web/src/components/__tests__/reader-typography.test.ts
git commit -m "feat(web): 正文默认排版升级(中文书籍派:首行缩进/两端对齐/标点挤压)

仅中文文章生效(渲染侧 detectTextLang 判定,reader-zh 类);西文保持现状;
通用改进:引用块竖线、列表项距、独立图片居中;行距默认 1.7→1.85。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 全量验证 + Chrome 浅/深排版实测

**Files:**
- Create(验后删):`/tmp/readly-typography-verify.mjs`;截图存 `/tmp/readly-typography-*.png`。

**Interfaces:**
- Consumes:`web/dist`(`pnpm build` 产物)、headless Chrome(`/usr/bin/google-chrome`)、样板 `/tmp/readly-final-verify-final.mjs`(桩 API + CDP 直连,不依赖 Playwright 包)。
- Produces:验证报告(实测的 computed style 值、截图路径、测试计数)。

- [ ] **Step 1: 全量测试与构建**

Run: `pnpm -r test`
Expected: worker 143 + web 264 全绿。
Run: `pnpm -r typecheck`
Expected: 无错误。
Run: `pnpm build`
Expected: `vue-tsc --noEmit && vite build` 成功。

- [ ] **Step 2: Chrome 浅/深实测**

参照 `/tmp/readly-final-verify-final.mjs` 搭建一次性脚本:
- 桩 API(`127.0.0.1:5102`,独立端口;不触碰用户 5173/8787)+ 静态服务 `web/dist`;CDP 端口 9536,profile `/tmp/readly-typography-chrome-profile`;预置 `localStorage.readly_token`。
- 桩数据:文章列表 2 篇——**中文文章(id 1)**:标题 + 正文含 `<p>`×2、`<blockquote><p>`、`<ul><li>`×2、`<p><img src="http://127.0.0.1:5102/img.png"></p>`(桩服务提供 1×1 PNG);**英文文章(id 2)**:全英文 `<p>`×2。`/api/articles/:id` 按 id 返回详情;其余端点(settings/categories/feeds/stats 等)按样板最小实现。
- 动线(浅色):
  1. 打开 `/` → 点开中文文章 → 断言 `.reader-body` classList 含 `reader-zh`;
  2. **computed style 实测**(CDP `Runtime.evaluate`,逐项断言并记录):
     - `.reader-body`:`lineHeight = 31.45px`(1.85×17)、`letterSpacing = 0.17px`(0.01em×17)、`textAlign = justify`;
     - 首个 `p`:`textIndent = 34px`(2em×17)、`marginTop = 13.6px`(0.8em×17);
     - `blockquote`:`borderLeftWidth = 3px`;
     - `li` 内 `p`(若有)与 `<p><img>` 段:`textIndent = 0px`;
     - 截图 `/tmp/readly-typography-light.png`;
  3. 切深色(`html.dark` 类策略)→ 截图 `/tmp/readly-typography-dark.png`,重测 `p` 的 `textIndent` 仍 34px;
  4. 点开英文文章 → 断言 classList **不含** `reader-zh`、首个 `p` `textIndent = 0px` 且 `textAlign ≠ justify` → 截图 `/tmp/readly-typography-en.png`;
  5. 零未捕获异常、零意外 4xx/5xx;验后删除脚本。

- [ ] **Step 3: 记录**

将实测值(六项 computed 值 + 类存在性 + 截图路径)写入交付汇报;任一断言不符即停下报告(不得目视放行)。

---

## Self-Review 记录

- 规格覆盖:§1 版式规则 → T1 3d(CSS 全量);§1 数值 → T1 3a;§2 语言判定 → T1 3b(与 html 同源)+ 测试用例 4(切换重判);§3 已存实例 → 交付说明(行距滑块一次);§5 限制(`<br>` 无缩进/标点挤压渐进//`:has` 现代 Chrome)→ 体现在实现里不加兜底 hack;§6 验收 → T1 用例 ×4 + T2 computed 实测。
- 占位符扫描:无 TBD/TODO;所有步骤含完整代码与命令。
- 类型一致性:`reader-zh` 类名在 3c/3d、测试、T2 动线三处一致;`isZh` 命名一致;判定源表达式与 `html` computed(第 80 行)逐字符同构。
- 计数核对:web 260+4=264;worker 143 不变。以实际运行为准,不符须查明原因。
