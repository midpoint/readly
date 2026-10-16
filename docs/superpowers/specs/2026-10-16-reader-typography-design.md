# Readly — 正文默认排版升级(中文书籍派)· 设计文档

- 日期:2026-10-16
- 状态:已评审通过(用户经可视化对照台两轮确认:第一屏选定「候选 B 中文书籍派」;第二屏确认完整版式含引用/列表/图处理;并明确「只有中文文章缩进」)
- 背景:用户反馈「文章版面排版不够舒适」——现有默认(17px / 行距 1.7 / 段距≈1em / 左对齐)对中文长文偏紧凑,段落节奏弱。字号/行距/宽度/字体的**可调滑块已存在**(ThemePanel),本次只升级默认版式,不新增控件。
- 对照记录:`<repo>/.superpowers/brainstorm/2333371-1792127564/content/`(typography-defaults.html、b-full-preview.html,gitignored 留存)

## 1. 版式规则

**中文文章**(渲染内容判定为 zh 时,见 §2):

| 元素 | 规则 |
|---|---|
| 段落 `<p>` | 首行缩进 2em;段距 0.8em(上下 margin) |
| 正文基底 | 两端对齐;标点挤压 `text-spacing-trim: space-first`(渐进增强,旧浏览器无副作用);字距 `letter-spacing: 0.01em` |

**非段落例外(不首行缩进)**:`blockquote` 内 `p`、`li` 内 `p`、`p[data-img-only]`(纯图片段,经 sanitize 后处理打标)、`pre`/`code`、`figure`/`figcaption`。

**西文文章**:保持现状(左对齐、段距 0——Tailwind preflight 现状、无缩进、无字距)——不做缩进与两端对齐。

**语言无关的通用改进(所有文章)**:
- 引用块:整块左缩进 + 左侧 3px 竖线(`color-mix(in srgb, currentColor 30%, transparent)`);文字颜色**继承正文**(不引入新弱化色,对比度零回归)
- 列表:`padding-left: 1.8em`;`li` 项距 0.35em;项目符号/编号由本功能恢复(Tailwind preflight 全局清零 list-style:ul=disc、ol=decimal)
- 图片:`display:block; margin: 1em auto`(居中 + 上下留白;现有 max-width/圆角不变)

**数值**:`DEFAULT_READER_PREFS.lineHeight: 1.7 → 1.85`(全局默认,与语言无关;字号 17px、宽度 720px、字体族均不变;四个可调滑块不动)。

## 2. 语言判定(渲染侧、纯客户端)

- 在 `ReaderPane` 对**当前渲染内容**(与 `html` computed 同源(对已消毒的 `html.value` 调用,style/script 已过滤),经 `aiTextOf` 剥标签截 6000 字)调用既有 `detectTextLang`(web/src/modules/ai.ts,与入库侧 `detectLang` 同算法):`"zh"` → 中文规则集;`"en"`/`null` → 西文。摘要/全文切换或抓取全文后随之重判。
- 绑定方式:`.reader-body` 上按判定结果加 class `reader-zh`;切换文章时 reactive 重判。
- 不依赖存储的 `article.lang`(渲染内容是什么,排版判定就以什么为准;避免入库判定与正文不符的错配)。

## 3. 已存实例落地

- 缩进/对齐/标点/字距/引用/列表/图:升级部署后**自动生效**,无需设置。
- 行距:存量 prefs 中已存 1.7 的实例,把「行距」滑块拖到 1.8–1.9 一次即可(新装/「恢复默认」后即 1.85)。

## 4. 明确不做(YAGNI)

- 不新增可调控件(现有 字号/行距/正文宽度/字体 四滑块已满足「自己设定」)
- 标题/作者行/AI 摘要卡等正文外元素不联动
- 字体族不改;不引入 `text-autospace` 等实验特性

## 5. 已知限制(如实披露)

- 用 `<br><br>` 分段的老式 RSS 文章没有 `<p>` 标签,不会获得缩进(仅受行距影响;无法可靠区分软换行)
- 标点挤压需较新 Chrome;不支持时静默无效果
- `:has()` 需现代 Chrome(项目既定目标环境)
- 纯图片段(经 sanitize 后处理打标 `data-img-only`:唯一元素子节点为 img 且无文本)居中且不缩进;`<p><a><img></a></p>` 形状与顶层裸 `<img>` 不适用居中规则(设计边界);「文字+单图」段落不再误伤(精确打标,而非 `:only-child`)

## 6. 验收

- **样式契约测试**(jsdom):渲染中文文章 → `.reader-body` 含 `reader-zh`;渲染英文文章 → 不含;无文本内容(null)→ 不含。
- **Chrome 浅/深实测**(纪律 1):中文文章在 classic 主题下截图实测——首行缩进、两端对齐、引用块竖线、列表不缩进、图片段不缩进逐项核验;英文文章截图确认无缩进、左对齐;对比度不回归(无新弱化色);暗色配对不回归。
- 全量 409 项测试保绿(worker 143 + web 266)+ typecheck + build。
