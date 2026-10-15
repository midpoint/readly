// @vitest-environment jsdom
// 说明:jsdom 无布局引擎,不做像素断言;本文件钉「交互 → 偏好/变量」链路。
// jsdom 构造差异两处(均已在实现侧守卫/本文件适配,断言语义不变):
//  1. 未实现 PointerEvent:以同型 MouseEvent(type 为 pointer*)注入,handler 只读 clientX/pointerId/currentTarget;
//  2. 未实现 setPointerCapture:实现内以 try/catch 包住该调用(见 Inbox.vue startDrag)。
import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleListItem } from "@readly/shared";
import { api } from "@/api/client";
import { useSettingsStore } from "@/stores/settings";
import Inbox, { LIST_MAX, LIST_MIN, SIDEBAR_MAX, SIDEBAR_MIN } from "@/views/Inbox.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const ARTICLE: ArticleListItem = {
  id: 1,
  feedId: 1,
  feedTitle: "示例源",
  feedIconUrl: null,
  title: "分隔线拖拽用例文章",
  url: null,
  author: null,
  publishedAt: "2025-10-13T08:00:00.000Z",
  excerpt: null,
  imageUrl: null,
  isRead: false,
  isStarred: false,
  isLater: false,
  hasFullText: false,
};

// jsdom 无 IntersectionObserver(ArticleList/ReaderPane 挂载时使用)
class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let mounted: { app: App; container: HTMLElement } | null = null;

// 宏任务排空全部微任务链(store 初始化 → 请求 → 渲染),再补两次 DOM 更新
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  await nextTick();
}

// jsdom 无布局:以 innerWidth 覆写模拟视口,并重派 resize 事件让组件门控刷新
function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
}

// jsdom 未实现 PointerEvent:以同型 MouseEvent 注入(reader 侧只依赖 clientX)
function pointer(type: "pointerdown" | "pointermove" | "pointerup", clientX: number): MouseEvent {
  return new MouseEvent(type, { clientX, bubbles: true, cancelable: true });
}

async function mountInbox(path = "/?a=1", width = 1600): Promise<{ router: Router; container: HTMLElement }> {
  const pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: Inbox }],
  });
  await router.push(path);
  await router.isReady();
  setViewport(width); // 组件 setup 时读取 window.innerWidth,须在 mount 前就位
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Inbox);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return { router, container };
}

function handleOf(container: HTMLElement, kind: "sidebar" | "list"): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-resize-handle="${kind}"]`);
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path, opts) => {
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    if (path === "/api/articles" && !opts?.method) return Promise.resolve({ items: [ARTICLE], nextCursor: null });
    if (path === "/api/articles/1" && !opts?.method)
      return Promise.resolve({
        ...ARTICLE,
        content: "<p>正文</p>",
        contentFull: null,
        aiSummary: null,
        aiTranslation: null,
        extractedAt: null,
      });
    return Promise.resolve(null);
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  setViewport(1024); // 还原 jsdom 默认视口,避免外溢到其它用例
  vi.unstubAllGlobals();
});

describe("分隔线:门控与元素契约", () => {
  it("导出钳制常量与偏好默认区间一致(sidebar 200–420 / list 300–600)", () => {
    expect([SIDEBAR_MIN, SIDEBAR_MAX]).toEqual([200, 420]);
    expect([LIST_MIN, LIST_MAX]).toEqual([300, 600]);
  });

  it("≥1600px 两条把手存在且带 ARIA 契约;缩到 1000px 两条消失;回 1600 回归", async () => {
    const { container } = await mountInbox("/?a=1", 1600);

    const sidebar = handleOf(container, "sidebar");
    const list = handleOf(container, "list");
    expect(sidebar).not.toBeNull();
    expect(list).not.toBeNull();
    expect(sidebar!.getAttribute("role")).toBe("separator");
    expect(sidebar!.getAttribute("aria-orientation")).toBe("vertical");
    expect(sidebar!.title).toBe("拖拽调节宽度,双击恢复默认");
    expect(list!.getAttribute("role")).toBe("separator");
    expect(list!.getAttribute("aria-orientation")).toBe("vertical");

    setViewport(1000);
    await flush();
    expect(handleOf(container, "sidebar")).toBeNull();
    expect(handleOf(container, "list")).toBeNull();
    expect(rootOf(container).style.getPropertyValue("--side-w")).toBe("");

    setViewport(1600);
    await flush();
    expect(handleOf(container, "sidebar")).not.toBeNull();
    expect(handleOf(container, "list")).not.toBeNull();
  });
});

describe("分隔线:拖拽 → 偏好/变量", () => {
  it("sidebar 拖 +150:prefs 406、--side-w 同步、拖拽期 select-none、松手清理", async () => {
    const { container } = await mountInbox("/?a=1", 1600);
    const settings = useSettingsStore();
    const root = rootOf(container);
    expect(settings.prefs.sidebarWidth).toBe(256);
    expect(root.style.getPropertyValue("--side-w")).toBe("256px");
    expect(root.style.getPropertyValue("--list-w")).toBe("380px");

    const handle = handleOf(container, "sidebar")!;
    handle.dispatchEvent(pointer("pointerdown", 300));
    await nextTick();
    expect(root.classList.contains("select-none")).toBe(true); // 拖拽态类

    handle.dispatchEvent(pointer("pointermove", 450));
    await nextTick();
    expect(settings.prefs.sidebarWidth).toBe(406); // 256 + (450 - 300)
    expect(root.style.getPropertyValue("--side-w")).toBe("406px");

    handle.dispatchEvent(pointer("pointerup", 450));
    await nextTick();
    expect(root.classList.contains("select-none")).toBe(false); // 松手退出拖拽态
  });

  it("越界拖拽被钳到上限:sidebar +1000 → 420", async () => {
    const { container } = await mountInbox("/?a=1", 1600);
    const settings = useSettingsStore();
    const handle = handleOf(container, "sidebar")!;

    handle.dispatchEvent(pointer("pointerdown", 300));
    handle.dispatchEvent(pointer("pointermove", 1300)); // +1000 → 1256 越上限
    await nextTick();
    expect(settings.prefs.sidebarWidth).toBe(420);
    expect(rootOf(container).style.getPropertyValue("--side-w")).toBe("420px");

    handle.dispatchEvent(pointer("pointerup", 1300));
    await nextTick();
  });

  it("list 拖 -200:380-200=180 越下限 → 钳到 300", async () => {
    const { container } = await mountInbox("/?a=1", 1600);
    const settings = useSettingsStore();
    const handle = handleOf(container, "list")!;

    handle.dispatchEvent(pointer("pointerdown", 800));
    handle.dispatchEvent(pointer("pointermove", 600)); // -200
    await nextTick();
    expect(settings.prefs.listWidth).toBe(300);
    expect(rootOf(container).style.getPropertyValue("--list-w")).toBe("300px");

    handle.dispatchEvent(pointer("pointerup", 600));
    await nextTick();
  });

  it("双击把手复位各自默认值(sidebar → 256,list → 380)", async () => {
    const { container } = await mountInbox("/?a=1", 1600);
    const settings = useSettingsStore();

    const sidebar = handleOf(container, "sidebar")!;
    sidebar.dispatchEvent(pointer("pointerdown", 300));
    sidebar.dispatchEvent(pointer("pointermove", 450));
    await nextTick();
    expect(settings.prefs.sidebarWidth).toBe(406);

    sidebar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(settings.prefs.sidebarWidth).toBe(256);
    expect(rootOf(container).style.getPropertyValue("--side-w")).toBe("256px");

    const list = handleOf(container, "list")!;
    list.dispatchEvent(pointer("pointerdown", 500));
    list.dispatchEvent(pointer("pointermove", 600));
    await nextTick();
    expect(settings.prefs.listWidth).toBe(480);

    list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(settings.prefs.listWidth).toBe(380);
    expect(rootOf(container).style.getPropertyValue("--list-w")).toBe("380px");
  });
});
