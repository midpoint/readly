// 移动端底部导航:既有五个 tab 不回归 + 第六入口「更多」底部弹层(MoreSheet)
// 说明:弹层为 MobileNav 本地态(showMore ref),不开全局;Esc/遮罩/选中后均关闭。
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import MobileNav from "@/components/MobileNav.vue";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
import { useArticlesStore } from "@/stores/articles";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const STUB = { template: "<div />" };

let mounted: { app: App; container: HTMLElement } | null = null;

// 宏任务排空微任务链(setFilter → 请求 → 渲染),再补两次 DOM 更新
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

async function mountNav(pinia: Pinia): Promise<{ router: Router; container: HTMLElement }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: STUB },
      { path: "/add", component: STUB },
      { path: "/events", component: STUB },
      { path: "/keywords", component: STUB },
      { path: "/settings", component: STUB },
    ],
  });
  await router.push("/");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(MobileNav);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return { router, container };
}

function sheetOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-more-sheet]");
}

function moreButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>("[data-more]");
  expect(btn).toBeTruthy();
  return btn!;
}

// 打开弹层并返回其根元素
async function openSheet(container: HTMLElement): Promise<HTMLElement> {
  moreButton(container).click();
  await flush();
  const sheet = sheetOf(container);
  expect(sheet).not.toBeNull();
  return sheet!;
}

async function clickItem(container: HTMLElement, key: string): Promise<HTMLElement> {
  const item = container.querySelector<HTMLElement>(`[data-more-item="${key}"]`);
  expect(item).toBeTruthy();
  item!.click();
  await flush();
  return item!;
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path) => {
    if (path === "/api/articles") return Promise.resolve({ items: [], nextCursor: null });
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/categories") return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  useShortcutHelp().closeShortcutHelp(); // 复位模块级单例,避免污染其它用例
  vi.unstubAllGlobals();
});

describe("MobileNav 既有 tab(不回归)", () => {
  it("四个筛选 tab + 添加:未读仍 replace 到 /?view=unread 并写 filter,添加仍进 /add", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { router, container } = await mountNav(pinia);
    const articles = useArticlesStore();

    const unread = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "未读");
    expect(unread).toBeTruthy();
    unread!.click();
    await flush();
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.currentRoute.value.query.view).toBe("unread");
    expect(articles.view).toBe("unread");

    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "添加");
    expect(add).toBeTruthy();
    add!.click();
    await flush();
    expect(router.currentRoute.value.path).toBe("/add");
  });
});

describe("MobileNav「更多」底部弹层", () => {
  it("点 [data-more] 弹出弹层,含事件/关键词/设置/快捷键四个入口按钮", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { container } = await mountNav(pinia);

    expect(sheetOf(container)).toBeNull(); // 默认不渲染
    const more = moreButton(container);
    expect(more.textContent?.trim()).toBe("更多");

    const sheet = await openSheet(container);
    const items = [...sheet.querySelectorAll<HTMLElement>("[data-more-item]")];
    expect(items.map((el) => el.getAttribute("data-more-item"))).toEqual([
      "events",
      "keywords",
      "settings",
      "shortcuts",
    ]);
    for (const item of items) expect(item.tagName).toBe("BUTTON"); // 入口须为可聚焦按钮
    const text = sheet.textContent ?? "";
    for (const label of ["事件", "关键词", "设置", "快捷键"]) expect(text).toContain(label);
  });

  it("点「事件」跳 /events,点「关键词」跳 /keywords,点「设置」跳 /settings;均关闭弹层", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { router, container } = await mountNav(pinia);

    for (const [key, path] of [
      ["events", "/events"],
      ["keywords", "/keywords"],
      ["settings", "/settings"],
    ] as const) {
      await openSheet(container);
      await clickItem(container, key);
      expect(router.currentRoute.value.path).toBe(path);
      expect(sheetOf(container)).toBeNull(); // 选中后关闭
    }
  });

  it("点「快捷键」打开既有帮助浮层(模块级单例)并关闭弹层", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { container } = await mountNav(pinia);
    const { showShortcutHelp } = useShortcutHelp();
    expect(showShortcutHelp.value).toBe(false);

    await openSheet(container);
    await clickItem(container, "shortcuts");
    expect(showShortcutHelp.value).toBe(true);
    expect(sheetOf(container)).toBeNull();
  });

  it("按 Esc 关闭弹层", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { container } = await mountNav(pinia);

    await openSheet(container);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(sheetOf(container)).toBeNull();
  });

  it("点遮罩关闭,点卡片本体不关闭;关闭后监听撤除(Esc 不再报错)", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { container } = await mountNav(pinia);

    const sheet = await openSheet(container);
    const panel = sheet.firstElementChild as HTMLElement;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(sheetOf(container)).not.toBeNull(); // 点卡片本体:遮罩 @click.self 不误关

    sheet.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(sheetOf(container)).toBeNull(); // 点遮罩:关闭

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(sheetOf(container)).toBeNull();
  });

  it("弹层可二次打开(关闭后状态复位,不残留)", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { container } = await mountNav(pinia);

    await openSheet(container);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(sheetOf(container)).toBeNull();

    const sheet = await openSheet(container);
    expect(sheet.querySelectorAll("[data-more-item]")).toHaveLength(4);
  });
});
