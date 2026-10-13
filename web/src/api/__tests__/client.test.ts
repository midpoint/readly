import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, clearToken, getToken, setToken, TOKEN_KEY } from "@/api/client";

describe("api client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("附带 Bearer 令牌", async () => {
    setToken("tok");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/api/health");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("401 清除令牌并派发事件", async () => {
    setToken("tok");
    const events: string[] = [];
    window.addEventListener("readly:unauthorized", () => events.push("fired"), { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(api("/api/health")).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(events).toEqual(["fired"]);
  });

  it("错误体规整为 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "bad", message: "出错了" } }), { status: 400 })
      )
    );
    try {
      await api("/api/x");
      expect.unreachable();
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe("bad");
      expect(err.message).toBe("出错了");
      expect(err.status).toBe(400);
    }
  });

  it("query 参数拼接且跳过 undefined", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/api/articles", { query: { view: "unread", cursor: undefined } });
    const called = fetchMock.mock.calls[0]![0] as string;
    expect(called).toContain("view=unread");
    expect(called).not.toContain("cursor");
  });
});
