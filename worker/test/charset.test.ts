import { describe, expect, it } from "vitest";
import { decodeWithCharset } from "../src/lib/charset";

// GBK 字节:吾爱破解;UTF-8 字节:你好;utf-16le(无 BOM):你
const GBK_WUAI = new Uint8Array([0xce, 0xe1, 0xb0, 0xae, 0xc6, 0xc6, 0xbd, 0xe2]);
const UTF8_NIHAO = new TextEncoder().encode("你好");
const DECL_GBK = new TextEncoder().encode(`<?xml version="1.0" encoding="gbk"?><rss><channel><title>`);
const DECL_GBK_MERGED = (() => {
  const bytes = new Uint8Array(DECL_GBK.byteLength + GBK_WUAI.byteLength);
  bytes.set(DECL_GBK, 0);
  bytes.set(GBK_WUAI, DECL_GBK.byteLength);
  return bytes;
})();

describe("decodeWithCharset", () => {
  it("Content-Type 声明 charset=gbk 时按 GBK 解码", () => {
    expect(decodeWithCharset(GBK_WUAI, "application/xml; charset=gbk")).toBe("吾爱破解");
    expect(decodeWithCharset(GBK_WUAI, "application/xml; charset=gb2312")).toBe("吾爱破解");
    expect(decodeWithCharset(GBK_WUAI, 'application/xml; charset="gb18030"')).toBe("吾爱破解");
  });

  it("头无 charset 时嗅探 XML 声明的 encoding", () => {
    expect(decodeWithCharset(DECL_GBK_MERGED, "application/xml")).toContain("吾爱破解");
    expect(decodeWithCharset(DECL_GBK_MERGED, null)).toContain("吾爱破解");
  });

  it("头与声明冲突时以头为准(RFC 7303 charset 参数优先)", () => {
    // 声明说 gbk,但头说 utf-8,字节是 UTF-8 → 按头解,得到正确中文而非乱码
    const xml = new TextEncoder().encode(`<?xml version="1.0" encoding="gbk"?>你好`);
    expect(decodeWithCharset(xml, "application/xml; charset=utf-8")).toContain("你好");
  });

  it("BOM 探测:utf-8 BOM 与 utf-16le BOM", () => {
    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...UTF8_NIHAO]);
    expect(decodeWithCharset(utf8Bom, null)).toBe("你好");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x60, 0x4f]); // 「你」utf-16le
    expect(decodeWithCharset(utf16, null)).toBe("你");
  });

  it("未知编码名回落 UTF-8(既有行为)", () => {
    expect(decodeWithCharset(UTF8_NIHAO, "text/html; charset=x-mystery")).toBe("你好");
  });

  it("头 charset 标签不被支持时级联到 XML 声明,而非直落 UTF-8", () => {
    // x-mystery 不被支持 → 级联到声明里的 gbk → 正确解出中文;
    // 若实现退化为「不支持直接落 UTF-8」,此断言会得到乱码而失败
    expect(decodeWithCharset(DECL_GBK_MERGED, "application/xml; charset=x-mystery")).toContain("吾爱破解");
  });

  it("无任何线索时按 UTF-8", () => {
    expect(decodeWithCharset(UTF8_NIHAO, "application/xml")).toBe("你好");
  });
});
