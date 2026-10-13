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
