// @vitest-environment jsdom
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProvider } from "@readly/shared";
import { api } from "@/api/client";
import Sidebar from "@/components/Sidebar.vue";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
import { PROVIDER_PRESETS } from "@/modules/ai";
import { useAiStore } from "@/stores/ai";
import { useArticlesStore } from "@/stores/articles";
import Settings from "@/views/Settings.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>订阅列表</title></head>
  <body>
    <outline text="科技">
      <outline type="rss" text="少数派" title="少数派" xmlUrl="https://sspai.com/feed" htmlUrl="https://sspai.com"/>
    </outline>
    <outline text="独立源" type="rss" xmlUrl="https://blog.example.com/atom.xml" title="独立博客"/>
  </body>
</opml>`;

const P1: AiProvider = {
  id: "ai_1",
  name: "服务商一",
  baseUrl: "https://a.example.com/v1",
  model: "model-a",
  apiKey: "sk-a",
  useProxy: false,
};
const P2: AiProvider = {
  id: "ai_2",
  name: "服务商二",
  baseUrl: "https://b.example.com/v1",
  model: "model-b",
  useProxy: true,
};

let mounted: { app: App; container: HTMLElement } | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

interface MountResult {
  router: Router;
  container: HTMLElement;
  store: ReturnType<typeof useAiStore>;
}

async function mountSettings(seed?: { providers?: AiProvider[]; activeId?: string | null; syncKeys?: boolean }): Promise<MountResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>inbox</div>" } },
      { path: "/settings", component: Settings },
    ],
  });
  await router.push("/settings");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useAiStore(pinia);
  if (seed?.providers) store.providers = seed.providers.map((p) => ({ ...p }));
  if (seed?.activeId !== undefined) store.activeId = seed.activeId;
  if (seed?.syncKeys !== undefined) store.syncKeys = seed.syncKeys;
  const app = createApp(Settings);
  app.use(pinia);
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return { router, container, store };
}

// 模拟键入:设值 + input 事件(v-model)
function setInput(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectOption(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path, opts) => {
    if (path === "/api/categories" && opts?.method === "POST")
      return Promise.resolve({ id: 1, name: "科技", sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    if (path === "/api/feeds" && opts?.method === "POST") return Promise.resolve({ created: [{ id: 1 }], failed: [] });
    if (path === "/api/categories") return Promise.resolve([]);
    if (path === "/api/feeds") return Promise.resolve([]);
    if (path === "/api/stats")
      return Promise.resolve({ unreadTotal: 0, starredTotal: 0, laterTotal: 0, perFeed: {}, perCategory: {} });
    return Promise.resolve({});
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
});

describe("Settings 挂载", () => {
  it("空态新建:点 data-new-provider 开编辑器 → 选预设填充 → 保存 → 列表出现 provider 行", async () => {
    const { container, store } = await mountSettings();
    expect(container.querySelectorAll("[data-provider-row]")).toHaveLength(0);

    container.querySelector<HTMLButtonElement>("[data-new-provider]")!.click();
    await nextTick();
    const select = container.querySelector<HTMLSelectElement>("[data-provider-preset]");
    expect(select).toBeTruthy();
    // 空表单:保存置灰
    expect(container.querySelector<HTMLButtonElement>("[data-provider-save]")!.disabled).toBe(true);

    const preset = PROVIDER_PRESETS[1]!; // DeepSeek
    selectOption(select!, preset.name);
    await nextTick();
    expect(container.querySelector<HTMLInputElement>("[data-provider-baseurl]")!.value).toBe(preset.baseUrl);
    expect(container.querySelector<HTMLInputElement>("[data-provider-model]")!.value).toBe(preset.model);

    const save = container.querySelector<HTMLButtonElement>("[data-provider-save]")!;
    expect(save.disabled).toBe(false);
    save.click();
    await nextTick();

    expect(store.providers).toHaveLength(1);
    expect(store.providers[0]!.name).toBe(preset.name);
    expect(store.providers[0]!.baseUrl).toBe(preset.baseUrl);
    const rows = container.querySelectorAll("[data-provider-row]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain(preset.name);
    expect(rows[0]!.textContent).toContain(preset.model);
    // 保存后编辑器关闭
    expect(container.querySelector("[data-provider-preset]")).toBeNull();
  });

  it("激活单选:点 data-provider-active → store.activeId 变更", async () => {
    const { container, store } = await mountSettings({ providers: [P1, P2] });
    expect(store.activeId).toBeNull();

    const radios = container.querySelectorAll<HTMLInputElement>("[data-provider-active]");
    expect(radios).toHaveLength(2);
    radios[1]!.click();
    await nextTick();
    expect(store.activeId).toBe(P2.id);
    expect(store.active).toEqual(P2);

    radios[0]!.click();
    await nextTick();
    expect(store.activeId).toBe(P1.id);
  });

  it("编辑:data-provider-edit 改 model 保存 → 行内文本更新且不新增", async () => {
    const { container, store } = await mountSettings({ providers: [P1] });

    container.querySelector<HTMLButtonElement>("[data-provider-edit]")!.click();
    await nextTick();
    const model = container.querySelector<HTMLInputElement>("[data-provider-model]")!;
    expect(model.value).toBe(P1.model);
    setInput(model, "updated-model");
    await nextTick();

    container.querySelector<HTMLButtonElement>("[data-provider-save]")!.click();
    await nextTick();

    expect(store.providers).toHaveLength(1);
    expect(store.providers[0]!.id).toBe(P1.id);
    expect(store.providers[0]!.model).toBe("updated-model");
    expect(container.querySelectorAll("[data-provider-row]")).toHaveLength(1);
    expect(container.querySelector("[data-provider-row]")!.textContent).toContain("updated-model");
  });

  // Fix wave 2:删除前二次确认(取消 → 不删;确认 → 删)
  it("删除:confirm 取消 → 不删;确认 → 行消失", async () => {
    const { container, store } = await mountSettings({ providers: [P1, P2] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      container.querySelectorAll<HTMLButtonElement>("[data-provider-delete]")[0]!.click();
      await nextTick();
      expect(confirm).toHaveBeenCalledWith(`删除服务商「${P1.name}」?(未开启云同步时其密钥将永久丢失)`);
      expect(store.providers.map((p) => p.id)).toEqual([P1.id, P2.id]);

      confirm.mockReturnValue(true);
      container.querySelectorAll<HTMLButtonElement>("[data-provider-delete]")[0]!.click();
      await nextTick();
      expect(store.providers.map((p) => p.id)).toEqual([P2.id]);
      const rows = container.querySelectorAll("[data-provider-row]");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain(P2.name);
    } finally {
      confirm.mockRestore();
    }
  });

  it("密钥云同步开关:切换 → store.syncKeys 变更 + 警示文案出现/消失", async () => {
    const { container, store } = await mountSettings();
    expect(container.textContent).not.toContain("密钥将写入你的 D1 数据库");

    const box = container.querySelector<HTMLInputElement>("[data-sync-keys]")!;
    box.click();
    await nextTick();
    expect(store.syncKeys).toBe(true);
    expect(container.textContent).toContain("密钥将写入你的 D1 数据库,请确认部署环境可信");

    box.click();
    await nextTick();
    expect(store.syncKeys).toBe(false);
    expect(container.textContent).not.toContain("密钥将写入你的 D1 数据库");
  });

  it("无效 baseUrl(ftp://x):错误文案出现且保存被挡(不新增)", async () => {
    const { container, store } = await mountSettings();

    container.querySelector<HTMLButtonElement>("[data-new-provider]")!.click();
    await nextTick();
    setInput(container.querySelector<HTMLInputElement>("[data-provider-model]")!, "m");
    setInput(container.querySelector<HTMLInputElement>("[data-provider-baseurl]")!, "ftp://x");
    await nextTick();

    const error = container.querySelector("[data-provider-error]");
    expect(error).toBeTruthy();
    expect(error!.textContent).toContain("baseUrl 需为 http(s) 地址");
    const save = container.querySelector<HTMLButtonElement>("[data-provider-save]")!;
    expect(save.disabled).toBe(true);
    save.click();
    await nextTick();
    expect(store.providers).toHaveLength(0);
    expect(container.querySelector("[data-provider-row]")).toBeNull();
  });

  // 控制者追加:服务商 20 上限的入口反馈(sanitize 侧已在 20 截断,此处挡在新增入口并提示)
  it("服务商满 20:data-new-provider 置灰并提示上限;删回 19 恢复可用", async () => {
    const many: AiProvider[] = Array.from({ length: 20 }, (_, i) => ({
      id: `ai_${i}`,
      name: `服务商${i}`,
      baseUrl: `https://p${i}.example.com/v1`,
      model: `m${i}`,
      useProxy: false,
    }));
    const { container, store } = await mountSettings({ providers: many });

    const btn = container.querySelector<HTMLButtonElement>("[data-new-provider]")!;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toContain("最多 20 个服务商");
    btn.click();
    await nextTick();
    expect(container.querySelector("[data-provider-preset]")).toBeNull(); // 已置灰:点击不打开编辑器

    store.providers = store.providers.slice(0, 19);
    await nextTick();
    expect(btn.disabled).toBe(false);
    expect(container.textContent).not.toContain("最多 20 个服务商");
  });

  it("侧栏入口:点「设置」→ 路由到 /settings", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: { template: "<div>inbox</div>" } },
        { path: "/settings", component: Settings },
      ],
    });
    await router.push("/");
    await router.isReady();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const pinia = createPinia();
    setActivePinia(pinia);
    const app = createApp(Sidebar);
    app.use(pinia);
    app.use(router);
    app.mount(container);
    mounted = { app, container };
    await flush();

    const entry = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "设置");
    expect(entry).toBeTruthy();
    entry!.click();
    await flush();
    expect(router.currentRoute.value.path).toBe("/settings");
  });

  it("订阅数据:导入 OPML 后标记列表失效并给出结果", async () => {
    const { container } = await mountSettings(); // 内部 setActivePinia,之后才可用 store
    const articles = useArticlesStore();
    expect(articles.stale).toBe(false);

    const input = container.querySelector<HTMLInputElement>("[data-opml-import]");
    expect(input).toBeTruthy();
    // jsdom 未实现 Blob.prototype.text();按组件消费面桩最小 File(text() 返回 OPML 文本)
    const file = { name: "readly.opml", text: async () => OPML } as unknown as File;
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();

    // 1 分类(1 源)+ 1 未分类源
    expect(container.textContent).toContain("导入完成:成功 2 个源");
    expect(useArticlesStore().stale).toBe(true);
  });

  it("订阅数据:点导出触发 Blob 下载", async () => {
    const createUrl = vi.fn(() => "blob:mock");
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createUrl, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeUrl, configurable: true, writable: true });
    try {
      const { container } = await mountSettings();
      container.querySelector<HTMLButtonElement>("[data-opml-export]")!.click();
      await flush();
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(revokeUrl).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("帮助:点「查看快捷键」在设置页打开浮层(宿主自挂)", async () => {
    const { container } = await mountSettings();
    expect(container.querySelector("[data-shortcut-help]")).toBeNull();
    container.querySelector<HTMLButtonElement>("[data-shortcut-help-open]")!.click();
    await flush();
    expect(useShortcutHelp().showShortcutHelp.value).toBe(true);
    expect(container.querySelector("[data-shortcut-help]")).not.toBeNull();
    useShortcutHelp().closeShortcutHelp(); // 复位单例,避免外溢
  });
});
