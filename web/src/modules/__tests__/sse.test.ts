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

// 不主动 close 的流:用于验证提前 break 时底层流被 cancel 释放
function openStreamOf(chunks: string[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
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

  // 控制者追加 1:消费者提前 break 时必须收尾(释放底层流),且不得挂起
  it("提前 break:正常收尾、不挂起,并 cancel 底层流", async () => {
    const { stream, cancelled } = openStreamOf(['data: a\n\n', 'data: b\n\n', 'data: c\n\n']);
    const got: string[] = [];
    const consume = (async () => {
      for await (const d of parseSseStream(stream)) {
        got.push(d);
        break;
      }
    })();
    // 与超时赛跑:若收尾挂起(未释放 reader),timeout 分支胜出 → 断言失败
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
    await expect(Promise.race([consume.then(() => "done" as const), timeout])).resolves.toBe("done");
    expect(got).toEqual(["a"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled()).toBe(true);
  });

  // 控制者追加 2:流尾 final flush——不带换行结尾的最后一帧不丢
  it("流尾无换行:最后一帧仍被产出(flush)", async () => {
    expect(await collect(streamOf(["data: a\n\n", 'data: {"b":1}']))).toEqual(["a", '{"b":1}']);
    expect(await collect(streamOf(["data: a\n\n", "data: [DONE]"]))).toEqual(["a"]);
    expect(await collect(streamOf(["data: a\r"]))).toEqual(["a"]);
  });
});
