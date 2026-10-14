import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READER_PREFS } from "@readly/shared";
import { api } from "@/api/client";
import { sanitizeFetchPrefs, sanitizePrefs, useSettingsStore } from "@/stores/settings";

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
    expect(p.unreadOnly).toBe(false);
    expect(p.collapsedCategoryIds).toEqual([]);
  });
  it("collapsedCategoryIds 去重、过滤非整数、缺省为空", () => {
    expect(sanitizePrefs({ collapsedCategoryIds: [3, 3, 7, "x", 2.5, null] }).collapsedCategoryIds).toEqual([3, 7]);
    expect(sanitizePrefs({}).collapsedCategoryIds).toEqual([]);
    expect(sanitizePrefs({ collapsedCategoryIds: "junk" }).collapsedCategoryIds).toEqual([]);
  });
  it("非对象输入返回完整默认值", () => {
    expect(sanitizePrefs("junk")).toEqual(DEFAULT_READER_PREFS);
    expect(sanitizePrefs(null)).toEqual(DEFAULT_READER_PREFS);
  });
  it("保留合法自定义值", () => {
    const p = sanitizePrefs({ accent: "#22c55e", readingTheme: "night", fontSize: 19, autoMarkReadOnScroll: false, unreadOnly: true });
    expect(p.accent).toBe("#22c55e");
    expect(p.readingTheme).toBe("night");
    expect(p.fontSize).toBe(19);
    expect(p.autoMarkReadOnScroll).toBe(false);
    expect(p.unreadOnly).toBe(true);
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
    // 本地「全有」(阅读 + 抓取偏好都在)才短路零请求:两把键都要 seed
    localStorage.setItem("readly_fetch_prefs", JSON.stringify({ auto: true, minChars: 300 }));
    vi.mocked(api).mockResolvedValue({ reader_prefs: { ...DEFAULT_READER_PREFS, readingTheme: "sepia" } });
    const store = useSettingsStore();
    store.initLocal();
    await store.initRemote();
    expect(store.prefs.readingTheme).toBe("night");
    await vi.advanceTimersByTimeAsync(1100);
    expect(vi.mocked(api)).not.toHaveBeenCalled();
  });

  it("initRemote:GET 在途期间本地被写入 → 服务端值不覆盖", async () => {
    let resolveApi!: (v: unknown) => void;
    const pending = new Promise((res) => {
      resolveApi = res;
    });
    vi.mocked(api).mockReturnValue(pending);
    const store = useSettingsStore();
    store.initLocal(); // 无本地偏好:进入拉取路径
    const inflight = store.initRemote(); // 不 await:GET 在途
    store.updatePrefs({ fontSize: 21 }); // 在途期间写入本地(prev 值不同于默认)
    resolveApi({ reader_prefs: { ...DEFAULT_READER_PREFS, themeMode: "dark", readingTheme: "night" } });
    await inflight;
    // 本地写入为真源:服务端快照不得覆盖(夜间主题与主题模式都不生效)
    expect(store.prefs.readingTheme).toBe("classic");
    expect(store.prefs.themeMode).toBe(DEFAULT_READER_PREFS.themeMode);
    expect(store.prefs.fontSize).toBe(21);
    expect(document.documentElement.dataset.readingTheme).toBe("classic");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
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

describe("fetchPrefs 切片", () => {
  it("sanitizeFetchPrefs:缺省 true/300,阈值钳制 [50,5000]", () => {
    expect(sanitizeFetchPrefs({})).toEqual({ auto: true, minChars: 300 });
    expect(sanitizeFetchPrefs({ auto: false, minChars: 1 })).toEqual({ auto: false, minChars: 50 });
    expect(sanitizeFetchPrefs({ minChars: 99999 })).toEqual({ auto: true, minChars: 5000 });
    expect(sanitizeFetchPrefs("junk")).toEqual({ auto: true, minChars: 300 });
  });

  it("本地无 fetch 偏好时 initRemote 采用服务端 fetch_prefs", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify(DEFAULT_READER_PREFS)); // 仅本地有阅读偏好
    vi.mocked(api).mockResolvedValue({ fetch_prefs: { auto: false, minChars: 500 } });
    const store = useSettingsStore();
    store.initLocal();
    await store.initRemote();
    expect(store.fetchPrefs).toEqual({ auto: false, minChars: 500 });
  });

  it("resetPrefs 同时恢复抓取偏好", () => {
    const store = useSettingsStore();
    store.initLocal();
    store.updateFetchPrefs({ auto: false, minChars: 900 });
    store.resetPrefs();
    expect(store.fetchPrefs).toEqual({ auto: true, minChars: 300 });
    expect(JSON.parse(localStorage.getItem("readly_fetch_prefs")!).minChars).toBe(300);
  });

  it("updateFetchPrefs 写本地并防抖推送(与阅读偏好同一 PUT 双键)", async () => {
    vi.mocked(api).mockResolvedValue({ ok: true });
    const store = useSettingsStore();
    store.initLocal();
    store.updateFetchPrefs({ minChars: 800 });
    expect(JSON.parse(localStorage.getItem("readly_fetch_prefs")!).minChars).toBe(800);
    await vi.advanceTimersByTimeAsync(1100);
    const call = vi.mocked(api).mock.calls.at(-1)!;
    expect(call[0]).toBe("/api/settings");
    const kv = (call[1]!.body as { kv: Record<string, unknown> }).kv;
    expect(kv.reader_prefs).toBeDefined();
    expect((kv.fetch_prefs as { minChars: number }).minChars).toBe(800);
  });
});
