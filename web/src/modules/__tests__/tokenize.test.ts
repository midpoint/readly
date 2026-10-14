import { describe, expect, it } from "vitest";
import { tokenize } from "@/modules/tokenize";

describe("tokenize", () => {
  it("CJK 取字符二元组", () => {
    expect(tokenize("人工智能")).toEqual(["人工", "工智", "智能"]);
  });
  it("单字 CJK 保留自身", () => {
    expect(tokenize("雨")).toEqual(["雨"]);
  });
  it("拉丁词小写、长度≥3、过滤停用词", () => {
    const t = tokenize("The AI Model is a Big Deal");
    expect(t).toContain("model");
    expect(t).toContain("deal");
    expect(t).not.toContain("the");
    expect(t).not.toContain("ai"); // 长度 2
    expect(t).toContain("big"); // big 不在实现停用词表内 → 保留(确定性断言)
  });
  it("去 URL 与纯数字,中英混排并存", () => {
    const t = tokenize("访问 https://example.com/x 看到 GPT5 发布 12345");
    expect(t.join("|")).not.toContain("example");
    expect(t.join("|")).not.toContain("12345");
    expect(t).toContain("gpt5".slice(0, 0) + "发布"); // 中文二元组存在
    expect(t.some((x) => x.startsWith("gpt"))).toBe(true);
  });
  it("标点切断 CJK 连续段", () => {
    expect(tokenize("你好,世界")).toEqual(["你好", "世界"]);
  });
});
