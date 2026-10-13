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
