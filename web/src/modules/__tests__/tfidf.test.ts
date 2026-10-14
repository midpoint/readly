import { describe, expect, it } from "vitest";
import { buildTfIdf, cosine } from "@/modules/tfidf";

describe("tfidf", () => {
  it("罕见词权重大于常见词", () => {
    // fixture 调整:原 "苹果 苹果 香蕉" 使苹果 tf=2,其词频增益盖过 idf 差 → 断言不成立;
    // 改为同 tf(=1) 以匹配断言语义「同 tf 下罕见词权重更高」
    const [v] = buildTfIdf(["苹果 香蕉", "苹果 橙子"]);
    // 「香蕉」只出现在文档 0,「苹果」两文档都有 → 同 tf 下香蕉权重更高
    expect(v!.get("香蕉")!).toBeGreaterThan(v!.get("苹果")!);
  });
  it("向量 L2 归一化(自 cosine 为 1)", () => {
    const [a] = buildTfIdf(["重复 文本 内容 重复"]);
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);
  });
  it("无共享词余弦为 0", () => {
    const [a, b] = buildTfIdf(["苹果 香蕉", "汽车 轮胎"]);
    expect(cosine(a!, b!)).toBe(0);
  });
  it("正交向量(空 Map)安全", () => {
    expect(cosine(new Map(), new Map())).toBe(0);
  });
});
