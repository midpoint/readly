// @vitest-environment jsdom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEVER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { api } from "@/api/client";
import FeverSettings from "@/components/FeverSettings.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

let mounted: { app: App; container: HTMLElement } | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mount(setting?: unknown, reject = false): Promise<HTMLElement> {
  if (reject) {
    vi.mocked(api).mockRejectedValue(new Error("boom"));
  } else {
    vi.mocked(api).mockImplementation((path, opts) => {
      if (path === "/api/settings" && opts?.method === "PUT") return Promise.resolve({ ok: true });
      if (path === "/api/settings") return Promise.resolve({ [SETTING_KEYS.feverAuth]: setting ?? null });
      return Promise.resolve({});
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(FeverSettings);
  app.mount(container);
  mounted = { app, container };
  await flush();
  return container;
}

function putCalls(): Record<string, unknown>[] {
  return vi.mocked(api).mock.calls
    .filter(([path, opts]) => path === "/api/settings" && opts?.method === "PUT")
    .map(([, opts]) => (opts!.body as { kv: Record<string, unknown> }).kv);
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
  vi.restoreAllMocks();
});

describe("FeverSettings", () => {
  it("未启用 → 启用:PUT 精确契约并显示三项凭据", async () => {
    const container = await mount(null);
    expect(container.querySelector("[data-fever-enable]")).toBeTruthy();
    (container.querySelector("[data-fever-enable]") as HTMLButtonElement).click();
    await flush();

    const envelopes = putCalls();
    expect(envelopes).toHaveLength(1);
    const kv = envelopes[0]!;
    expect(Object.keys(kv)).toEqual([SETTING_KEYS.feverAuth]);
    const value = kv[SETTING_KEYS.feverAuth] as { username: string; password: string };
    expect(value.username).toBe(FEVER_USERNAME);
    expect(value.password).toMatch(/^[0-9a-f]{32}$/);

    expect((container.querySelector("[data-fever-endpoint]") as HTMLElement).textContent).toBe(
      `${location.origin}/fever/`
    );
    expect((container.querySelector("[data-fever-username]") as HTMLElement).textContent).toBe(FEVER_USERNAME);
    expect((container.querySelector("[data-fever-password]") as HTMLElement).textContent).toBe(value.password);
  });

  it("已有配置直接渲染", async () => {
    const container = await mount({ username: FEVER_USERNAME, password: "deadbeefdeadbeefdeadbeefdeadbeef" });
    expect((container.querySelector("[data-fever-password]") as HTMLElement).textContent).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(container.querySelector("[data-fever-enable]")).toBeNull();
  });

  it("重置生成新密码;停用写入 null 并回到未启用态", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = await mount({ username: FEVER_USERNAME, password: "deadbeefdeadbeefdeadbeefdeadbeef" });
    (container.querySelector("[data-fever-reset]") as HTMLButtonElement).click();
    await flush();
    const resetValue = putCalls()[0]![SETTING_KEYS.feverAuth] as { password: string };
    expect(resetValue.password).toMatch(/^[0-9a-f]{32}$/);
    expect(resetValue.password).not.toBe("deadbeefdeadbeefdeadbeefdeadbeef");

    (container.querySelector("[data-fever-disable]") as HTMLButtonElement).click();
    await flush();
    expect(putCalls()[1]![SETTING_KEYS.feverAuth]).toBeNull();
    expect(container.querySelector("[data-fever-enable]")).toBeTruthy();
  });

  it("复制按钮写入预期文本", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = await mount({ username: FEVER_USERNAME, password: "deadbeefdeadbeefdeadbeefdeadbeef" });
    (container.querySelector("[data-fever-copy-password]") as HTMLButtonElement).click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("deadbeefdeadbeefdeadbeefdeadbeef");
    expect((container.querySelector("[data-fever-message]") as HTMLElement).textContent).toContain("已复制");
  });

  it("加载失败显示提示", async () => {
    const container = await mount(undefined, true);
    await flush();
    expect(container.textContent).toContain("Fever 设置加载失败");
  });
});
