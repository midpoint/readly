# Readly — 列表模式行内容精简 · 设计文档

- 日期:2026-10-16
- 状态:已评审通过(用户经 ASCII 预览选定「纯标题+状态标记」档;卡片模式不动)
- 背景:用户要求列表模式行内容精简——移除「源名 · 相对时间」副信息,只显示标题,状态标记保留。

## 1. 列表模式新行结构

单行:`[未读点] 标题(单行截断) … [命中色点≤3 +n] [★] [🕘]`

- 未读点:标题**前**,样式与现有一致(测试 `hasUnreadDot` 依赖 class 含 `bg-[var(--accent)]` 与 `rounded-full`);
- 标题:`<h3>` 保持 `text-sm font-medium line-clamp-1`,已读灰色逻辑(`item.isRead ? text-neutral-500 : …`)不变;
- 右侧聚簇:`ArticleMarks`(见 §2),`shrink-0`;
- **不再渲染**:源名(`feedTitle`)、相对时间(`relative(publishedAt)`)。
- 行根 `[data-article-row][data-layout="list"]` 保留 `py-1.5`;追加 `items-center`(仅 list 分支,card 不受影响)。

## 2. 新组件 `ArticleMarks.vue`

- props:`{ item: ArticleListItem }`;自读 `useAnalysisStore`;渲染:命中色点(≤3,`data-hit-dot` + `data-rule-id` + `title=规则名`,颜色=规则色,缺省 `#94a3b8`)+ 溢出计数「+n」+ ★(`text-amber-500`)+ 🕘(`text-sky-500`);
- 由 `ArticleListItem` 迁移:`hitDots`/`hitMore`/`dotColor`/`dotTitle`/`FALLBACK_DOT_COLOR`;
- 类名、选择器与现状**逐字一致**(既有多处测试选择器依赖)。

## 3. 卡片模式:零视觉变更

- 结构不变(副信息行=未读点·源名··时间·标记聚簇;标题 clamp-2;摘要;缩略图);
- 仅把副信息行中的内联标记区替换为 `<ArticleMarks :item="item" />`——渲染产物等价;
- `ArticleListItem` 的模板按 `layout` 分为两个分支(list / card),标记聚簇两处共用组件,避免复制。

## 4. 契约冻结

- `data-article-row`、`data-layout`、`data-hit-dot`/`data-rule-id`、`py-1.5`/`py-3`、`line-clamp-1`/`line-clamp-2`、未读点 class 特征——全部保留;
- `select` emit 行为不变;组件的隐藏/分页等外部行为不受影响。

## 5. 测试

- `article-list-item.test.ts` 列表用例**反转断言**:`root.textContent` 不含 `示例源`;不匹配时间模式 `/刚刚|分钟前|小时前|天前|\d{4}\/\d{1,2}\/\d{1,2}/`(标题「待读文章」无数字,无假阳性);保留:单行截断、紧凑间距、无 img/摘要、未读点、★/🕘、命中点;
- 新增 1 用例:seed 4 条命中 → list 模式渲染 3 个色点 + 「+1」文本(覆盖 `hitMore` 分支);
- 卡片用例**零改动**(回归护栏);不单建 `ArticleMarks` 测试文件(经父组件双布局覆盖)。

## 6. 验收

- Chrome 浅/深实测:list 模式行实测为单行(行高显著小于卡片),行文本=标题(+标记),**无源名文本**;标记在标题右端;卡片模式截图回归;
- 全量测试保绿(web 266→267 = +1 新用例;改 1 断言;worker 143 不变,合计 410),typecheck + build 通过。

## 7. 明确不做(YAGNI)

- 卡片模式任何视觉改动;日期分组头;hover 才显示标记等交互变体;新的用户偏好开关。
