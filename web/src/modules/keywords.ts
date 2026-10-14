import type { KeywordRule } from "@readly/shared";

export const MAX_MATCHES_PER_RULE = 200;
const MAX_TEXT_LENGTH = 20000;

export interface MatchDoc {
  id: number;
  title: string;
  text: string;
}

export interface KeywordsResult {
  matches: { articleId: number; ruleId: string; count: number }[];
  invalidRuleIds: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(rule: KeywordRule): RegExp | null {
  if (!rule.keyword.trim()) return null;
  try {
    if (rule.isRegex) {
      const re = new RegExp(rule.keyword, rule.caseSensitive ? "g" : "gi");
      // 显式探测零长度匹配(如 "(?:)"),避免扫描死循环
      if (re.test("")) return null;
      return re;
    }
    return new RegExp(escapeRegExp(rule.keyword), rule.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export function isRuleValid(rule: KeywordRule): boolean {
  return compile(rule) !== null;
}

export interface MatchRange {
  start: number;
  end: number;
}

// 命中区间以 matchAll 的实际匹配(含正则/lookbehind/大小写折叠)为准:
// 不能按关键词长度反推——切片后重匹配会丢失上下文(如 `(?<=@)\w+`)。
export function findMatchRanges(text: string, rule: KeywordRule): MatchRange[] {
  const re = compile(rule);
  if (!re) return [];
  const out: MatchRange[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) break;
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_MATCHES_PER_RULE) break;
  }
  return out;
}

export function findMatches(text: string, rule: KeywordRule): number[] {
  return findMatchRanges(text, rule).map((r) => r.start);
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

export function matchDocs(docs: MatchDoc[], rules: KeywordRule[]): KeywordsResult {
  const invalidRuleIds: string[] = [];
  const active: { rule: KeywordRule; re: RegExp }[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const re = compile(rule);
    if (!re) {
      invalidRuleIds.push(rule.id);
      continue;
    }
    active.push({ rule, re });
  }
  const matches: KeywordsResult["matches"] = [];
  for (const doc of docs) {
    const haystack = `${doc.title}\n${doc.text}`;
    for (const { rule, re } of active) {
      let count = 0;
      re.lastIndex = 0;
      for (const m of haystack.matchAll(re)) {
        if (m[0].length === 0) break;
        count++;
        if (count >= MAX_MATCHES_PER_RULE) break;
      }
      if (count > 0) matches.push({ articleId: doc.id, ruleId: rule.id, count });
    }
  }
  return { matches, invalidRuleIds };
}
