import { describe, expect, it } from "vitest";
import { parseSseStream } from "@/modules/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of parseSseStream(s)) out.push(d);
  return out;
}

describe("parseSseStream", () => {
  it("解析 data 行、跳过 [DONE]、忽略非 data 行", async () => {
    const got = await collect(streamOf(["data: {\"a\":1}\n\n", "event: ping\n", "data: [DONE]\n\n"]));
    expect(got).toEqual(['{"a":1}']);
  });
  it("跨 chunk 拆行安全", async () => {
    const got = await collect(streamOf(["data: {\"a\"", ":1}\n\ndata: x\n\n"]));
    expect(got).toEqual(['{"a":1}', "x"]);
  });
  it("\\r\\n 行尾兼容", async () => {
    const got = await collect(streamOf(["data: a\r\ndata: b\r\n"]));
    expect(got).toEqual(["a", "b"]);
  });
});
