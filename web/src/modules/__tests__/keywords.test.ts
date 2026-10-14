// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { KeywordRule } from "@readly/shared";
import { findMatches, htmlToText, isRuleValid, matchDocs, MAX_MATCHES_PER_RULE } from "@/modules/keywords";

function rule(patch: Partial<KeywordRule>): KeywordRule {
  return { id: "r1", name: "测试", keyword: "", isRegex: false, caseSensitive: false, color: "#3b82f6", enabled: true, ...patch };
}

describe("isRuleValid", () => {
  it("空关键词无效;无效正则无效;正常规则有效", () => {
    expect(isRuleValid(rule({ keyword: "  " }))).toBe(false);
    expect(isRuleValid(rule({ keyword: "([", isRegex: true }))).toBe(false);
    expect(isRuleValid(rule({ keyword: "AI", isRegex: true }))).toBe(true);
  });
});

describe("findMatches", () => {
  it("普通词默认不区分大小写,返回全部命中起点", () => {
    expect(findMatches("OpenAI 与 openai 都在", rule({ keyword: "openai" }))).toEqual([0, 9]);
  });
  it("caseSensitive 时区分大小写", () => {
    expect(findMatches("OpenAI openai", rule({ keyword: "OpenAI", caseSensitive: true }))).toEqual([0]);
  });
  it("正则规则工作;零长度匹配被跳过不死循环", () => {
    expect(findMatches("A1B2C3", rule({ keyword: "\\d", isRegex: true }))).toEqual([1, 3, 5]);
    expect(findMatches("abc", rule({ keyword: "(?:)", isRegex: true }))).toEqual([]);
  });
  it("上限 200 处", () => {
    expect(findMatches("a".repeat(500), rule({ keyword: "a" }))).toHaveLength(MAX_MATCHES_PER_RULE);
  });
  it("无效规则返回空", () => {
    expect(findMatches("x", rule({ keyword: "([" , isRegex: true }))).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("去标签、折叠空白、截断 20000", () => {
    expect(htmlToText("<p>你好</p>\n<p>世界</p>")).toBe("你好 世界");
    expect(htmlToText("<b>" + "字".repeat(30000) + "</b>")).toHaveLength(20000);
    expect(htmlToText(null)).toBe("");
  });
});

describe("matchDocs", () => {
  it("按规则统计每篇命中次数,禁用/无效规则不入结果", () => {
    const docs = [
      { id: 1, title: "OpenAI 发布新模型", text: "openai 生态继续扩张" },
      { id: 2, title: "无关新闻", text: "天气" },
    ];
    const rules = [
      rule({ id: "r1", keyword: "openai" }),
      rule({ id: "r2", keyword: "AI", isRegex: false, enabled: false }),
      rule({ id: "r3", keyword: "([", isRegex: true }),
    ];
    const res = matchDocs(docs, rules);
    expect(res.matches).toEqual([{ articleId: 1, ruleId: "r1", count: 2 }]);
    expect(res.invalidRuleIds).toEqual(["r3"]);
  });
});
