# Readly 阅读体验与 PWA(计划 02 / M2)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付阅读体验定制(深浅主题 + 强调色 + 5 套阅读主题 + 字号/行距/宽度/字体)、偏好本地即时生效并同步 D1、自动已读策略接线、PWA(可安装 + 离线壳 + 图标),顺带清掉台账中 fix-soon 的侧栏计数刷新与死代码。

**Architecture:** 纯前端改动(worker 的 `/api/settings` 已就绪,零后端改动)。新模块 `web/src/modules/theme.ts`(纯函数 + DOM 应用)与 `web/src/styles/themes.css`(阅读主题 CSS 变量);新增 `web/src/stores/settings.ts` 持有 `ReaderPrefs`(shared 已冻结),localStorage 即时 + D1 防抖同步,localStorage 优先;Tailwind 的 `dark:` 从媒体策略切换为 **class 策略**(`html.dark`),由 `applyTheme` 与 index.html 的预绘制脚本共同维护,防主题闪烁;PWA 用 `vite-plugin-pwa` + `sharp` 生成图标。

**Tech Stack:** Vue 3.5 / Pinia 3 / Tailwind CSS 4(`@custom-variant dark`)/ vite-plugin-pwa / sharp(仅图标生成)/ Vitest + jsdom。

## Global Constraints

- `ReaderPrefs` / `ReadingTheme` / `ThemeMode` / `DEFAULT_READER_PREFS` / `SETTING_KEYS` 是 `@readly/shared` 冻结类型,不得改动;阅读主题为 **5 套**:classic / sepia / paper / night / contrast。
- localStorage 键 `readly_prefs`;D1 设置键 `SETTING_KEYS.readerPrefs`(`"reader_prefs"`),经既有 `GET/PUT /api/settings`(无后端改动)。
- 偏好即时性:改动先写 localStorage + 立即 `applyTheme`,D1 写入防抖 1000ms;读取顺序 localStorage → D1;**localStorage 优先**(两处都有时以本地为准);D1 写失败静默(下次变更重试)。
- 滑块范围(默认值即 `DEFAULT_READER_PREFS`):字号 14–24 step 1;行距 1.4–2.2 step 0.1;正文宽度 560–900 step 20;任何来源(localStorage/D1)的偏好必须经 `sanitizePrefs` 逐字段校验与钳制后才可用。
- 5 套阅读主题:**颜色一律走 CSS 变量**(`--reader-bg/--reader-text/--reader-link`),paper 主题卡点击时**附带** `fontFamily:"serif"`(其余主题卡附带 `"system"`),即「主题=颜色+字体的预设组合」,之后用户仍可用字体族偏好覆盖。
- 深色模式由 `html.dark` class 驱动(切换掉 Tailwind 默认媒体查询策略);无 Web 字体下载(只用系统字体栈,衬线用 `"Noto Serif SC","Songti SC","SimSun",Georgia,serif`)。
- 不改动既有行为:IPC/URL 联动、pendingReset 排队、loaded 冷启动守卫、DOMPurify 渲染门、SSRF 等一律不回归;`web/src/api/types.ts` 本计划内删除(台账确认零引用)。
- TypeScript strict;禁止 any;UI 文案中文;所有提交信息结尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;测试与实现同任务交付;每任务提交前 `pnpm --filter @readly/web test` 全绿 + `pnpm --filter @readly/web typecheck` 通过。

---

### Task 1: 主题核心(theme 模块 + Tailwind class 策略 + 阅读主题 CSS)

**Files:**
- Create: `web/src/modules/theme.ts`
- Create: `web/src/styles/themes.css`
- Modify: `web/src/styles/main.css`(顶部引入 themes.css + dark 变体切换)
- Create: `web/src/modules/__tests__/theme.test.ts`

**Interfaces:**
- Consumes: `@readly/shared` 的 `ReaderPrefs/ReadingTheme/ThemeMode/DEFAULT_READER_PREFS`
- Produces(后续任务依赖,签名冻结):
  - `const READING_THEMES: { id: ReadingTheme; label: string }[]`(5 套,顺序 classic/sepia/paper/night/contrast)
  - `const ACCENT_PRESETS: { name: string; value: string }[]`(12 色)
  - `const FONT_STACKS: Record<ReaderPrefs["fontFamily"], string>`
  - `isReadingTheme(v: unknown): v is ReadingTheme`、`isHexColor(v: unknown): v is string`
  - `resolveDark(mode: ThemeMode, prefersDark: boolean): boolean`
  - `applyTheme(prefs: ReaderPrefs): void`(设置 `html.dark`、`data-reading-theme`、`--accent`、`--reader-font-size`、`--reader-line-height`、`--reader-width`、`--reader-font-family`)
  - `watchSystemTheme(onChange: () => void): () => void`(返回 dispose)

- [ ] **Step 1: 写失败测试**

`web/src/modules/__tests__/theme.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READER_PREFS } from "@readly/shared";
import {
  ACCENT_PRESETS,
  FONT_STACKS,
  isHexColor,
  isReadingTheme,
  READING_THEMES,
  resolveDark,
  applyTheme,
  watchSystemTheme,
} from "@/modules/theme";

beforeEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-reading-theme");
  document.documentElement.removeAttribute("style");
});

describe("常量", () => {
  it("5 套阅读主题,顺序与 id 固定", () => {
    expect(READING_THEMES.map((t) => t.id)).toEqual(["classic", "sepia", "paper", "night", "contrast"]);
    expect(READING_THEMES.every((t) => t.label.length > 0)).toBe(true);
  });
  it("12 个强调色预设,均为合法 hex", () => {
    expect(ACCENT_PRESETS).toHaveLength(12);
    expect(ACCENT_PRESETS.every((p) => isHexColor(p.value))).toBe(true);
  });
  it("字体栈为系统栈且含中文字体回退", () => {
    expect(FONT_STACKS.system).toContain("PingFang SC");
    expect(FONT_STACKS.serif).toContain("Noto Serif SC");
    expect(FONT_STACKS.serif).toContain("Georgia");
  });
});

describe("校验函数", () => {
  it("isReadingTheme", () => {
    expect(isReadingTheme("sepia")).toBe(true);
    expect(isReadingTheme("bogus")).toBe(false);
    expect(isReadingTheme(3)).toBe(false);
  });
  it("isHexColor 仅接受 6 位 hex", () => {
    expect(isHexColor("#3b82f6")).toBe(true);
    expect(isHexColor("#fff")).toBe(false);
    expect(isHexColor("red")).toBe(false);
  });
});

describe("resolveDark", () => {
  it("三态矩阵", () => {
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });
});

describe("applyTheme", () => {
  it("dark 模式加 html.dark,light 模式移除", () => {
    applyTheme({ ...DEFAULT_READER_PREFS, themeMode: "dark" });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme({ ...DEFAULT_READER_PREFS, themeMode: "light" });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("设置 data-reading-theme 与全部 CSS 变量", () => {
    applyTheme({
      ...DEFAULT_READER_PREFS,
      readingTheme: "night",
      accent: "#22c55e",
      fontSize: 19,
      lineHeight: 1.9,
      contentWidth: 640,
      fontFamily: "serif",
    });
    const el = document.documentElement;
    expect(el.dataset.readingTheme).toBe("night");
    expect(el.style.getPropertyValue("--accent")).toBe("#22c55e");
    expect(el.style.getPropertyValue("--reader-font-size")).toBe("19px");
    expect(el.style.getPropertyValue("--reader-line-height")).toBe("1.9");
    expect(el.style.getPropertyValue("--reader-width")).toBe("640px");
    expect(el.style.getPropertyValue("--reader-font-family")).toBe(FONT_STACKS.serif);
  });
});

describe("watchSystemTheme", () => {
  it("注册监听并在 dispose 后移除", () => {
    const listeners: (() => void)[] = [];
    const mql = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: (_: string, cb: () => void) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const spy = vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);
    const cb = vi.fn();
    const dispose = watchSystemTheme(cb);
    expect(listeners).toHaveLength(1);
    listeners[0]!();
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
    expect(listeners).toHaveLength(0);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/web test src/modules/__tests__/theme.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 theme.ts / themes.css / main.css**

`web/src/modules/theme.ts`:

```ts
import type { ReaderPrefs, ReadingTheme, ThemeMode } from "@readly/shared";

export const READING_THEMES: { id: ReadingTheme; label: string }[] = [
  { id: "classic", label: "经典" },
  { id: "sepia", label: "护眼米黄" },
  { id: "paper", label: "羊皮纸" },
  { id: "night", label: "夜间" },
  { id: "contrast", label: "高对比" },
];

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: "蓝", value: "#3b82f6" },
  { name: "靛", value: "#6366f1" },
  { name: "紫", value: "#8b5cf6" },
  { name: "玫红", value: "#ec4899" },
  { name: "红", value: "#ef4444" },
  { name: "橙", value: "#f97316" },
  { name: "琥珀", value: "#f59e0b" },
  { name: "黄绿", value: "#84cc16" },
  { name: "绿", value: "#22c55e" },
  { name: "青", value: "#14b8a6" },
  { name: "天蓝", value: "#0ea5e9" },
  { name: "石板", value: "#64748b" },
];

export const FONT_STACKS: Record<ReaderPrefs["fontFamily"], string> = {
  system:
    'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif SC", "Songti SC", "SimSun", Georgia, "Times New Roman", serif',
};

export function isReadingTheme(v: unknown): v is ReadingTheme {
  return typeof v === "string" && READING_THEMES.some((t) => t.id === v);
}

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

export function resolveDark(mode: ThemeMode, prefersDark: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return prefersDark;
}

function prefersDarkNow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(prefs: ReaderPrefs): void {
  const el = document.documentElement;
  el.classList.toggle("dark", resolveDark(prefs.themeMode, prefersDarkNow()));
  el.dataset.readingTheme = prefs.readingTheme;
  el.style.setProperty("--accent", prefs.accent);
  el.style.setProperty("--reader-font-size", `${prefs.fontSize}px`);
  el.style.setProperty("--reader-line-height", String(prefs.lineHeight));
  el.style.setProperty("--reader-width", `${prefs.contentWidth}px`);
  el.style.setProperty("--reader-font-family", FONT_STACKS[prefs.fontFamily]);
}

export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
```

`web/src/styles/themes.css`:

```css
/* 阅读主题:颜色只走变量,切换 html[data-reading-theme] 即整体换肤 */
:root {
  --reader-bg: #ffffff;
  --reader-text: #1f2328;
  --reader-link: var(--accent);
}

.dark {
  --reader-bg: #1a1a1a;
  --reader-text: #d4d4d4;
}

:root[data-reading-theme="classic"] {
  --reader-bg: #ffffff;
  --reader-text: #1f2328;
}
.dark[data-reading-theme="classic"] {
  --reader-bg: #1a1a1a;
  --reader-text: #d4d4d4;
}

:root[data-reading-theme="sepia"] {
  --reader-bg: #f5f0e1;
  --reader-text: #3b3529;
  --reader-link: #8a6d1f;
}

:root[data-reading-theme="paper"] {
  --reader-bg: #faf7f0;
  --reader-text: #2b2b2b;
  --reader-link: #7c5c2e;
}

:root[data-reading-theme="night"] {
  --reader-bg: #121212;
  --reader-text: #c8c8c8;
  --reader-link: #7cb3ff;
}

:root[data-reading-theme="contrast"] {
  --reader-bg: #ffffff;
  --reader-text: #000000;
  --reader-link: #0000ee;
}
```

`web/src/styles/main.css` 顶部改为:

```css
@import "tailwindcss";
@import "./themes.css";

/* dark: 变体改由 html.dark class 驱动(不再跟随媒体查询),切换自 applyTheme / index.html 预绘制脚本 */
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", sans-serif;
}

:root {
  --accent: #3b82f6;
}

html,
body,
#app {
  height: 100%;
}

body {
  margin: 0;
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @readly/web test src/modules/__tests__/theme.test.ts`
Expected: 全过(8 个用例)

Run: `pnpm --filter @readly/web test`
Expected: 既有套件全绿(39 + 8);jsdom 下 `dark:` 类行为不受影响(测试不校验 CSS)

- [ ] **Step 5: 提交**

```bash
git add web/src/modules/theme.ts web/src/styles web/src/modules/__tests__/theme.test.ts
git commit -m "feat(web): 主题核心模块(5 阅读主题/强调色/class 策略 dark)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 偏好 store(settings)+ 预绘制脚本 + main 接线

**Files:**
- Create: `web/src/stores/settings.ts`
- Modify: `web/src/main.ts`
- Modify: `web/index.html`(预绘制 script,Task 6 还会再动此文件)
- Create: `web/src/stores/__tests__/settings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `applyTheme/watchSystemTheme/isHexColor/isReadingTheme`;`api` 客户端;`SETTING_KEYS/DEFAULT_READER_PREFS`
- Produces(冻结):
  - `useSettingsStore`:`{ prefs: Ref<ReaderPrefs>; ready: Ref<boolean>; initLocal(): void; initRemote(): Promise<void>; initSystemWatch(): void; updatePrefs(patch: Partial<ReaderPrefs>): void; resetPrefs(): void; flushPrefs(): Promise<void> }`
  - `sanitizePrefs(raw: unknown): ReaderPrefs`(导出,供测试与其他模块复用)

- [ ] **Step 1: 写失败测试**

`web/src/stores/__tests__/settings.test.ts`:

```ts
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READER_PREFS } from "@readly/shared";
import { api } from "@/api/client";
import { sanitizePrefs, useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const LS_KEY = "readly_prefs";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.useFakeTimers();
  document.documentElement.className = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizePrefs", () => {
  it("非法字段回退默认,数值钳制到范围内", () => {
    const p = sanitizePrefs({
      themeMode: "bogus",
      accent: "red",
      readingTheme: "nope",
      fontSize: 999,
      lineHeight: 0.1,
      contentWidth: -5,
      fontFamily: "comic",
      autoMarkReadOnOpen: "yes",
    });
    expect(p.themeMode).toBe(DEFAULT_READER_PREFS.themeMode);
    expect(p.accent).toBe(DEFAULT_READER_PREFS.accent);
    expect(p.readingTheme).toBe("classic");
    expect(p.fontSize).toBe(24);
    expect(p.lineHeight).toBe(1.4);
    expect(p.contentWidth).toBe(560);
    expect(p.fontFamily).toBe("system");
    expect(p.autoMarkReadOnOpen).toBe(true);
  });
  it("非对象输入返回完整默认值", () => {
    expect(sanitizePrefs("junk")).toEqual(DEFAULT_READER_PREFS);
    expect(sanitizePrefs(null)).toEqual(DEFAULT_READER_PREFS);
  });
  it("保留合法自定义值", () => {
    const p = sanitizePrefs({ accent: "#22c55e", readingTheme: "night", fontSize: 19, autoMarkReadOnScroll: false });
    expect(p.accent).toBe("#22c55e");
    expect(p.readingTheme).toBe("night");
    expect(p.fontSize).toBe(19);
    expect(p.autoMarkReadOnScroll).toBe(false);
  });
});

describe("settings store", () => {
  it("initLocal 读 localStorage 并应用主题,写入即时、D1 防抖一次", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_READER_PREFS, themeMode: "dark" }));
    vi.mocked(api).mockResolvedValue({ ok: true });
    const store = useSettingsStore();
    store.initLocal();
    expect(store.prefs.themeMode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    store.updatePrefs({ fontSize: 20 });
    expect(JSON.parse(localStorage.getItem(LS_KEY)!).fontSize).toBe(20);
    store.updatePrefs({ fontSize: 21 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(api).mock.calls[0]!;
    expect(call[0]).toBe("/api/settings");
    expect((call[1]!.body as { kv: { reader_prefs: { fontSize: number } } }).kv.reader_prefs.fontSize).toBe(21);
  });

  it("initRemote:本地无偏好时采用服务端值", async () => {
    vi.mocked(api).mockResolvedValue({ reader_prefs: { ...DEFAULT_READER_PREFS, readingTheme: "sepia" } });
    const store = useSettingsStore();
    store.initLocal();
    await store.initRemote();
    expect(store.prefs.readingTheme).toBe("sepia");
    expect(document.documentElement.dataset.readingTheme).toBe("sepia");
  });

  it("initRemote:本地已有偏好时本地优先,不回写", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_READER_PREFS, readingTheme: "night" }));
    vi.mocked(api).mockResolvedValue({ reader_prefs: { ...DEFAULT_READER_PREFS, readingTheme: "sepia" } });
    const store = useSettingsStore();
    store.initLocal();
    await store.initRemote();
    expect(store.prefs.readingTheme).toBe("night");
    await vi.advanceTimersByTimeAsync(1100);
    expect(vi.mocked(api)).not.toHaveBeenCalled();
  });

  it("重复推送相同值被抑制(serverCopy 去重)", async () => {
    vi.mocked(api).mockResolvedValue({ ok: true });
    const store = useSettingsStore();
    store.initLocal();
    store.updatePrefs({ accent: "#ef4444" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    // 把同一值再推一次:PUT 后 serverCopy 一致 → 触发 watch 但 pushRemote 直接返回
    store.updatePrefs({ accent: "#ef4444" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });

  it("PUT 失败静默、localStorage 保留", async () => {
    vi.mocked(api).mockRejectedValue(new Error("boom"));
    const store = useSettingsStore();
    store.initLocal();
    store.updatePrefs({ fontSize: 23 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(localStorage.getItem(LS_KEY)!).fontSize).toBe(23);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/web test src/stores/__tests__/settings.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 settings store / main.ts / index.html**

`web/src/stores/settings.ts`:

```ts
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { DEFAULT_READER_PREFS, SETTING_KEYS, type ReaderPrefs } from "@readly/shared";
import { api } from "@/api/client";
import { applyTheme, isHexColor, isReadingTheme, watchSystemTheme } from "@/modules/theme";

const LS_KEY = "readly_prefs";
const PUT_DEBOUNCE_MS = 1000;
const NUM_RANGES = {
  fontSize: [14, 24],
  lineHeight: [1.4, 2.2],
  contentWidth: [560, 900],
} as const;

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function sanitizePrefs(raw: unknown): ReaderPrefs {
  const d = DEFAULT_READER_PREFS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    themeMode:
      o.themeMode === "light" || o.themeMode === "dark" || o.themeMode === "system" ? o.themeMode : d.themeMode,
    accent: isHexColor(o.accent) ? o.accent : d.accent,
    readingTheme: isReadingTheme(o.readingTheme) ? o.readingTheme : d.readingTheme,
    fontSize: clampNumber(o.fontSize, NUM_RANGES.fontSize[0], NUM_RANGES.fontSize[1], d.fontSize),
    lineHeight: clampNumber(o.lineHeight, NUM_RANGES.lineHeight[0], NUM_RANGES.lineHeight[1], d.lineHeight),
    contentWidth: clampNumber(o.contentWidth, NUM_RANGES.contentWidth[0], NUM_RANGES.contentWidth[1], d.contentWidth),
    fontFamily: o.fontFamily === "serif" ? "serif" : "system",
    autoMarkReadOnOpen: o.autoMarkReadOnOpen !== false,
    autoMarkReadOnScroll: o.autoMarkReadOnScroll !== false,
  };
}

function readLocal(): ReaderPrefs | null {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try {
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const prefs = ref<ReaderPrefs>({ ...DEFAULT_READER_PREFS });
  const ready = ref(false);
  let serverCopy: string | null = null;
  let putTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeSystem: (() => void) | null = null;

  function apply(): void {
    applyTheme(prefs.value);
  }

  function initLocal(): void {
    const local = readLocal();
    if (local) prefs.value = local;
    apply();
    ready.value = true;
  }

  async function initRemote(): Promise<void> {
    const all = await api<Record<string, unknown>>("/api/settings");
    const serverPrefs = all[SETTING_KEYS.readerPrefs];
    if (serverPrefs === undefined) return;
    serverCopy = JSON.stringify(sanitizePrefs(serverPrefs));
    if (readLocal() === null) {
      prefs.value = sanitizePrefs(serverPrefs);
      apply();
    }
  }

  function initSystemWatch(): void {
    disposeSystem?.();
    disposeSystem = watchSystemTheme(() => {
      if (prefs.value.themeMode === "system") apply();
    });
  }

  function updatePrefs(patch: Partial<ReaderPrefs>): void {
    prefs.value = sanitizePrefs({ ...prefs.value, ...patch });
  }

  function resetPrefs(): void {
    prefs.value = { ...DEFAULT_READER_PREFS };
  }

  async function pushRemote(): Promise<void> {
    const serialized = JSON.stringify(prefs.value);
    if (serialized === serverCopy) return;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: { kv: { [SETTING_KEYS.readerPrefs]: prefs.value } },
      });
      serverCopy = serialized;
    } catch {
      // 静默:本地为真源,下次变更再试
    }
  }

  async function flushPrefs(): Promise<void> {
    if (putTimer) {
      clearTimeout(putTimer);
      putTimer = null;
    }
    await pushRemote();
  }

  watch(
    prefs,
    () => {
      localStorage.setItem(LS_KEY, JSON.stringify(prefs.value));
      apply();
      if (putTimer) clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        void pushRemote();
      }, PUT_DEBOUNCE_MS);
    },
    { deep: true }
  );

  return { prefs, ready, initLocal, initRemote, initSystemWatch, updatePrefs, resetPrefs, flushPrefs };
});
```

`web/src/main.ts` 改为:

```ts
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useSettingsStore } from "./stores/settings";
import "./styles/main.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);

// 本地偏好先应用(防闪烁),服务端偏好后台合并
const settings = useSettingsStore();
settings.initLocal();
settings.initSystemWatch();
void settings.initRemote().catch(() => undefined);

window.addEventListener("readly:unauthorized", () => {
  void router.push("/login");
});

app.mount("#app");
```

`web/index.html` 的 `<head>` 内追加预绘制脚本(在样式/模块之前,防主题闪烁):

```html
    <script>
      (function () {
        try {
          var raw = localStorage.getItem("readly_prefs");
          var p = raw ? JSON.parse(raw) : {};
          var mode = p.themeMode === "dark" || p.themeMode === "light" ? p.themeMode : "system";
          var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
          document.documentElement.classList.toggle("dark", dark);
          var themes = ["classic", "sepia", "paper", "night", "contrast"];
          document.documentElement.dataset.readingTheme =
            themes.indexOf(p.readingTheme) >= 0 ? p.readingTheme : "classic";
          if (typeof p.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(p.accent)) {
            document.documentElement.style.setProperty("--accent", p.accent);
          }
        } catch (e) {}
      })();
    </script>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @readly/web test src/stores/__tests__/settings.test.ts`
Expected: 全过(8 个用例)

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/stores/settings.ts web/src/stores/__tests__/settings.test.ts web/src/main.ts web/index.html
git commit -m "feat(web): ReaderPrefs 偏好 store(localStorage 即时 + D1 防抖同步)与预绘制脚本

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 主题面板(ThemePanel)+ ReaderPane 集成

**Files:**
- Create: `web/src/components/ThemePanel.vue`
- Modify: `web/src/components/ReaderPane.vue`(工具栏加「Aa」按钮 + 面板挂载 + reader-body 消费主题变量)
- Create: `web/src/components/__tests__/theme-panel.test.ts`

**Interfaces:**
- Consumes: `useSettingsStore`(Task 2)、`READING_THEMES/ACCENT_PRESETS`(Task 1)、`DEFAULT_READER_PREFS`
- Produces: `ThemePanel.vue`(`defineEmits<{ close: [] }>()`;内部直接读写 settings store,无 props)

- [ ] **Step 1: 写失败测试**

`web/src/components/__tests__/theme-panel.test.ts`:

```ts
// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { DEFAULT_READER_PREFS } from "@readly/shared";
import ThemePanel from "@/components/ThemePanel.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn().mockResolvedValue({}) };
});

let app: App | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-reading-theme");
  document.documentElement.removeAttribute("style");
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

async function mountPanel() {
  app = createApp(ThemePanel);
  app.mount(host!);
  await nextTick();
}

describe("ThemePanel", () => {
  it("点击阅读主题卡:更新 readingTheme 与 html 属性;paper 附带衬线", async () => {
    await mountPanel();
    const cards = host!.querySelectorAll<HTMLButtonElement>("[data-theme-card]");
    expect(cards).toHaveLength(5);
    const paper = Array.from(cards).find((c) => c.dataset.themeCard === "paper")!;
    paper.click();
    await nextTick();
    expect(document.documentElement.dataset.readingTheme).toBe("paper");
    const night = Array.from(cards).find((c) => c.dataset.themeCard === "night")!;
    night.click();
    await nextTick();
    expect(document.documentElement.dataset.readingTheme).toBe("night");
    expect(document.documentElement.style.getPropertyValue("--reader-font-family")).toContain("Georgia");
  });

  it("点击强调色预设:更新 --accent", async () => {
    await mountPanel();
    const swatch = host!.querySelector<HTMLButtonElement>('[data-accent="#22c55e"]')!;
    swatch.click();
    await nextTick();
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#22c55e");
  });

  it("字号滑块 input 事件更新偏好与 CSS 变量", async () => {
    await mountPanel();
    const slider = host!.querySelector<HTMLInputElement>('[data-pref="fontSize"]')!;
    slider.value = "21";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(document.documentElement.style.getPropertyValue("--reader-font-size")).toBe("21px");
  });

  it("外观模式三态切换 dark 类;恢复默认还原", async () => {
    await mountPanel();
    const darkBtn = host!.querySelector<HTMLButtonElement>('[data-mode="dark"]')!;
    darkBtn.click();
    await nextTick();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const reset = host!.querySelector<HTMLButtonElement>("[data-reset]")!;
    reset.click();
    await nextTick();
    expect(document.documentElement.style.getPropertyValue("--reader-font-size")).toBe(
      `${DEFAULT_READER_PREFS.fontSize}px`
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/web test src/components/__tests__/theme-panel.test.ts`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 实现 ThemePanel.vue 并接入 ReaderPane**

`web/src/components/ThemePanel.vue`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { DEFAULT_READER_PREFS, type ReaderPrefs } from "@readly/shared";
import { ACCENT_PRESETS, FONT_STACKS, READING_THEMES } from "@/modules/theme";
import { useSettingsStore } from "@/stores/settings";

const emit = defineEmits<{ close: [] }>();

const settings = useSettingsStore();
const prefs = computed(() => settings.prefs);

// paper 主题的规格含衬线,主题卡=颜色+字体预设组合;字体族滑块仍可事后覆盖
const THEME_FONTS: Partial<Record<string, ReaderPrefs["fontFamily"]>> = { paper: "serif" };

function pickTheme(id: ReaderPrefs["readingTheme"]): void {
  const font = THEME_FONTS[id];
  settings.updatePrefs(font ? { readingTheme: id, fontFamily: font } : { readingTheme: id, fontFamily: "system" });
}

function setMode(mode: ReaderPrefs["themeMode"]): void {
  settings.updatePrefs({ themeMode: mode });
}

function setAccent(value: string): void {
  settings.updatePrefs({ accent: value });
}

function setNumber(key: "fontSize" | "lineHeight" | "contentWidth", e: Event): void {
  const value = Number((e.target as HTMLInputElement).value);
  settings.updatePrefs({ [key]: value } as Partial<ReaderPrefs>);
}

function setFont(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  settings.updatePrefs({ fontFamily: v === "serif" ? "serif" : "system" });
}

function onCustomColor(e: Event): void {
  const value = (e.target as HTMLInputElement).value;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) settings.updatePrefs({ accent: value });
}

const section = "mt-4";
const label = "text-xs font-medium text-neutral-500";
const seg = (active: boolean) =>
  `flex-1 rounded-md px-2 py-1 text-xs ${active ? "bg-[var(--accent)] text-white" : "text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"}`;
</script>

<template>
  <aside class="flex h-full w-72 flex-col overflow-y-auto border-l border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
    <div class="flex items-center justify-between">
      <h3 class="font-semibold">阅读设置</h3>
      <button class="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="emit('close')">
        关闭
      </button>
    </div>

    <div :class="section">
      <p :class="label">外观</p>
      <div class="mt-1.5 flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
        <button :class="seg(prefs.themeMode === 'light')" data-mode="light" @click="setMode('light')">亮色</button>
        <button :class="seg(prefs.themeMode === 'dark')" data-mode="dark" @click="setMode('dark')">暗色</button>
        <button :class="seg(prefs.themeMode === 'system')" data-mode="system" @click="setMode('system')">跟随系统</button>
      </div>
    </div>

    <div :class="section">
      <p :class="label">强调色</p>
      <div class="mt-1.5 grid grid-cols-6 gap-1.5">
        <button
          v-for="p in ACCENT_PRESETS"
          :key="p.value"
          :title="p.name"
          :data-accent="p.value"
          class="h-6 w-6 rounded-full border border-black/10 transition-transform hover:scale-110"
          :style="{ background: p.value, boxShadow: prefs.accent === p.value ? '0 0 0 2px var(--accent)' : undefined }"
          @click="setAccent(p.value)"
        />
      </div>
      <label class="mt-2 flex items-center gap-2 text-xs text-neutral-500">
        自定义
        <input type="color" :value="prefs.accent" class="h-6 w-10 cursor-pointer rounded border-0 bg-transparent p-0" @input="onCustomColor" />
      </label>
    </div>

    <div :class="section">
      <p :class="label">阅读主题</p>
      <div class="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          v-for="t in READING_THEMES"
          :key="t.id"
          :data-theme-card="t.id"
          class="rounded-lg border px-2 py-1.5 text-left text-xs"
          :class="prefs.readingTheme === t.id ? 'border-[var(--accent)] text-neutral-900 dark:text-neutral-100' : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700'"
          @click="pickTheme(t.id)"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div :class="section">
      <p :class="label">字号 {{ prefs.fontSize }}px</p>
      <input type="range" min="14" max="24" step="1" :value="prefs.fontSize" data-pref="fontSize" class="mt-1 w-full accent-[var(--accent)]" @input="setNumber('fontSize', $event)" />
    </div>

    <div :class="section">
      <p :class="label">行距 {{ prefs.lineHeight.toFixed(1) }}</p>
      <input type="range" min="1.4" max="2.2" step="0.1" :value="prefs.lineHeight" data-pref="lineHeight" class="mt-1 w-full accent-[var(--accent)]" @input="setNumber('lineHeight', $event)" />
    </div>

    <div :class="section">
      <p :class="label">正文宽度 {{ prefs.contentWidth }}px</p>
      <input type="range" min="560" max="900" step="20" :value="prefs.contentWidth" data-pref="contentWidth" class="mt-1 w-full accent-[var(--accent)]" @input="setNumber('contentWidth', $event)" />
    </div>

    <div :class="section">
      <p :class="label">字体</p>
      <select :value="prefs.fontFamily" class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700" @change="setFont">
        <option value="system">系统无衬线</option>
        <option value="serif">中文衬线</option>
      </select>
      <p class="mt-1 truncate text-[10px] text-neutral-400" :style="{ fontFamily: FONT_STACKS[prefs.fontFamily] }">示例:阅读是随身携带的避难所</p>
    </div>

    <div :class="section">
      <p :class="label">已读策略</p>
      <label class="mt-1.5 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" :checked="prefs.autoMarkReadOnOpen" class="accent-[var(--accent)]" @change="settings.updatePrefs({ autoMarkReadOnOpen: ($event.target as HTMLInputElement).checked })" />
        打开文章即标已读
      </label>
      <label class="mt-1 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" :checked="prefs.autoMarkReadOnScroll" class="accent-[var(--accent)]" @change="settings.updatePrefs({ autoMarkReadOnScroll: ($event.target as HTMLInputElement).checked })" />
        滚动到底自动已读
      </label>
    </div>

    <button data-reset class="mt-5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800" @click="settings.resetPrefs()">
      恢复默认
    </button>
  </aside>
</template>
```

`web/src/components/ReaderPane.vue` 修改四处:

1. script 顶部 import 与状态:

```ts
import { computed, ref } from "vue";
import ThemePanel from "./ThemePanel.vue";
// ... 既有 import 不动
const showThemePanel = ref(false);
```

2. 工具栏按钮组,在「原文」链接前插入:

```vue
            <button :class="btn" @click="showThemePanel = !showThemePanel">Aa 主题</button>
```

3. 模板结构:把 `<article ... />` 与空态 div 包进一个相对定位容器,并挂载面板:

```vue
      <div class="relative flex min-h-0 flex-1">
        <article class="reader-body mx-auto w-full overflow-y-auto px-6 py-6" v-html="html" />
        <div v-if="!html" class="p-6 text-sm text-neutral-500">该文章没有可显示的正文,可尝试打开原文。</div>
        <ThemePanel v-if="showThemePanel" class="absolute inset-y-0 right-0 z-30 shadow-xl" @close="showThemePanel = false" />
      </div>
```

(注意:原 `<article>` 与空态 div 的兄弟关系保持;外层容器加 `relative flex min-h-0 flex-1`,让面板贴右侧全高。)

4. `<style scoped>` 的 `.reader-body` 消费主题变量:

```css
.reader-body {
  max-width: var(--reader-width, 720px);
  font-size: var(--reader-font-size, 17px);
  line-height: var(--reader-line-height, 1.7);
  font-family: var(--reader-font-family, inherit);
  background: var(--reader-bg, transparent);
  color: var(--reader-text, inherit);
  border-radius: 12px;
}
.reader-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
.reader-body :deep(a) {
  color: var(--reader-link, var(--accent));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @readly/web test src/components/__tests__/theme-panel.test.ts`
Expected: 全过(4 个用例)

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/components
git commit -m "feat(web): 阅读主题面板(模式/强调色/5 主题/滑块/已读策略)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 自动已读策略接线(打开 / 滚动到底)

**Files:**
- Modify: `web/src/views/Inbox.vue`(`selectArticle` 尊重 `autoMarkReadOnOpen`)
- Modify: `web/src/components/ArticleList.vue`(`select` 尊重 `autoMarkReadOnOpen`)
- Modify: `web/src/components/ReaderPane.vue`(底部哨兵 + IntersectionObserver,尊重 `autoMarkReadOnScroll`)
- Create: `web/src/components/__tests__/auto-read.test.ts`

**Interfaces:**
- Consumes: `useSettingsStore`(Task 2)、既有 `articles.setState` / ReaderPane `toggle`
- Produces: 行为契约——`autoMarkReadOnOpen=false` 时打开文章不发 PATCH;`autoMarkReadOnScroll=true` 且哨兵可见且文章未读时自动 `isRead:true`

- [ ] **Step 1: 写失败测试**

`web/src/components/__tests__/auto-read.test.ts`:

```ts
// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { api } from "@/api/client";
import ArticleList from "@/components/ArticleList.vue";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// jsdom 无 IntersectionObserver:捕获回调供测试触发
class FakeIO {
  static instances: FakeIO[] = [];
  callback: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    FakeIO.instances.push(this);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

const ITEM = {
  id: 1,
  feedId: 1,
  feedTitle: "F",
  feedIconUrl: null,
  title: "标题一",
  url: null,
  author: null,
  publishedAt: "2026-01-01T00:00:00.000Z",
  excerpt: null,
  imageUrl: null,
  isRead: false,
  isStarred: false,
  isLater: false,
  hasFullText: false,
};

let app: App | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIO);
  FakeIO.instances = [];
  setActivePinia(createPinia());
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

async function mountList() {
  const router = createRouter({ history: createWebHistory(), routes: [{ path: "/", component: { template: "<div/>" } }] });
  await router.push("/");
  await router.isReady();
  app = createApp(ArticleList);
  app.use(createPinia());
  app.use(router);
  app.mount(host!);
  await nextTick();
}

describe("autoMarkReadOnOpen", () => {
  it("关闭时点击文章不发 PATCH;开启时发 PATCH", async () => {
    const settings = useSettingsStore();
    settings.initLocal();
    settings.updatePrefs({ autoMarkReadOnOpen: false });
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/articles") return Promise.resolve({ items: [{ ...ITEM }], nextCursor: null });
      if (path === "/api/articles/1") return Promise.resolve({ ...ITEM });
      return Promise.resolve({});
    });
    await mountList();
    // 列表由外部加载(避开冷启动守卫)
    const { useArticlesStore } = await import("@/stores/articles");
    await useArticlesStore().load(true);
    await nextTick();
    const row = host!.querySelector<HTMLButtonElement>("button");
    row!.click();
    await nextTick();
    const patches = vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/articles/1" && o?.method === "PATCH");
    expect(patches).toHaveLength(0);

    settings.updatePrefs({ autoMarkReadOnOpen: true });
    useArticlesStore().patchItemLocally(1, { isRead: false });
    row!.click();
    await nextTick();
    const patches2 = vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/articles/1" && o?.method === "PATCH");
    expect(patches2).toHaveLength(1);
  });
});
```

（ReaderPane 的滚动已读用例放同文件追加;实现见 Step 3,测试如下:)

```ts
import ReaderPane from "@/components/ReaderPane.vue";
import { useReaderStore } from "@/stores/reader";

describe("autoMarkReadOnScroll", () => {
  it("哨兵可见且开启时自动标已读;关闭时不标", async () => {
    const settings = useSettingsStore();
    settings.initLocal();
    vi.mocked(api).mockImplementation((path, o) => {
      if (path === "/api/articles/2") return o?.method === "PATCH" ? Promise.resolve({}) : Promise.resolve({ ...ITEM, id: 2, isRead: false });
      return Promise.resolve({});
    });
    const router = createRouter({ history: createWebHistory(), routes: [{ path: "/", component: { template: "<div/>" } }] });
    await router.push("/");
    await router.isReady();
    app = createApp(ReaderPane);
    app.use(createPinia());
    app.use(router);
    app.mount(host!);
    const reader = useReaderStore();
    await reader.open(2);
    await nextTick();

    settings.updatePrefs({ autoMarkReadOnScroll: false });
    const io = FakeIO.instances.at(-1)!;
    io.callback([{ isIntersecting: true } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    await nextTick();
    expect(vi.mocked(api).mock.calls.filter(([p, o]) => o?.method === "PATCH")).toHaveLength(0);

    settings.updatePrefs({ autoMarkReadOnScroll: true });
    io.callback([{ isIntersecting: true } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    await nextTick();
    expect(vi.mocked(api).mock.calls.filter(([p, o]) => o?.method === "PATCH")).toHaveLength(1);
  });
});
```

（若 ReaderPane 挂载需要 pinia 在 `useReaderStore()` 之前安装:上面已先 `app.use(createPinia())`;`useReaderStore()` 在挂载后调用即可。若时序上 pinia 未激活导致报错,用 `setActivePinia` + `app.use` 同一实例:把 `const pinia = createPinia(); app.use(pinia); setActivePinia(pinia);` 作为修正写法——执行时以此为准。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/web test src/components/__tests__/auto-read.test.ts`
Expected: FAIL(行为未实现:关闭策略时仍会 PATCH)

- [ ] **Step 3: 实现三处接线**

`web/src/views/Inbox.vue`:`selectArticle` 的末段改为:

```ts
  setArticleParam(id);
  const item = articles.items.find((i) => i.id === id);
  if (useSettingsStore().prefs.autoMarkReadOnOpen && item && !item.isRead) {
    void articles.setState(id, { isRead: true });
  }
```

(顶部加 `import { useSettingsStore } from "@/stores/settings";`;`const settings = useSettingsStore();` 与既有 store 声明并列,统一用 `settings.prefs.autoMarkReadOnOpen`。)

`web/src/components/ArticleList.vue` 的 `select` 末段同样改为:

```ts
  const item = articles.items.find((i) => i.id === id);
  if (settings.prefs.autoMarkReadOnOpen && item && !item.isRead) void articles.setState(id, { isRead: true });
```

(顶部加 import 与 `const settings = useSettingsStore();`。)

`web/src/components/ReaderPane.vue`:script 追加:

```ts
import { onMounted, onUnmounted, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";

const settings = useSettingsStore();
const bottomSentinel = ref<HTMLElement | null>(null);
let scrollObserver: IntersectionObserver | null = null;

function setupScrollObserver(): void {
  scrollObserver?.disconnect();
  scrollObserver = null;
  if (!bottomSentinel.value || typeof IntersectionObserver === "undefined") return;
  scrollObserver = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    const a = reader.article;
    if (!a || a.isRead) return;
    if (!settings.prefs.autoMarkReadOnScroll) return;
    void toggle({ isRead: true });
  });
  scrollObserver.observe(bottomSentinel.value);
}

onMounted(setupScrollObserver);
onUnmounted(() => scrollObserver?.disconnect());
watch(() => reader.article?.id, () => void nextTick(setupScrollObserver));
```

(toggle 已有;script 里补 `import { nextTick, watch } from "vue";` 并入现有 import;`note`:哨兵元素在模板 `<article>` 之后插入:

```vue
        <article class="reader-body mx-auto w-full overflow-y-auto px-6 py-6" v-html="html" />
        <div ref="bottomSentinel" class="h-px shrink-0" />
        <div v-if="!html" class="p-6 text-sm text-neutral-500">该文章没有可显示的正文,可尝试打开原文。</div>
```

— 注意该容器应为 Task 3 的 `relative flex min-h-0 flex-1` 容器;哨兵是滚动容器的最后一个子元素,`h-px` 不占视觉空间。)

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @readly/web test src/components/__tests__/auto-read.test.ts`
Expected: 全过;再跑全量 `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck`

- [ ] **Step 5: 提交**

```bash
git add web/src/views/Inbox.vue web/src/components
git commit -m "feat(web): 自动已读策略接线(打开即已读/滚动到底已读,可在面板关闭)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 侧栏计数实时刷新 + 死代码清理

**Files:**
- Modify: `web/src/stores/feeds.ts`(新增 `refreshStats()`)
- Modify: `web/src/stores/articles.ts`(`setState` 成功后防抖刷新 stats)
- Delete: `web/src/api/types.ts`
- Test: `web/src/stores/__tests__/articles.test.ts`(追加用例)

**Interfaces:**
- Produces: `feedsStore.refreshStats(): Promise<void>`(仅 GET `/api/stats`,不改 categories/feeds)

- [ ] **Step 1: 写失败测试(articles.test.ts 追加)**

```ts
  it("setState 成功后防抖刷新 stats,连续变更只刷一次", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api).mockImplementation((path, opts) => {
        if (path === "/api/articles" && !opts?.method) return Promise.resolve({ items: [item(1)], nextCursor: null });
        if (path === "/api/articles/1") return Promise.resolve({ isRead: true, isStarred: false, isLater: false });
        if (path === "/api/stats") return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
        return Promise.resolve({});
      });
      const store = useArticlesStore();
      await store.load(true);
      const before = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/stats").length;
      await store.setState(1, { isRead: true });
      await store.setState(1, { isStarred: true });
      await vi.advanceTimersByTimeAsync(900);
      const after = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/stats").length;
      expect(after - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @readly/web test src/stores/__tests__/articles.test.ts`
Expected: 新用例 FAIL(stats 未被调用)

- [ ] **Step 3: 实现**

`web/src/stores/feeds.ts` 追加(并加入 return):

```ts
  // 轻量刷新:仅更新侧栏计数,不重拉分类/订阅(阅读标已读后调用)
  async function refreshStats(): Promise<void> {
    stats.value = await api<Stats>("/api/stats");
  }
```

`web/src/stores/articles.ts`:顶部 `import { useFeedsStore } from "./feeds";`;模块内:

```ts
const STATS_REFRESH_DEBOUNCE_MS = 800;
let statsTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStatsRefresh(): void {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    statsTimer = null;
    void useFeedsStore().refreshStats().catch(() => undefined);
  }, STATS_REFRESH_DEBOUNCE_MS);
}
```

在 `setState` 成功路径(移除分支之后)追加 `scheduleStatsRefresh();`。

删除 `web/src/api/types.ts`(台账确认零引用;删除后 `pnpm --filter @readly/web typecheck` 必须仍然通过——若有隐藏引用则恢复该文件并在报告中说明)。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/stores web/src/api
git commit -m "feat(web): 阅读后侧栏计数防抖刷新;删除无人引用的 api/types.ts

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: PWA(配置 + 图标 + 元信息)

**Files:**
- Modify: `web/package.json`(devDeps:`vite-plugin-pwa`、`sharp`;scripts:`icons`)
- Create: `web/scripts/gen-icons.mjs`
- Create: `web/public/logo.svg`(源图标)
- Generated(提交入库):`web/public/pwa-192x192.png`、`web/public/pwa-512x512.png`、`web/public/maskable-512x512.png`、`web/public/apple-touch-icon-180x180.png`
- Modify: `web/vite.config.ts`(VitePWA 插件)
- Modify: `web/index.html`(apple-touch-icon、theme-color、description)
- Test: `web/scripts/verify-pwa.mjs`(构建产物校验,作为验证步骤脚本)

**Interfaces:**
- Produces: 生产构建产出 `dist/manifest.webmanifest` + `dist/sw.js` + 4 个图标;`pnpm --filter @readly/web icons` 重新生成图标;`pnpm --filter @readly/web verify:pwa` 校验构建产物

- [ ] **Step 1: 安装依赖与图标脚本**

Run: `pnpm --filter @readly/web add -D vite-plugin-pwa@^1 sharp@^0.34`
(若版本范围解析不到,取各自 latest 并记录。)

`web/public/logo.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#3b82f6"/>
  <circle cx="20" cy="44" r="5" fill="#fff"/>
  <path d="M15 30a19 19 0 0 1 19 19" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
  <path d="M15 17a32 32 0 0 1 32 32" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
</svg>
```

`web/scripts/gen-icons.mjs`:

```js
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "..", "public");
const svg = await readFile(path.join(publicDir, "logo.svg"));

async function png(size, outfile, { maskable = false } = {}) {
  const inner = Math.round(size * (maskable ? 0.72 : 1));
  const logo = await sharp(svg).resize(inner, inner).png().toBuffer();
  const canvas = sharp({
    create: { width: size, height: size, channels: 4, background: maskable ? "#3b82f6" : "#00000000" },
  }).composite([{ input: logo, gravity: "center" }]);
  await canvas.png().toFile(path.join(publicDir, outfile));
  console.log(`wrote public/${outfile} (${size}px${maskable ? ", maskable" : ""})`);
}

await png(192, "pwa-192x192.png");
await png(512, "pwa-512x512.png");
await png(512, "maskable-512x512.png", { maskable: true });
await png(180, "apple-touch-icon-180x180.png");
```

package.json scripts 追加:`"icons": "node scripts/gen-icons.mjs"`、`"verify:pwa": "node scripts/verify-pwa.mjs"`。

Run: `pnpm --filter @readly/web icons`
Expected: 输出 4 个 `wrote public/...`;`ls web/public` 可见 4 个 PNG。

- [ ] **Step 2: 配置 vite-plugin-pwa 与 index.html**

`web/vite.config.ts`:

```ts
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon-180x180.png"],
      manifest: {
        name: "Readly",
        short_name: "Readly",
        lang: "zh-CN",
        description: "自托管 RSS 阅读器",
        start_url: "/",
        display: "standalone",
        theme_color: "#3b82f6",
        background_color: "#ffffff",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
```

`web/index.html` 的 `<head>` 追加(预绘制脚本保留不动):

```html
    <meta name="description" content="自托管 RSS 阅读器" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1a1a" />
    <link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" />
    <link rel="icon" type="image/svg+xml" href="/logo.svg" />
```

- [ ] **Step 3: 构建校验脚本**

`web/scripts/verify-pwa.mjs`:

```js
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const must = ["manifest.webmanifest", "sw.js", "pwa-192x192.png", "pwa-512x512.png", "maskable-512x512.png", "apple-touch-icon-180x180.png"];
for (const f of must) {
  await stat(path.join(dist, f)).catch(() => {
    console.error(`MISSING: dist/${f}`);
    process.exit(1);
  });
}
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.webmanifest"), "utf8"));
const checks = [
  [manifest.name === "Readly", "manifest.name"],
  [manifest.lang === "zh-CN", "manifest.lang"],
  [manifest.display === "standalone", "manifest.display"],
  [Array.isArray(manifest.icons) && manifest.icons.length === 3, "manifest.icons 数量"],
  [manifest.icons.some((i) => i.purpose === "maskable"), "maskable 图标"],
];
const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
if (failed.length) {
  console.error("PWA 校验失败:", failed.join(", "));
  process.exit(1);
}
console.log("PWA 校验通过:manifest 字段与 4 个图标齐全,sw.js 已生成");
```

- [ ] **Step 4: 验证**

Run: `pnpm --filter @readly/web build && pnpm --filter @readly/web verify:pwa`
Expected: 构建成功;`PWA 校验通过:...`

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck`
Expected: 全绿(既有 39+ 用例不受影响)

- [ ] **Step 5: 提交**

```bash
git add web/package.json web/pnpm-lock.yaml 2>/dev/null; git add web pnpm-lock.yaml; git commit -m "feat(web): PWA 配置、图标生成脚本与构建校验

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

(以实际改动文件为准一次性 `git add -A` 亦可;注意 `web/dist` 已被忽略。)

---

### Task 7: 收尾(README 更新 + 全量验证 + Chrome 实测)

**Files:**
- Modify: `README.md`(功能清单:2 移除「(计划 02)」标注;新增「阅读体验」与「PWA」要点)
- Modify: `docs/superpowers/plans/2026-10-13-readly-01-core.md` 无需动;仅 README

- [ ] **Step 1: README 更新**

「功能」清单第 2 条改为已交付描述,并追加 PWA 说明:

```markdown
2. 阅读体验:亮/暗/跟随系统 + 12 色调色板与自定义强调色、5 套阅读主题(经典/护眼米黄/羊皮纸/夜间/高对比)、字号/行距/宽度/字体可调,偏好本地即时生效并同步云端
```

在「本地开发」段后追加:

```markdown
## PWA

生产构建产出可安装 PWA(manifest + Service Worker,应用壳离线可用):

```bash
pnpm --filter @readly/web icons        # 重新生成图标(改 logo.svg 后)
pnpm --filter @readly/web verify:pwa   # 校验构建产物中的 manifest/SW/图标
```
```

- [ ] **Step 2: 全量验证**

Run: `pnpm build && pnpm -r test && pnpm -r typecheck`
Expected: worker 114 + web(39 + 本计划新增)全绿

- [ ] **Step 3: Chrome 实测(critical 行为逐一核验)**

用 headless Chrome(本机 `google-chrome`,CDP)对 `pnpm --filter @readly/web preview`(或 dist 静态服务,`/api` 可用桩)核验并记录数值/结论:

1. 首次加载:html 无 `.dark`(或随系统),`data-reading-theme="classic"`;
2. 面板切「暗色」→ `html.dark` 立即出现,侧栏/列表背景变深;切「亮色」还原;
3. 点「护眼米黄」→ `data-reading-theme="sepia"`,正文背景 `#f5f0e1`;
4. localStorage `readly_prefs` 已写入;刷新页面后主题保持(**无闪烁**:预绘制脚本生效);
5. 推入一条 `/api/settings` 响应(桩)含服务端偏好 → 清 localStorage 后刷新,主题采用服务端值;
6. `dist/sw.js` 注册(console 或 `navigator.serviceWorker.controller`);
7. 截图 3 张(亮/暗/米黄)附报告文件名。

临时桩服务与截图脚本放 /tmp,验后删除。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: README 更新阅读体验与 PWA 说明

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 后续计划索引

- **计划 03 — 全文抓取(M3)**:`/api/proxy/html`(复用 SSRF 门)+ 客户端 Readability 提取流水线 + 惰性自动抓取(fetch_prefs)+ 持久化与来源提示。
- **计划 04 — 本地分析(M4)**:IDB 镜像、聚类、关键词监控。
- **计划 05 — TTS + AI(M5+M6)**:朗读与摘要翻译(**该计划需引入 /settings 设置页**,承载 AI 服务商/朗读/数据分组;计划 02 的 ThemePanel 是阅读器内面板,两者不冲突)。
- **计划 06 — 收尾(M7)**。

## 自检记录(writing-plans self-review)

- **规格覆盖**:设计 §7.3(外观模式/强调色/5 主题表/字号/行距/宽度/字体族/无 Web 字体/持久化双写)→ T1–T3;§7.4(打开即已读默认开/滚动到底自动已读默认开)→ T4;§3.1 PWA(manifest/图标/壳缓存)→ T6;§7.1(响应式单栏)→ 已在计划 01 交付;设置页 `/settings` → 明确移交计划 05(该页主体是 AI/朗读/数据分组)。台账 fix-soon 两项 → T5。
- **与冻结类型的一致性**:`ReaderPrefs` 字段(themeMode/accent/readingTheme/fontSize/lineHeight/contentWidth/fontFamily/autoMarkReadOnOpen/autoMarkReadOnScroll)在 T1/T2 全部按 shared 原样引用;5 主题 id 与 `ReadingTheme` 联合一致;`SETTING_KEYS.readerPrefs` 复用。
- **已知有意决策**(执行者与审查者请注意,勿当缺陷报告):
  1. 主题卡 = 颜色+字体预设组合(paper⇄serif),这是对规格表「字体」列的落地方式,而非独立字段;
  2. `dark:` 由媒体策略切换为 class 策略,依靠 index.html 预绘制脚本 + main.ts 同步兜底,任何模板都不再直接依赖媒体查询;
  3. `sanitizePrefs` 对数值做范围钳制(即使 localStorage/D1 被手工篡改也安全);
  4. T4 测试中 ReaderPane 挂载的 pinia 时序已给出修正写法,以执行时实际可行为准。
- **无占位符**;所有新文件给出完整代码;接口签名(T1 的 6 个导出、T2 的 store API、T5 的 refreshStats)在任务间一致。
