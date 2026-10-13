import { SELF } from "cloudflare:test";

export function apiFetch(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`http://example.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: "Bearer test-token",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}
