// 取一行中的 data 载荷;非 data 行、空载荷与 [DONE] 一律跳过(返回 null)
function payloadOf(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  return data && data !== "[DONE]" ? data : null;
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        const data = payloadOf(line);
        if (data !== null) yield data;
      }
    }
    // 流尾 flush:补解码残字节,并处理不带换行结尾的最后一帧(不丢)
    buffer += decoder.decode();
    const data = payloadOf(buffer.replace(/\r$/, ""));
    if (data !== null) yield data;
  } finally {
    // 消费者提前 break:释放底层流(错误自吞,收尾不得抛出/挂起)
    void reader.cancel().catch(() => undefined);
  }
}
