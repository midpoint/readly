# Readly — 侧栏精简 + 功能入设置 · 设计文档

- 日期:2026-10-16
- 状态:已评审通过(用户确认两决策:底栏保留「设置 + 刷新订阅」;OPML 完整功能入设置且为唯一入口)
- 背景:侧栏底栏四项过密;「导入/导出 OPML」「快捷键」迁入设置页,侧栏只留导航与高频动作。

## 1. 侧栏(`Sidebar.vue`)

- 底栏**移除**:「导入 / 导出 OPML」(原 `router.push('/add')`)、「快捷键」(原 `openShortcutHelp`)——连带移除 `useShortcutHelp` 的 import 与解构(无其余使用点)。
- 底栏**保留**:「设置」「刷新订阅」(含 busy 文案与 disabled 逻辑,逐字不动)。
- 顶部「添加订阅」按钮、其余侧栏功能不动。

## 2. 设置页(`Settings.vue`,新增两区块,置于「AI 服务商」之后)

### 订阅数据
- 「导入 OPML」:文件选择直接导入——`importOpml` 与 `doExport` 自 `AddFeed.vue` **整体迁移**(parseOpml → 逐分类 createCategory + addFeeds → 未分类源 → `articles.markStale()` → 成功/失败明细;导出 = exportOpml + Blob 下载)。文案、失败列表渲染逐字沿用。
- 选择器契约:`[data-opml-import]`(file input)、`[data-opml-export]`(导出按钮)。
- 样式:按钮态(边框圆角 hover)含深浅配对;消息条/失败列表沿用 AddFeed 现样式。

### 帮助
- 「查看快捷键」按钮(`[data-shortcut-help-open]`)→ `useShortcutHelp().openShortcutHelp()`。
- **设置页自挂 `<ShortcutHelp />`**(沿用该组件「宿主视图挂载、离开自动关」的既有生命周期设计,`onUnmounted(closeShortcutHelp)` 保持逐字);不改 Inbox/App,不引入全局挂载。

## 3. 添加订阅页(`AddFeed.vue`)

- 移除 OPML 标签页整体:`tab` 联合类型去 `"opml"`、tab 按钮、`v-else` 模板分支、`importOpml`/`doExport`、`parseOpml`/`exportOpml`/`OpmlFeed` import。
- 连带清理:`onMounted` 的 `store.load()` 预载(其唯一目的是导出完整性提示「订阅列表加载失败,导出可能不完整」,导出已迁走)→ 移除 onMounted 与其文案;`onMounted` import 一并清理。
- 保留:单个添加、批量添加、发现、直接订阅全部行为逐字不动。

## 4. 测试

- `add-feed.test.ts`:「AddFeed OPML 导入」describe(1 用例)**整体迁移**至 settings 测试(夹具 OPML 文本、File 桩、判据「导入完成:成功 2 个源」+ `stale===true` 不变,仅挂载点换页)。
- `sidebar-actions.test.ts`:「快捷键」按钮用例**替换**为底栏断言:含「设置」「刷新订阅」,不含「导入 / 导出 OPML」「快捷键」;文件顶部 `useShortcutHelp` import 如因此未用则移除。
- settings 测试新增 3 用例:①订阅数据区块存在;②点 `[data-opml-export]` 触发下载(stub `URL.createObjectURL` 断言调用);③点 `[data-shortcut-help-open]` → 单例 `showShortcutHelp===true` 且 `[data-shortcut-help]` 浮层出现(收尾复位单例)。settings 测试 mock 需补 `POST /api/categories`、`POST /api/feeds` 与 GET categories/feeds/stats(形状抄 add-feed.test)。
- 计数:web 270 → **272**(−1 迁移出、±0 侧栏替换、+3 新增,以实际运行为准);worker 146 不变;合计 418。

## 5. 验收

- Chrome 浅/深:侧栏底栏仅两项截图;设置页「订阅数据」「帮助」区块截图;点「查看快捷键」浮层在设置页打开并截图;零异常。
- 全量 418 保绿 + typecheck + build。

## 6. 明确不做(YAGNI)

- 移动端 `MoreSheet` 的「快捷键」入口不动(移动端路径,不在「左侧」范围)。
- Inbox/App 零改动(浮层宿主惯例保持);不新增偏好;AddFeed 行为除 OPML 移除与预载清理外零变化。
