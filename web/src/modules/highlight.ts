import type { KeywordRule } from "@readly/shared";
import { findMatchRanges, isRuleValid, type MatchRange } from "./keywords";

/**
 * 在已清洗(经 sanitize)的 DOM 上为关键词命中包裹 <mark>。
 * 只操作文本节点(TreeWalker + createElement),不产生任何 innerHTML 注入;
 * 已有 <mark> 内的文本不参与匹配(避免二次包裹/自嵌套)。
 * 返回实际插入的标记数(上限 maxMarks)。
 */
export function highlightMatchesIn(
  root: HTMLElement,
  rules: KeywordRule[],
  opts: { maxMarks?: number } = {}
): number {
  const maxMarks = opts.maxMarks ?? 300;
  const active = rules.filter((r) => r.enabled && isRuleValid(r));
  if (active.length === 0) return 0;

  // 收集文本节点(TreeWalker;跳过 mark/script/style 内部)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        const tag = el.tagName.toLowerCase();
        if (tag === "mark" || tag === "script" || tag === "style") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  let marks = 0;
  for (const textNode of textNodes) {
    if (marks >= maxMarks) break;
    const text = textNode.nodeValue ?? "";
    type Hit = MatchRange & { rule: KeywordRule };
    const hits: Hit[] = [];
    for (const rule of active) {
      for (const r of findMatchRanges(text, rule)) hits.push({ ...r, rule });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    // 去重叠(先到先得,起点相同时长优先)
    const picked: Hit[] = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start < cursor) continue;
      picked.push(h);
      cursor = h.end;
      if (marks + picked.length >= maxMarks) break;
    }
    if (picked.length === 0) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const h of picked) {
      if (h.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, h.start)));
      const mark = document.createElement("mark");
      mark.dataset.ruleId = h.rule.id;
      mark.style.backgroundColor = `${h.rule.color}33`;
      mark.style.color = "inherit";
      mark.style.borderRadius = "2px";
      mark.textContent = text.slice(h.start, h.end);
      frag.appendChild(mark);
      pos = h.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    textNode.parentNode?.replaceChild(frag, textNode);
    marks += picked.length;
  }
  return marks;
}
