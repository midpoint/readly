import { Hono } from "hono";
import type { Env } from "../env";
import { fail, ok } from "../respond";
import { decodeWithCharset } from "../lib/charset";
import { fetchText, type FetchTextResult } from "../lib/http";

const proxy = new Hono<{ Bindings: Env }>();

const HTML_TYPES = ["text/html", "application/xhtml+xml"];

proxy.get("/proxy/html", async (c) => {
  const raw = c.req.query("url");
  if (!raw) return fail(c, 400, "invalid_url", "缺少 url 参数");
  let res: FetchTextResult;
  try {
    res = await fetchText(raw, {
      maxBytes: 3 * 1024 * 1024,
      timeoutMs: 20000,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    });
  } catch (e) {
    return fail(c, 400, "fetch_failed", e instanceof Error ? e.message : "抓取失败");
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(c, 502, "upstream_error", `抓取失败(HTTP ${res.status})`);
  }
  const ctype = (res.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!HTML_TYPES.includes(ctype)) return fail(c, 400, "unsupported_type", "该地址不是网页内容");
  const html = decodeWithCharset(res.buffer, res.headers.get("Content-Type"));
  if (!html.trim()) return fail(c, 502, "empty_body", "页面内容为空");
  return ok(c, { html, finalUrl: res.finalUrl, truncated: res.truncated });
});

export default proxy;
