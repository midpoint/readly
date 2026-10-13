import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, getToken } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.mocked(api).mockReset();
  });

  it("无令牌时 check 返回 false", async () => {
    const store = useAuthStore();
    expect(await store.check()).toBe(false);
    expect(store.valid).toBe(false);
  });

  it("login 成功保存令牌", async () => {
    vi.mocked(api).mockResolvedValue({ ok: true });
    const store = useAuthStore();
    expect(await store.login("tok")).toBe(true);
    expect(getToken()).toBe("tok");
  });

  it("login 失败清除令牌", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("unauthorized", "bad", 401));
    const store = useAuthStore();
    expect(await store.login("tok")).toBe(false);
    expect(getToken()).toBeNull();
  });
});
