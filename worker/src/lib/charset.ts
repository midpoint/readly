// 按字符集把原始字节解码为文本。优先级:Content-Type charset 参数(RFC 7303 优先)
// → XML 声明 encoding(GBK 源常不带头 charset,只在声明里写)→ BOM → UTF-8。
// workerd 的 TextDecoder 已实测支持 gbk/gb2312/gb18030/big5/utf-16 等;
// 某线索的标签不被支持时级联尝试下一线索,全部落空才回落 UTF-8。
export function decodeWithCharset(bytes: Uint8Array, contentType: string | null): string {
  for (const label of [contentTypeCharset(contentType), xmlDeclarationCharset(bytes), bomCharset(bytes)]) {
    if (!label) continue;
    if (label === "utf-8" || label === "utf8") return new TextDecoder("utf-8").decode(bytes);
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // 不支持的编码名:试下一线索
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function contentTypeCharset(contentType: string | null): string | null {
  const m = /charset=([^\s;]+)/i.exec(contentType ?? "");
  return m?.[1]?.replace(/["']/g, "").toLowerCase() ?? null;
}

// 只看前 256 字节的 ASCII 部分:XML 声明为纯 ASCII,非 ASCII 字节替换为占位符不参与匹配
function xmlDeclarationCharset(bytes: Uint8Array): string | null {
  const n = Math.min(bytes.byteLength, 256);
  let head = "";
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    head += b < 0x80 ? String.fromCharCode(b) : "�";
  }
  const m = /<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  return m?.[1]?.trim().toLowerCase() ?? null;
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}
