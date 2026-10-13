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

  it("304 无 Location 直接返回不抛错", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const r = await fetchText("https://example.com/a", {}, fetchMock as unknown as typeof fetch);
    expect(r.status).toBe(304);
    expect(r.body).toBe("");
  });

  it("304 带 Location 也不跟随", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { Location: "/x" } }));
    const r = await fetchText("https://example.com/a", {}, fetchMock as unknown as typeof fetch);
    expect(r.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("超过 maxBytes 截断", async () => {
    const big = "x".repeat(1000);
    const fetchMock = vi.fn().mockResolvedValue(resp(big, { status: 200 }));
    const r = await fetchText("https://example.com/a", { maxBytes: 100 }, fetchMock as unknown as typeof fetch);
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(100);
  });

  it("正文阶段超时也映射为抓取超时", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation aborted due to timeout", "TimeoutError"));
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    await expect(fetchText("https://example.com/slow-body", { timeoutMs: 20 }, fetchMock as unknown as typeof fetch)).rejects.toThrow(/超时/);
  });

  it("畸形 Location 报错", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp("", { status: 302, headers: { Location: "https://" } }));
    await expect(fetchText("https://example.com/a", {}, fetchMock as unknown as typeof fetch)).rejects.toThrow(/重定向目标地址无效/);
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
