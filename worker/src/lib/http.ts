import { assertSafeUrl } from "./ssrf";

export const DEFAULT_UA = "Readly/1.0 (+self-hosted RSS reader)";

export interface FetchTextOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  accept?: string;
}

export interface FetchTextResult {
  status: number;
  headers: Headers;
  body: string;
  finalUrl: string;
  truncated: boolean;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { body: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength >= maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { body: new TextDecoder().decode(merged), truncated };
}

export async function fetchText(
  url: string,
  opts: FetchTextOptions = {},
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<FetchTextResult> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    ...(opts.accept ? { Accept: opts.accept } : {}),
    ...opts.headers,
  };

  let current = assertSafeUrl(url).toString();
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= 5; hop++) {
    let res: Response;
    try {
      res = await fetchFn(current, { method: "GET", headers, redirect: "manual", signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("抓取超时");
      if (e instanceof DOMException && e.name === "AbortError") throw new Error("抓取超时");
      throw new Error("网络请求失败");
    }
    // 304 是条件请求的直接响应而非重定向(RFC 9110 无 Location),按最终响应返回
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("Location");
      if (!location) throw new Error("重定向缺少目标地址");
      if (hop === 5) throw new Error("重定向次数过多");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error("重定向目标地址无效");
      }
      assertSafeUrl(next.toString());
      current = next.toString();
      continue;
    }
    let body: string;
    let truncated: boolean;
    try {
      ({ body, truncated } = await readCapped(res, maxBytes));
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new Error("抓取超时");
      throw e;
    }
    return { status: res.status, headers: res.headers, body, finalUrl: current, truncated };
  }
  throw new Error("重定向次数过多");
}
