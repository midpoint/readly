# Readly 列表布局(紧凑视图)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文章列表增加「列表布局」——紧凑单行视图(默认仍是现有卡片布局),工具栏一键切换,偏好持久化并跨设备同步;两种布局下未读点、星标、稍后读、命中色点等标记全部保留。

**Architecture:** `ReaderPrefs` 三次扩展一个枚举字段 `articleLayout: "card" | "list"`(默认 `"card"`,经既有双写与 sanitizePrefs 校验);渲染侧由 `ArticleListItem` 依布局切换两套紧凑/宽松样式(单一组件内分支,不复制逻辑);切换入口在 `ArticleList` 工具栏(与「只看未读」同区)。

**Tech Stack:** 既有栈,无新依赖。

## Global Constraints

- `ReaderPrefs` 三次扩展(经批准):仅新增 `articleLayout: "card" | "list"`(默认 `"card"`),既有字段一律不动;`DEFAULT_READER_PREFS` 与 `sanitizePrefs` 同步(`o.articleLayout === "list" ? "list" : "card"`)。
- 两种布局的**标记等价**:未读圆点、收藏 ★、稍后 🕘、命中色点(≤3)+ 数、日期分组头在两种布局下均存在;列表布局去除缩略图与摘要行,标题单行截断,来源·时间同行右对齐。
- 切换入口:`ArticleList` 工具栏按钮 `[data-layout-toggle]`,文案在「列表 / 卡片」间反映**当前布局**(点击切到另一种);title 说明;点击后 `settings.updatePrefs({ articleLayout })`,无需重载列表(纯展示)。
- 无 any;strict;深色配对;视觉验收必须实测(Chrome,独立端口 4999,浅+深),记录两种布局的行高实测值与标记存在性。
- 选择器契约:`[data-layout-toggle]`、行容器 `[data-article-row]`、列表布局专属类 `data-layout="list"`(挂在行容器上)。

---

### Task 2: 列表布局切换

**Files:**
- Modify: `shared/src/index.ts`(`ReaderPrefs` + `DEFAULT_READER_PREFS`)
- Modify: `web/src/stores/settings.ts`(`sanitizePrefs` 加字段)
- Modify: `web/src/stores/__tests__/settings.test.ts`(追加断言)
- Modify: `web/src/components/ArticleListItem.vue`(双布局渲染)
- Modify: `web/src/components/ArticleList.vue`(工具栏切换按钮)
- Modify: `web/src/components/__tests__/article-list-toolbar.test.ts`(追加 1 用例)
- Create: `web/src/components/__tests__/article-list-item.test.ts`
- Create(验后删): `web/scripts/verify-layout.mjs`

**Interfaces:**
- Produces(冻结):
  - `ReaderPrefs.articleLayout: "card" | "list"`(shared;DEFAULT `"card"`)
  - `ArticleListItem` 根按钮带 `data-article-row` 与 `:data-layout="layout"`(源于 store,组件内自读 `useSettingsStore`)
  - `[data-layout-toggle]`(ArticleList 工具栏)

- [ ] **Step 1: shared 与 sanitize**

`shared/src/index.ts`:`ReaderPrefs` 在 `listWidth` 之后加:

```ts
  articleLayout: "card" | "list";
```

`DEFAULT_READER_PREFS` 在 `listWidth: 380,` 之后加:

```ts
  articleLayout: "card",
```

`sanitizePrefs` 追加:

```ts
    articleLayout: o.articleLayout === "list" ? "list" : "card",
```

`settings.test.ts` 追加断言(非法回退 card、合法保留 list)。

- [ ] **Step 2: 组件(失败测试→实现)**

`web/src/components/__tests__/article-list-item.test.ts`:

```ts
// 1. 默认 card:渲染含摘要行与缩略图(有 imageUrl 时);根节点 data-layout="card"
// 2. 置 store.prefs.articleLayout = "list" 后重挂:根节点 data-layout="list";
//    无 <img>;无摘要 <p>;未读点/★/🕘/命中色点仍存在(逐项断言)
// 3. 两种布局下点击均 emit select
```

`article-list-toolbar.test.ts` 追加:

```ts
// 点 [data-layout-toggle] → store.prefs.articleLayout 变 "list",按钮文案变为「卡片」
// 再点 → 回 "card"
```

Run: 两文件 Expected: FAIL。

`ArticleListItem.vue` 实现:script 读 `useSettingsStore()`;模板根按钮加 `data-article-row` 与 `:data-layout="layout"`;卡片专属内容(缩略图 `<img>` 与摘要 `<p>`)包 `v-if="layout === 'card'"`;列表布局下标题行改为单行(`line-clamp-1`)且 meta 行(来源·时间·标记)保持;样式类按布局切换紧凑间距(`py-3`↔`py-1.5`)。

`ArticleList.vue` 工具栏:「只看未读」旁加:

```vue
      <button data-layout-toggle :class="…同款小按钮…" :title="settings.prefs.articleLayout === 'list' ? '切换为卡片布局' : '切换为列表布局'" @click="settings.updatePrefs({ articleLayout: settings.prefs.articleLayout === 'list' ? 'card' : 'list' })">
        {{ settings.prefs.articleLayout === "list" ? "卡片" : "列表" }}
      </button>
```

- [ ] **Step 3: 全量验证**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build` → 全绿。

- [ ] **Step 4: Chrome 实测(浅+深)**

`web/scripts/verify-layout.mjs`(一次性):构建 + 4999 桩(镜像含 ≥3 篇,其一有 imageUrl 与摘要;一未读、一收藏、一命中色点需 keywords 桩或直接跳过色点断言并说明),CDP:
1. 默认:行 `data-layout="card"`、存在 `img` 与摘要;记录首行高度;
2. 点 `[data-layout-toggle]` → 行 `data-layout="list"`、无 `img`、无摘要、首行高度显著缩小(记录两值);未读点/★ 仍在;
3. localStorage `readly_prefs.articleLayout === "list"`;刷新保持;
4. 再点回卡片,高度恢复;
5. 切暗色重测 2 的 DOM 断言;
6. 截图 `/tmp/readly-layout-list-light.png`、`/tmp/readly-layout-list-dark.png`。

- [ ] **Step 5: 提交**

```bash
git add shared web
git commit -m "feat(web): 列表布局(紧凑视图切换,偏好持久化)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 自检记录

- 覆盖:紧凑列表视图、切换入口、持久化、标记等价、双布局实测;`articleLayout` 四端同名同型;无占位符(测试骨架按既有 seam 模式,断言给全)。
