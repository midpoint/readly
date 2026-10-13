import { describe, expect, it, vi } from "vitest";
import { fetchText } from "../src/lib/http";

function resp(body: string, init: ResponseInit = {}) {
  return new Response(body, init);
}

describe("fetchText", () => {
  it("正常抓取 200 并带 UA", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp("<rss/>", { status: 200 }));
    const r = await fetchText("https://example.com/feed", {}, fetchMock as unknown as typeof fetch);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<rss/>");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("Readly/");
    expect(init.redirect).toBe("manual");
  });

  it("跟随相对重定向并更新 finalUrl", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp("", { status: 302, headers: { Location: "/next" } }))
      .mockResolvedValueOnce(resp("ok", { status: 200 }));
    const r = await fetchText("https://example.com/a", {}, fetchMock as unknown as typeof fetch);
    expect(r.finalUrl).toBe("https://example.com/next");
    expect(r.body).toBe("ok");
  });

  it("重定向到私网被拒", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp("", { status: 302, headers: { Location: "http://127.0.0.1/x" } }));
    await expect(fetchText("https://example.com/a", {}, fetchMock as unknown as typeof fetch)).rejects.toThrow(/内网/);
  });

  it("超过 5 跳报错", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp("", { status: 302, headers: { Location: "https://example.com/loop" } }));
    await expect(fetchText("https://example.com/a", {}, fetchMock as unknown as typeof fetch)).rejects.toThrow(/重定向/);
  });

  it("超过 maxBytes 截断", async () => {
    const big = "x".repeat(1000);
    const fetchMock = vi.fn().mockResolvedValue(resp(big, { status: 200 }));
    const r = await fetchText("https://example.com/a", { maxBytes: 100 }, fetchMock as unknown as typeof fetch);
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(100);
  });

  it("超时中止", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    await expect(fetchText("https://example.com/slow", { timeoutMs: 20 }, fetchMock as unknown as typeof fetch)).rejects.toThrow(/超时/);
  });
});
