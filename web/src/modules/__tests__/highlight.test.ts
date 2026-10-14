// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { KeywordRule } from "@readly/shared";
import { highlightMatchesIn } from "@/modules/highlight";

function rule(p: Partial<KeywordRule>): KeywordRule {
  return { id: "r1", name: "R", keyword: "openai", isRegex: false, caseSensitive: false, color: "#ef4444", enabled: true, ...p };
}
function doc(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("highlightMatchesIn", () => {
  it("跨文本节点命中被 mark 包裹,带 data-rule-id 与颜色", () => {
    const root = doc("<p>OpenAI 与 <b>openai</b></p>");
    const n = highlightMatchesIn(root, [rule({})]);
    expect(n).toBe(2);
    const marks = root.querySelectorAll("mark[data-rule-id='r1']");
    expect(marks).toHaveLength(2);
    expect((marks[0] as HTMLElement).style.backgroundColor).toBeTruthy();
  });
  it("不进入已有 mark / 禁用规则不生效 / 无效规则不生效", () => {
    const root = doc("<p>openai <mark>openai</mark></p>");
    highlightMatchesIn(root, [rule({}), rule({ id: "r2", keyword: "openai", enabled: false }), rule({ id: "r3", keyword: "([", isRegex: true })]);
    expect(root.querySelectorAll("mark[data-rule-id='r2']")).toHaveLength(0);
    expect(root.querySelectorAll("mark[data-rule-id='r3']")).toHaveLength(0);
    // 原 mark 内的文本不被二次包裹
    expect(root.querySelectorAll("mark mark")).toHaveLength(0);
  });
  it("maxMarks 上限", () => {
    const root = doc("<p>" + "openai ".repeat(20) + "</p>");
    const n = highlightMatchesIn(root, [rule({})], { maxMarks: 5 });
    expect(n).toBe(5);
  });
  // 执行期发现:正则的匹配长度不能按关键词长度反推(如 lookbehind 在切片后会丢失上下文),
  // 必须以 matchAll 实际区间为准——否则这类规则的正文高亮数与列表命中数不一致。
  it("正则规则:命中区间以实际匹配长度为准(lookbehind 不受影响)", () => {
    const root = doc("<p>@alice 你好</p>");
    const n = highlightMatchesIn(root, [rule({ id: "r9", keyword: "(?<=@)\\w+", isRegex: true })]);
    expect(n).toBe(1);
    expect(root.querySelector("mark[data-rule-id='r9']")?.textContent).toBe("alice");
  });
  it("幂等:重复 apply 先清旧 mark 再包裹,换色后为规则新颜色(不叠加)", () => {
    const root = doc("<p>openai 你好</p>");
    highlightMatchesIn(root, [rule({ color: "#ef4444" })]);
    expect(root.querySelectorAll("mark[data-rule-id='r1']")).toHaveLength(1);
    const oldBg = (root.querySelector("mark[data-rule-id='r1']") as HTMLElement).style.backgroundColor;

    highlightMatchesIn(root, [rule({ color: "#22c55e" })]);
    const marks = root.querySelectorAll("mark[data-rule-id='r1']");
    expect(marks).toHaveLength(1); // 不叠加
    const probe = document.createElement("mark");
    probe.style.backgroundColor = "#22c55e33"; // 与实现同一赋值路径,消解序列化差异
    expect((marks[0] as HTMLElement).style.backgroundColor).toBe(probe.style.backgroundColor);
    expect((marks[0] as HTMLElement).style.backgroundColor).not.toBe(oldBg);
  });
  it("幂等:空规则 apply 清空本函数旧 mark,普通 <mark> 不受影响", () => {
    const root = doc("<p>openai 与 openai</p><p><mark>原生标记</mark></p>");
    const n = highlightMatchesIn(root, [rule({})]);
    expect(n).toBe(2);
    expect(root.querySelectorAll("mark[data-rule-id]")).toHaveLength(2);

    const cleared = highlightMatchesIn(root, []);
    expect(cleared).toBe(0);
    expect(root.querySelectorAll("mark[data-rule-id]")).toHaveLength(0);
    expect(root.querySelectorAll("mark")).toHaveLength(1); // 普通 mark 保留
    expect(root.textContent).toContain("openai 与 openai");
    expect(root.textContent).toContain("原生标记");
  });
});
