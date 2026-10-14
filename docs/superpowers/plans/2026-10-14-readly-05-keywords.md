# Readly 关键词监控(计划 05 / M4b)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置关键词规则(普通词/正则、大小写、颜色),**全程在本地**对镜像文章匹配打标:文章列表显示命中色点、阅读器中命中词高亮、每条规则有详情页列出命中文章;规则集跨设备同步。

**Architecture:** 复用计划 04 的全部基建(镜像、`analysis` store、`analysis.worker.ts` 单例、fake-worker 测试 seam):匹配算法为纯模块 `keywords.ts`,命中计算在 worker 内运行后回传 `[{articleId, ruleId, count}]`;规则集作为 `analysis` store 的第二个持久化切片(`readly_keyword_rules` + D1 `keyword_rules`,与 `cluster_prefs` 同一防抖 PUT);高亮在渲染后的 DOM 上做文本节点包裹(不碰 `v-html` 清洗门)。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- **本地计算铁律**:`keywords.ts` 与 worker 同样零网络(提交前 grep 自证);命中计算只读镜像、结果不落 D1。
- 冻结类型:`KeywordRule { id; name; keyword; isRegex; caseSensitive; color; enabled }`、`SETTING_KEYS.keywordRules`(`"keyword_rules"`)——原样使用,不改 shared。
- 匹配口径:普通词=子串(默认不区分大小写;`caseSensitive` 时区分),空关键词无效;正则=`new RegExp(pattern, caseSensitive ? "g" : "gi")`,**编译失败即无效**(UI 标「正则无效」,不计入匹配);每篇每规则最多记 `MAX_MATCHES_PER_RULE = 200` 处;匹配范围=标题 + 正文纯文本(`htmlToText`,单篇文本截断 20000 字符以控制 worker 传输);规则上限 100 条。
- 高亮:只在**已清洗渲染**的 DOM 上包裹文本节点(`document.createElement("mark")`),不得使用 `innerHTML` 注入;命中标记带 `data-rule-id`,背景色=规则色 + `33` alpha;整篇高亮上限 300 处。
- 规则持久化:`readly_keyword_rules` 本地键 + D1 键 `keyword_rules`;本地优先、防抖 1000ms、失败静默;与 `cluster_prefs` **共用** `analysis` store 的 PUT(单次 `kv` 双键,各自 serverCopy 基线)。
- UI 文案中文;所有新增选择器(`[data-rule-row]`、`[data-rule-toggle]`、`[data-rule-edit]`、`[data-rule-delete]`、`[data-new-rule]`、`[data-rule-name]`、`[data-rule-keyword]`、`[data-rule-regex]`、`[data-rule-save]`、`[data-rule-error]`、`[data-hit-dot]`、`[data-matched-article]`、`[data-rule-detail]`)为测试与实测契约;深色配对;视觉验收必须实测(headless Chrome,独立端口 4699,勿动用户 5173/8787),浅色+深色两轮。
- TypeScript strict;禁止 any;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付;worker 测试前先 `pnpm build`。

---

### Task 1: 关键词匹配纯模块(keywords.ts)

**Files:**
- Create: `web/src/modules/keywords.ts`
- Create: `web/src/modules/__tests__/keywords.test.ts`

**Interfaces:**
- Consumes: `KeywordRule`(shared)
- Produces(冻结):
  - `const MAX_MATCHES_PER_RULE = 200`
  - `interface MatchDoc { id: number; title: string; text: string }`
  - `interface KeywordsResult { matches: { articleId: number; ruleId: string; count: number }[]; invalidRuleIds: string[] }`
  - `function isRuleValid(rule: KeywordRule): boolean`
  - `function findMatches(text: string, rule: KeywordRule): number[]`(命中起点数组,≤200;无效规则返回 `[]`)
  - `function htmlToText(html: string | null | undefined): string`(DOMParser body.textContent + 折叠空白,截断 20000)
  - `function matchDocs(docs: MatchDoc[], rules: KeywordRule[]): KeywordsResult`(仅统计 enabled 且有效的规则)

- [ ] **Step 1: 写失败测试**

`web/src/modules/__tests__/keywords.test.ts`:

```ts
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
```

Run: `pnpm --filter @readly/web test src/modules/__tests__/keywords.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 2: 实现 keywords.ts**

```ts
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

export function findMatches(text: string, rule: KeywordRule): number[] {
  const re = compile(rule);
  if (!re) return [];
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) break;
    out.push(m.index);
    if (out.length >= MAX_MATCHES_PER_RULE) break;
  }
  return out;
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
```

Run: 同上 Expected: PASS;全量 + typecheck。

- [ ] **Step 3: grep 自证并提交**

```bash
grep -rn "fetch(\|api(" web/src/modules/keywords.ts || echo "clean"
git add web/src/modules
git commit -m "feat(web): 关键词匹配模块(子串/正则/上限/文本提取,零网络)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: worker 协议扩展 + analysis store 规则切片与命中计算

**Files:**
- Modify: `web/src/modules/analysis.worker.ts`(新增 keywords 消息分支)
- Modify: `web/src/stores/analysis.ts`(规则切片 + CRUD + 命中计算/存储)
- Modify: `web/src/stores/__tests__/analysis.test.ts`(追加用例)

**Interfaces:**
- Consumes: Task 1(`matchDocs/MatchDoc/KeywordsResult`)、既有 worker/镜像/偏好基建
- Produces(冻结):
  - worker 协议新增:`{ type: "keywords"; requestId: number; docs: MatchDoc[]; rules: KeywordRule[] }` → `{ type: "keywordsResult"; requestId: number; result: KeywordsResult }`(无 progress,计算快;沿用 requestId 丢弃机制)
  - store 新增:`rules: Ref<KeywordRule[]>`、`rulesInvalid: Ref<string[]>`、`hits: Ref<Record<number, { ruleId: string; count: number }[]>>`、`hitsByRule: Ref<Record<string, { id: number; title: string; feedTitle: string; publishedAt: string; count: number }[]>>`、`hitsState: Ref<"idle"|"computing"|"done"|"error">`、`sanitizeKeywordRules(raw: unknown): KeywordRule[]`(导出)、`addRule(rule: Omit<KeywordRule,"id">): void`、`updateRule(id: string, patch: Partial<KeywordRule>): void`、`removeRule(id: string): void`、`computeHits(): Promise<void>`
  - `hitsFor(articleId: number): { ruleId: string; count: number }[]`
  - 触发:同步 `done` 后防抖 300ms 自动算;`rules` 变更后防抖 300ms 自动算

- [ ] **Step 1: worker 分支**

`web/src/modules/analysis.worker.ts` 扩展:import `matchDocs, type MatchDoc`;消息类型联合加入 keywords;在 `onmessage` 内 cluster 分支之外新增:

```ts
  if (data.type === "keywords") {
    currentRequestId = data.requestId;
    try {
      const result = matchDocs(data.docs, data.rules);
      if (currentRequestId !== data.requestId) return;
      (self as unknown as Worker).postMessage({ type: "keywordsResult", requestId: data.requestId, result });
    } catch {
      (self as unknown as Worker).postMessage({ type: "error", requestId: data.requestId });
    }
    return;
  }
```

- [ ] **Step 2: 失败测试(store 追加,沿用既有 fake-worker/mock idb seam)**

`web/src/stores/__tests__/analysis.test.ts` 追加:

```ts
describe("关键词规则与命中", () => {
  it("sanitizeKeywordRules:过滤非法形状、上限 100、id 去重", async () => {
    const { sanitizeKeywordRules } = await import("@/stores/analysis");
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `r${i}`, name: `n${i}`, keyword: "x", isRegex: false, caseSensitive: false, color: "#3b82f6", enabled: true,
    }));
    expect(sanitizeKeywordRules(many)).toHaveLength(100);
    expect(sanitizeKeywordRules([{ id: "a" }, many[0], many[0]])).toHaveLength(1); // 非法形状丢弃 + 去重
    expect(sanitizeKeywordRules("junk")).toEqual([]);
  });

  it("addRule/updateRule/removeRule 写本地并触发 keywor_rules 防抖 PUT", async () => {
    // 初始化 store(沿用文件内 makeStore 助手的 mock seam);fake timers 推进 1100ms;
    // 断言 localStorage readly_keyword_rules 与 PUT body.kv.keyword_rules
  });

  it("同步完成后自动算命中:fake worker 收 keywords 消息并按 docs 数量回传", async () => {
    // mock idb getAllNewest 返回 2 篇(其一标题含 "openai");addRule(openai);
    // 推进防抖 → 断言 worker.posted 含 {type:"keywords"} 且 hits[1] 含 {ruleId, count:2};
    // fake worker emit keywordsResult;断言 hitsByRule[ruleId] 的文章元数据来自镜像是时间倒序
  });

  it("hitsFor 无命中返回空数组", () => { /* … */ });
});
```

(执行时以文件内既有辅助函数形态为准;断言语义不变。)

Run: 该文件 Expected: FAIL。

- [ ] **Step 3: 实现 store 扩展**

`web/src/stores/analysis.ts` 增补(与既有风格一致):

```ts
import { SETTING_KEYS, type ClusterLevel, type ClusterPrefs, type KeywordRule } from "@readly/shared"; // 并入既有 import
import { matchDocs, htmlToText, type KeywordsResult } from "@/modules/keywords";

const RULES_LS_KEY = "readly_keyword_rules";
const HITS_DEBOUNCE_MS = 300;
const MAX_RULES = 100;

export function sanitizeKeywordRules(raw: unknown): KeywordRule[] {
  if (!Array.isArray(raw)) return [];
  const out: KeywordRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || seen.has(o.id)) continue;
    if (typeof o.keyword !== "string" || !o.keyword.trim()) continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 40) : o.keyword.trim().slice(0, 40),
      keyword: o.keyword.trim().slice(0, 200),
      isRegex: o.isRegex === true,
      caseSensitive: o.caseSensitive === true,
      color: typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : "#3b82f6",
      enabled: o.enabled !== false,
    });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}
```

store 内新增状态与逻辑:

```ts
  const rules = ref<KeywordRule[]>([]);
  const rulesInvalid = ref<string[]>([]);
  const hits = ref<Record<number, { ruleId: string; count: number }[]>>({});
  const hitsByRule = ref<Record<string, { id: number; title: string; feedTitle: string; publishedAt: string; count: number }[]>>({});
  const hitsState = ref<"idle" | "computing" | "done" | "error">("idle");
  let rulesServerCopy: string | null = null;
  let hitsTimer: ReturnType<typeof setTimeout> | null = null;
  let hitsRequestId = 0;

  function hitsFor(articleId: number): { ruleId: string; count: number }[] {
    return hits.value[articleId] ?? [];
  }

  function addRule(partial: Omit<KeywordRule, "id">): void {
    const id = `kr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    rules.value = sanitizeKeywordRules([...rules.value, { ...partial, id }]);
  }

  function updateRule(id: string, patch: Partial<KeywordRule>): void {
    rules.value = sanitizeKeywordRules(rules.value.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRule(id: string): void {
    rules.value = sanitizeKeywordRules(rules.value.filter((r) => r.id !== id));
  }
```

- `init()`:本地读 `readly_keyword_rules`(`sanitizeKeywordRules`);`loadRemotePrefs` 同时取 `SETTING_KEYS.keywordRules`(本地无则采用,登记 rulesServerCopy);
- `pushRemote()` 扩展为双键(`cluster_prefs` + `keyword_rules`,各自基线比对,任一变化即 PUT 双键);
- 新增 watcher(rules,与 clusterPrefs 同款:写 LS + 共用 putTimer);另在 rules watch 内触发 `scheduleHits()`;
- `syncIncremental` 的 `finally` 中,`syncState==="done"` 时 `scheduleHits()`;
- 命中计算:

```ts
  function scheduleHits(): void {
    if (hitsTimer) clearTimeout(hitsTimer);
    hitsTimer = setTimeout(() => {
      hitsTimer = null;
      void computeHits();
    }, HITS_DEBOUNCE_MS);
  }

  async function computeHits(): Promise<void> {
    if (!mirror || hitsState.value === "computing") return;
    if (rules.value.filter((r) => r.enabled).length === 0) {
      hits.value = {};
      hitsByRule.value = {};
      hitsState.value = "done";
      return;
    }
    hitsState.value = "computing";
    try {
      const docs = await withMirror((m) => m.getAllNewest(MIRROR_LIMIT));
      const payload = docs.map((d) => ({
        id: d.id,
        title: d.title,
        text: htmlToText(d.content ?? d.excerpt),
      }));
      const req = ++hitsRequestId;
      getWorker().postMessage({ type: "keywords", requestId: req, docs: payload, rules: rules.value });
      // 结果在 onmessage 的 keywordsResult 分支落地
      hitsRequestId = req; // 供 onmessage 校验(复用 activeRequest? 不——见下)
    } catch {
      hitsState.value = "error";
    }
  }
```

**注意**:worker 的 `onmessage` 现以 `activeRequest` 校验 requestId(聚类专用)。为关键词引入独立通道:`getWorker()` 的 onmessage 改为按 msg.type 分流——`keywordsResult` 与 `error` 用 `hitsRequestId` 校验(且 `error` 需能区分两个通道:按 `msg.requestId === activeRequest` / `hitsRequestId` 任一匹配判定来源),`progress/result/cancelled` 维持 `activeRequest` 语义。**执行时允许最小重构 onmessage 分流逻辑并保持既有聚类用例全绿**,报告须给出分流实现与既有测试未回归的证据。

`keywordsResult` 落地:

```ts
        } else if (msg.type === "keywordsResult") {
          if (msg.requestId !== hitsRequestId) return;
          applyHits(msg.result, lastHitsDocs);
          hitsState.value = "done";
        }
```

(`lastHitsDocs` 为 computeHits 内保存的 docs 快照,供 hitsByRule 关联标题/来源/时间;同时把 `rulesInvalid.value = result.invalidRuleIds`。)

`applyHits(result, docs)`:

```ts
  function applyHits(result: KeywordsResult, docs: MirrorRow[]): void {
    const byId = new Map(docs.map((d) => [d.id, d]));
    const h: typeof hits.value = {};
    const byRule: typeof hitsByRule.value = {};
    for (const m of result.matches) {
      (h[m.articleId] ??= []).push({ ruleId: m.ruleId, count: m.count });
      const d = byId.get(m.articleId);
      if (d) {
        (byRule[m.ruleId] ??= []).push({ id: d.id, title: d.title, feedTitle: d.feedTitle, publishedAt: d.publishedAt, count: m.count });
      }
    }
    for (const list of Object.values(byRule)) list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    hits.value = h;
    hitsByRule.value = byRule;
  }
```

return 列表追加:`rules, rulesInvalid, hits, hitsByRule, hitsState, hitsFor, addRule, updateRule, removeRule, computeHits`。

- [ ] **Step 4: 全量验证并提交**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build`
Expected: 全绿;grep 自证 worker 仍零网络。

```bash
git add web
git commit -m "feat(web): 关键词规则切片与命中计算(worker 协议扩展/双键同步)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 关键词视图(列表 / 编辑器 / 详情页)与侧栏入口

**Files:**
- Create: `web/src/views/Keywords.vue`
- Create: `web/src/views/KeywordDetail.vue`
- Create: `web/src/components/RuleEditor.vue`
- Modify: `web/src/router.ts`(`/keywords`、`/keywords/:id`)
- Modify: `web/src/components/Sidebar.vue`(nav 加「关键词」)
- Create: `web/src/views/__tests__/keywords-mount.test.ts`

**Interfaces:**
- Consumes: `useAnalysisStore`(Task 2)、`isRuleValid`(Task 1)
- Produces: 选择器契约(Global Constraints 所列)与路由

- [ ] **Step 1: 失败测试**

`web/src/views/__tests__/keywords-mount.test.ts`(沿用 events-mount 的 seam:mock worker-factory + mock idb createMirror/syncMirror):

```ts
// @vitest-environment jsdom
// 用例:
// 1. 规则列表渲染:预置 store.rules = [{id:"r1",name:"OpenAI",keyword:"openai",...},{id:"r2",name:"坏正则",keyword:"([",isRegex:true,...}]
//    → 断言 [data-rule-row] 两行;r2 行含「正则无效」;r1 行显示 hitsByRule 命中数
// 2. 开关:点 r1 的 [data-rule-toggle] → store.rules[0].enabled === false 且 LS 已写
// 3. 新建:点 [data-new-rule] → RuleEditor 出现;填 name/keyword、点 [data-rule-save] → rules 增加一条
// 4. 无效正则提示:编辑器内勾 [data-rule-regex] 并输入 "([" → [data-rule-error] 显示「正则表达式无效」且 save 置灰
// 5. 删除:点 [data-rule-delete] → rules 减少
```

(完整测试代码按此五断言编写;依赖的 store state 可直接赋值/调用 action。)

Run: 该文件 Expected: FAIL(视图不存在)。

- [ ] **Step 2: 实现三个组件与接线**

`web/src/components/RuleEditor.vue`(弹层,模式同 ShortcutHelp;`defineEmits<{ close: [] }>()`;props `{ initial?: KeywordRule }`):

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import type { KeywordRule } from "@readly/shared";
import { isRuleValid } from "@/modules/keywords";

const props = defineProps<{ initial?: KeywordRule }>();
const emit = defineEmits<{ close: []; save: [rule: Omit<KeywordRule, "id">] }>();

const RULE_COLORS = ["#3b82f6", "#ef4444", "#f59e0b", "#22c55e", "#14b8a6", "#8b5cf6", "#ec4899", "#64748b"];

const name = ref(props.initial?.name ?? "");
const keyword = ref(props.initial?.keyword ?? "");
const isRegex = ref(props.initial?.isRegex ?? false);
const caseSensitive = ref(props.initial?.caseSensitive ?? false);
const color = ref(props.initial?.color ?? RULE_COLORS[0]!);
const enabled = ref(props.initial?.enabled ?? true);

const draft = computed<KeywordRule>(() => ({
  id: props.initial?.id ?? "draft",
  name: name.value,
  keyword: keyword.value,
  isRegex: isRegex.value,
  caseSensitive: caseSensitive.value,
  color: color.value,
  enabled: enabled.value,
}));

const canSave = computed(() => keyword.value.trim().length > 0 && isRuleValid(draft.value));
const invalidRegex = computed(() => isRegex.value && keyword.value.trim().length > 0 && !isRuleValid(draft.value));

function save(): void {
  if (!canSave.value) return;
  emit("save", {
    name: name.value.trim() || keyword.value.trim().slice(0, 40),
    keyword: keyword.value.trim(),
    isRegex: isRegex.value,
    caseSensitive: caseSensitive.value,
    color: color.value,
    enabled: enabled.value,
  });
  emit("close");
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <h3 class="text-base font-semibold">{{ initial ? "编辑规则" : "新建规则" }}</h3>
      <label class="mt-4 block text-xs text-neutral-500">
        名称(可选)
        <input v-model="name" data-rule-name class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="如:OpenAI 动态" />
      </label>
      <label class="mt-3 block text-xs text-neutral-500">
        关键词
        <input v-model="keyword" data-rule-keyword class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="要监控的词或正则表达式" />
      </label>
      <p v-if="invalidRegex" data-rule-error class="mt-1 text-xs text-red-600 dark:text-red-400">正则表达式无效</p>
      <div class="mt-3 flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-300">
        <label class="flex items-center gap-1.5"><input v-model="isRegex" data-rule-regex type="checkbox" class="accent-[var(--accent)]" />正则表达式</label>
        <label class="flex items-center gap-1.5"><input v-model="caseSensitive" type="checkbox" class="accent-[var(--accent)]" />区分大小写</label>
        <label class="flex items-center gap-1.5"><input v-model="enabled" type="checkbox" class="accent-[var(--accent)]" />启用</label>
      </div>
      <div class="mt-3">
        <p class="text-xs text-neutral-500">标记颜色</p>
        <div class="mt-1.5 flex gap-1.5">
          <button
            v-for="c in RULE_COLORS"
            :key="c"
            class="h-6 w-6 rounded-full border border-black/10"
            :style="{ background: c, boxShadow: color === c ? '0 0 0 2px var(--accent)' : undefined }"
            @click="color = c"
          />
        </div>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" @click="emit('close')">取消</button>
        <button data-rule-save :disabled="!canSave" class="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm text-white disabled:opacity-50" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
```

`web/src/views/Keywords.vue`:列表 + 新建/编辑/删除 + 开关;命中数取 `analysis.hitsByRule[rule.id]?.length ?? 0`;无效规则(`!isRuleValid`)行内显示红色「正则无效」;页脚说明「命中统计基于本地最近 1000 篇」。关键结构:

```vue
<div v-for="rule in analysis.rules" :key="rule.id" data-rule-row class="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800">
  <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: rule.color }" />
  <div class="min-w-0 flex-1">
    <p class="truncate text-sm font-medium">{{ rule.name }}</p>
    <p class="mt-0.5 truncate text-xs text-neutral-500">
      {{ rule.isRegex ? "正则" : "关键词" }}:{{ rule.keyword }}
      <span v-if="!isRuleValid(rule)" class="text-red-600 dark:text-red-400"> · 正则无效</span>
    </p>
  </div>
  <span class="shrink-0 text-xs text-neutral-500">{{ analysis.hitsByRule[rule.id]?.length ?? 0 }} 篇命中</span>
  <input data-rule-toggle type="checkbox" class="accent-[var(--accent)]" :checked="rule.enabled" @change="analysis.updateRule(rule.id, { enabled: ($event.target as HTMLInputElement).checked })" />
  <button data-rule-edit class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" @click="editing = rule">编辑</button>
  <button data-rule-delete class="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800" @click="analysis.removeRule(rule.id)">删除</button>
</div>
<button data-new-rule class="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white" @click="creating = true">新建规则</button>
<RuleEditor v-if="creating" @close="creating = false" @save="analysis.addRule($event)" />
<RuleEditor v-else-if="editing" :initial="editing" @close="editing = null" @save="analysis.updateRule(editing.id, $event)" />
```

行外再包一层可点进详情(spec 要求「查看每条规则具体命中了哪些文章」):把主信息区包成 `<RouterLink :to="`/keywords/${rule.id}`">` 或点击名称跳转;给详情入口加 `data-rule-detail`。

`web/src/views/KeywordDetail.vue`:从 route.params.id 取规则;不存在 → 提示 + 返回;存在 → 头部(色点/名称/关键词/类型)+ 命中列表(`[data-matched-article]` 行:标题/来源/时间/×count,点击 `router.push({path:"/",query:{a:String(id)}})`)+ 空态「暂无命中」。

`router.ts` 增加两条路由(lazy 导入风格同 events);`Sidebar.vue` nav「事件」之后:

```vue
      <button :class="navItem" @click="router.push('/keywords')">
        <span>关键词</span>
      </button>
```

- [ ] **Step 3: 全量验证并提交**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build`
Expected: 全绿(新增 keywords-mount 用例)。

```bash
git add web
git commit -m "feat(web): 关键词视图(规则列表/编辑器/命中详情)与侧栏入口

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 列表打点 + 阅读器高亮 + README(含 TTS 取消)+ 实测

**Files:**
- Create: `web/src/modules/highlight.ts`
- Create: `web/src/modules/__tests__/highlight.test.ts`
- Modify: `web/src/components/ArticleListItem.vue`(命中色点)
- Modify: `web/src/components/ReaderPane.vue`(渲染后高亮)
- Modify: `README.md`(功能 7 更新;移除 TTS 行)
- Create(验后删): `web/scripts/verify-keywords.mjs`

**Interfaces:**
- Produces:
  - `highlightMatchesIn(root: HTMLElement, rules: KeywordRule[], opts?: { maxMarks?: number }): number`(在已清洗 DOM 上包裹文本节点;返回标记数)
  - 列表色点:ArticleListItem 内直接读 `useAnalysisStore().hitsFor(item.id)`;选择器 `[data-hit-dot]`(每个点带 `title=规则名` 与 `data-rule-id`)

- [ ] **Step 1: 失败测试(highlight.ts)**

```ts
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
});
```

Run: 该文件 Expected: FAIL。

- [ ] **Step 2: 实现 highlight.ts 与两处集成**

`web/src/modules/highlight.ts`:

```ts
import type { KeywordRule } from "@readly/shared";
import { findMatches, isRuleValid } from "./keywords";

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
    type Hit = { start: number; end: number; rule: KeywordRule };
    const hits: Hit[] = [];
    for (const rule of active) {
      for (const start of findMatches(text, rule)) {
        const len = matchLengthAt(text, start, rule);
        if (len > 0) hits.push({ start, end: start + len, rule });
      }
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    // 去重叠(先到先得,长优先)
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

// 在 findMatches 只给起点的情况下取回该命中长度:重新按规则单次定位
function matchLengthAt(text: string, start: number, rule: KeywordRule): number {
  if (!rule.isRegex) return rule.keyword.length;
  try {
    const re = new RegExp(rule.keyword, rule.caseSensitive ? "" : "i");
    const m = re.exec(text.slice(start));
    return m && m.index === 0 ? m[0].length : 0;
  } catch {
    return 0;
  }
}
```

(注:`matchLengthAt` 对普通词直接返回关键词长度——`findMatches` 已保证命中;执行时若发现大小写折叠导致长度不一致的边界,允许在 `keywords.ts` 增补 `findMatchRanges(text, rule): {start, end}[]` 并让两处共用,报告须说明。)

`ArticleListItem.vue` script 追加:

```ts
import { computed } from "vue";
import { useAnalysisStore } from "@/stores/analysis";
const analysis = useAnalysisStore();
const hitDots = computed(() => analysis.hitsFor(props.item.id).slice(0, 3));
const hitMore = computed(() => Math.max(0, analysis.hitsFor(props.item.id).length - 3));
```

(现有 `defineProps` 需改为 `const props = defineProps<...>()` 以在 script 中使用。)模板 meta 行(★ 之前)插入:

```vue
        <span v-for="h in hitDots" :key="h.ruleId" data-hit-dot :data-rule-id="h.ruleId" :title="h.ruleId" class="h-2 w-2 shrink-0 rounded-full" :style="{ background: dotColor(h.ruleId) }" />
        <span v-if="hitMore > 0" class="shrink-0 text-[10px] text-neutral-400">+{{ hitMore }}</span>
```

`dotColor(ruleId)`:从 `analysis.rules.find(r => r.id === ruleId)?.color ?? "#94a3b8"`。title 用规则名。

`ReaderPane.vue` script 追加:

```ts
import { useAnalysisStore } from "@/stores/analysis";
import { highlightMatchesIn } from "@/modules/highlight";
const analysis = useAnalysisStore();
const articleBody = ref<HTMLElement | null>(null);

function applyHighlights(): void {
  const el = articleBody.value;
  if (!el) return;
  highlightMatchesIn(el, analysis.rules, { maxMarks: 300 });
}

watch(
  () => [html.value, analysis.rules.length ?? 0, reader.article?.id] as const,
  () => {
    void nextTick(applyHighlights);
  },
  { immediate: true }
);
```

模板:`<article ref="articleBody" class="reader-body ..." v-html="html" />`。

(高亮只包裹已清洗 DOM 的文本节点,不产生 `innerHTML` 注入;`v-html` 重渲染会清掉 mark,watch 会重新应用——报告需说明该生命周期。)

- [ ] **Step 3: README 更新**

功能清单第 7 条改为已交付:

```markdown
7. 关键词监控:本地规则匹配(普通词/正则、大小写、颜色),文章列表打点、正文高亮,每条规则可查看命中文章
```

**删除第 4 条(TTS)整行**(用户已取消;保持其余编号)。

- [ ] **Step 4: Chrome 实测(浅+深)**

`web/scripts/verify-keywords.mjs`(一次性,验后删):构建产物 + 独立端口 4699 桩(镜像含 3 篇,其中 2 篇含「openai」;`/api/settings` 可下发 `keyword_rules` 预置一条;其余最小桩),CDP 断言并记录:
1. 进入 `/keywords`:列表出现 1 条规则、命中数「2 篇命中」;
2. 点进详情(`data-rule-detail`):`[data-matched-article]` 恰好 2 条、按时间倒序;点第一条 → 回 `/?a=` 并打开;
3. 回列表新建规则(填 `芯片` 正则关):保存后列表 2 条;
4. 回 Inbox:命中文章行出现 `[data-hit-dot]`;打开含 openai 的文章:`mark[data-rule-id]` ≥1 且背景色非透明;
5. 关闭该规则开关 → 列表点与正文 mark 均消失(重开文章);
6. 切暗色重测 2/4 的 DOM 断言;记录 mark 背景/色点对比度(文字对比以底色混合后 ≥4.5:1,若 33 alpha 不足则记录实测值并说明采用更实 alpha 的调整);
7. 截图 `/tmp/readly-keywords-light.png`、`/tmp/readly-keywords-detail.png`、`/tmp/readly-keywords-dark.png`。

Run: `pnpm build && node web/scripts/verify-keywords.mjs`
Expected: 全部断言通过;数值与截图名记入报告;验后删除脚本。

- [ ] **Step 5: 提交**

```bash
git add web README.md
git commit -m "feat(web): 关键词命中打点与正文高亮;README 同步(TTS 取消)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 后续计划索引

- **计划 06 — AI 摘要/翻译(M6)**:引入 /settings 设置页(服务商配置)、SSE 流式、摘要与翻译三态对照、缓存与代理开关。
- **计划 07 — 收尾(M7)**。

## 自检记录(writing-plans self-review)

- **规格覆盖**:设计 §8.7 全项——规则结构(冻结类型)→ T1–T3;普通/正则匹配与失效提示 → T1/T3;命中打标(列表色点)→ T4;正文高亮(颜色=规则色)→ T4;规则详情命中列表 → T3;范围说明(本地最近 1000 篇)→ T3 文案;规则跨设备同步 → T2。TTS 取消已同步进设计文档与 README(T4)。
- **冻结口径**:`KeywordRule/SETTING_KEYS.keywordRules` 原样;镜像/worker/偏好切片全部复用计划 04 基建(不新增同步机制)。
- **有意决策**:①命中计算在 worker(完整复用计划 04 通道,onmessage 需按 type 分流——已在 T2 明确要求最小重构并需既有用例零回归);②匹配文本截 20000 字/篇(控制 worker 传输;正文关键词命中以镜像 content 文本为准);③高亮为渲染后 DOM 文本节点包裹(不触碰 sanitize 门);④`matchLengthAt` 的边界已注明可升级为共享 `findMatchRanges`;⑤规则色点上限 3 个 + “+n”。
- **类型一致性**:`KeywordsResult/MatchDoc`(T1)→ worker 消息(T2)→ store 落地(T2)→ 视图消费(T3/T4)全程同名;选择器清单(Global Constraints)贯穿测试与实测。
- **无占位符**:T2/T3 中含“按文件内既有辅助形态为准”的测试骨架说明(计划 04 同类写法已成功执行),但断言内容与选择器均给全。
