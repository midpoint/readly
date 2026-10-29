import { describe, expect, it } from "vitest";
import {
  READ_TAG,
  READING_LIST,
  STARRED_TAG,
  decodeCursor,
  deriveToken,
  encodeCursor,
  isoFromTimestampParam,
  isoFromUnix,
  longItemId,
  parseItemId,
  parseIntParam,
  toGReaderItem,
  unixSeconds,
  type GReaderItemRow,
} from "../src/lib/greader";

describe("parseItemId", () => {
  it("解析长格式、16 位 hex、十进制", () => {
    expect(parseItemId("tag:google.com,2005:reader/item/000000000000002a")).toBe(42);
    expect(parseItemId("000000000000002a")).toBe(42);
    expect(parseItemId("42")).toBe(42);
    // 16 位十进制 ID 无前导 0,按十进制处理
    expect(parseItemId("1746307865812560")).toBe(1746307865812560);
    // Reeder 会回传 16 位左补零的无前缀 hex;有前导 0 时按 hex 处理
    expect(parseItemId("0000000000000010")).toBe(16);
    expect(parseItemId("000000000000001f")).toBe(31);
  });
  it("非法/非正返回 null", () => {
    expect(parseItemId("")).toBeNull();
    expect(parseItemId("abc")).toBeNull();
    expect(parseItemId("0")).toBeNull();
    expect(parseItemId("-1")).toBeNull();
    expect(parseItemId("tag:google.com,2005:reader/item/zz")).toBeNull();
  });
});

describe("longItemId", () => {
  it("16 位小写 hex 左补零", () => {
    expect(longItemId(42)).toBe("tag:google.com,2005:reader/item/000000000000002a");
    expect(longItemId(31)).toBe("tag:google.com,2005:reader/item/000000000000001f");
  });
});

describe("cursor", () => {
  it("往返", () => {
    const cursor = encodeCursor("2026-10-01T00:00:01.000Z", 7);
    expect(decodeCursor(cursor)).toEqual({ publishedAt: "2026-10-01T00:00:01.000Z", id: 7 });
  });
  it("非法返回 null", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    const bad = btoa(JSON.stringify({ p: "nope", id: 1 })).replace(/=+$/, "");
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe("deriveToken", () => {
  it("sha256(username:password)", async () => {
    expect(await deriveToken({ username: "readly", password: "secret" })).toBe(
      "readly/1eacdaa8570b440467416a15bc1c48300bab00f75cd582e2f8de265317c1c5df"
    );
  });
});

describe("时间与数字参数", () => {
  it("unixSeconds", () => {
    expect(unixSeconds("2026-10-01T00:00:01.000Z")).toBe(1790812801);
    expect(unixSeconds(null)).toBe(0);
    expect(unixSeconds("nope")).toBe(0);
  });
  it("isoFromUnix 拒绝非法范围", () => {
    expect(isoFromUnix(1790812801)).toBe("2026-10-01T00:00:01.000Z");
    expect(isoFromUnix(0)).toBeNull();
    expect(isoFromUnix(1e18)).toBeNull();
  });
  it("isoFromTimestampParam 接受秒、毫秒、微秒", () => {
    expect(isoFromTimestampParam("1790812801")).toBe("2026-10-01T00:00:01.000Z");
    expect(isoFromTimestampParam("1790812801123")).toBe("2026-10-01T00:00:01.123Z");
    expect(isoFromTimestampParam("1790812801123456")).toBe("2026-10-01T00:00:01.123Z");
    expect(isoFromTimestampParam(undefined)).toBeNull();
    expect(isoFromTimestampParam("0")).toBeNull();
    expect(isoFromTimestampParam("abc")).toBeNull();
    expect(isoFromTimestampParam("1e18")).toBeNull();
  });
  it("parseIntParam 截断与钳制", () => {
    expect(parseIntParam(undefined, 20, 1, 1000)).toBe(20);
    expect(parseIntParam("abc", 20, 1, 1000)).toBe(20);
    expect(parseIntParam("0", 20, 1, 1000)).toBe(1);
    expect(parseIntParam("5000", 20, 1, 1000)).toBe(1000);
    expect(parseIntParam("7.9", 20, 1, 1000)).toBe(7);
  });
});

describe("toGReaderItem", () => {
  const base: GReaderItemRow = {
    id: 42,
    feed_id: 3,
    feed_title: "源标题",
    feed_site_url: "https://site.example.com",
    category_name: "科技",
    title: "文章标题",
    author: null,
    url: "https://site.example.com/post",
    published_at: "2026-10-01T00:00:01.000Z",
    excerpt: "摘要",
    content: "<p>正文</p>",
    content_full: "<p>全文</p>",
    is_read: 1,
    is_starred: 1,
  };

  it("完整形状与标签", () => {
    expect(toGReaderItem(base)).toEqual({
      id: "tag:google.com,2005:reader/item/000000000000002a",
      title: "文章标题",
      author: "",
      published: 1790812801,
      updated: 1790812801,
      crawlTimeMsec: "1790812801000",
      timestampUsec: "1790812801000000",
      alternate: [{ href: "https://site.example.com/post", type: "text/html" }],
      canonical: [{ href: "https://site.example.com/post" }],
      summary: { direction: "ltr", content: "摘要" },
      content: { direction: "ltr", content: "<p>全文</p>" },
      categories: [READING_LIST, READ_TAG, STARRED_TAG, "user/-/label/科技"],
      origin: { streamId: "feed/3", title: "源标题", htmlUrl: "https://site.example.com" },
    });
  });

  it("content 回退顺序 content_full → content → excerpt", () => {
    const noFull = toGReaderItem({ ...base, content_full: null });
    expect((noFull.content as { content: string }).content).toBe("<p>正文</p>");
    const excerptOnly = toGReaderItem({ ...base, content_full: null, content: null });
    expect((excerptOnly.content as { content: string }).content).toBe("摘要");
  });

  it("未读未收藏无分类", () => {
    const item = toGReaderItem({ ...base, is_read: 0, is_starred: 0, category_name: null });
    expect(item.categories).toEqual([READING_LIST]);
  });
});
