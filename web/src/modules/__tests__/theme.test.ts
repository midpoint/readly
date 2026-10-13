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
