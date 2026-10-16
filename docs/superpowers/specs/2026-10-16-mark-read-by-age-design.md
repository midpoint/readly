# Readly — 标已读时间档(3 天/1 周/1 月/1 年以上)· 设计文档

- 日期:2026-10-16
- 状态:已评审通过(用户经预览选定「主按钮 + ▾ 时间档菜单」交互)
- 背景:「全部标已读」扩展为可按文章年龄批量置读:3 天以上 / 1 周以上 / 1 月以上 / 1 年以上。

## 1. 语义(冻结)

- 「X 以上标已读」= 将**发布时间早于 now − X** 且**当前未读**的文章置为已读;已读文章不动。
- 作用范围沿用现状:「全部文章 / 某源 / 某分类」(由当前过滤决定)。
- 无时间档的「全部标已读」行为**逐字节不变**(请求体、SQL、返回)。

## 2. 服务端(`worker/src/routes/articles.ts` `POST /articles/mark-all-read`)

- body 扩展:`{ scope, olderThanDays? }`;校验:`olderThanDays` 若存在必须是整数且 `1 ≤ d ≤ 36500`,否则 `400 { code: "invalid_days" }`(缺失 = 不限,保持现状)。
- 三个 scope 分支 SQL 统一追加 `AND a.published_at < ?`;cutoff = 服务端 `new Date(Date.now() - d*86400000).toISOString()`。`published_at` 全表为 ISO 文本,字典序即时间序。
- 返回仍 `{ updated }`(cutoff 档位下为命中行数)。

## 3. 前端

- `stores/feeds.ts`:`markAllRead(scope, olderThanDays?: number)`;有值时 body 附 `olderThanDays`,**无值时请求体与现状逐字节一致**。
- `components/ArticleList.vue`:
  - 「全部标已读」主按钮不动(一键=全部);右侧新增 `▾` 按钮:`aria-label="更多标已读范围"`、`aria-expanded`、选择器契约 `[data-mark-age-toggle]`;
  - 菜单(选择器契约 `[data-mark-age-menu]`,项 `[data-mark-age="3|7|30|365"]`):四项文案「3 天以上标已读 / 1 周以上标已读 / 1 月以上标已读 / 1 年以上标已读」→ `olderThanDays: 3/7/30/365`;
  - 交互与侧栏 ⋯ 菜单同款:点外关闭(document click)、Esc 关闭、选中即关;`markingAllRead` 期间主按钮与菜单项均禁用(共用防重入);执行成功后 `articles.load(true)`(现状),失败静默(现状);
  - 样式沿用侧栏菜单项(block/px-3/py-1.5/text-sm + hover 深浅配对);菜单绝对定位右对齐于按钮组容器(容器加 `relative`),`z-30`(工具栏 `z-20` 之上)。

## 4. 测试

- worker(`test/articles.test.ts`,沿用 `seed()`):seed 后把 ids[0..1] 的 `published_at` 改为「1 天前」ISO、ids[2..4] 保持 2025 旧日期:
  1. `{ type:"all", olderThanDays:30 }` → `updated === 3`,ids[0..1] 仍未读、ids[2..4] 已读;
  2. `{ type:"feed", olderThanDays:30 }` → 同上(SQL feed 分支);
  3. `olderThanDays` 为 `0 / -1 / 1.5 / "3"` → 400 `invalid_days`(4 断言可同一用例);
  4. 无档回归由既有用例继续守(不动既有断言)。
- web(`__tests__/article-list-toolbar.test.ts`):
  1. 点 `[data-mark-age-toggle]` → `[data-mark-age-menu]` 出现且含 4 项;
  2. 点 `[data-mark-age="30"]` → 精确请求体 `{ scope: { type: "feed", id: 3 }, olderThanDays: 30 }`(精确契约),菜单关闭,列表重载;
  3. 点外关闭:菜单消失且无请求;
  4. 既有「全部标已读」用例(精确体不含 olderThanDays)保持零改动。
- 计数:worker 143→146(+3),web 267→270(+3),合计 416,以实际为准。

## 5. 验收

- Chrome 浅/深实测:菜单开合截图;桩数据两篇(1 天前 / 40 天前),执行「1 月以上」后 40 天前那篇转已读、1 天前保持未读(未读点仍在)、侧栏未读计数联动;零异常。
- 全量保绿 + typecheck + build。

## 6. 明确不做(YAGNI)

- 自定义天数输入框;菜单内重复「全部」项;排序/其他维度(如按抓取时间);批量撤销。
