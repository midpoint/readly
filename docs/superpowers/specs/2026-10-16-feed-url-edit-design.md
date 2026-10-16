# Readly — 订阅源编辑网址 · 设计文档

- 日期:2026-10-16
- 状态:已评审通过(用户确认)
- 背景:源管理已有重命名/移动/删除,但源 URL 一旦录入无法修改(站点搬家、feed 路径变更时只能删源重建——会连带删除全部文章)。

## 1. 目标

在侧栏源管理菜单中新增「编辑网址」:以弹窗修改订阅源 URL,**保存即抓取校验**(与添加订阅同语义),失败就地报错、旧地址不受影响。

## 2. 非目标(YAGNI)

- 弹窗内不做「发现候选」步骤(用户已确认取最简弹窗;发现能力保留在添加订阅页)
- 不改重命名/移动/删除行为;不加新端点(扩展既有 PATCH)
- 不做文章迁移/清空:旧文章全部保留(feed_id 不变)

## 3. 服务端:扩展 `PATCH /api/feeds/:id`

新增可选字段 `url`(与 `title`/`categoryId`/`sortOrder` 同族)。处理顺序:

1. `assertSafeUrl(url.trim())`(复用 SSRF 库:格式 / 协议 / 内网地址);
2. 唯一性预检(排除自身):他源已占用 → 400 `"已订阅该源"`;UPDATE 撞 UNIQUE 约束时同样兜底 400(并发窗口);
3. 新地址与当前相同 → 直接返回当前 feed,无网络操作;
4. 以空 ETag/Last-Modified 调 `fetchFeedIntoDb(db, {id, url: 新地址, lastEtag: null, lastModified: null}, { initialLimit: 50 })`:
   - 失败 → 502,旧 URL、旧校验器、错误计数一概不动(编辑失败是输入问题,不记入源故障);
   - `initialLimit: 50` 与添加订阅一致(response 耗时受控,Workers 预算友好;后续刷新不受限);
5. 成功 → 单条 UPDATE 落库:
   - `url` = 新地址;`title` = 抓取到的标题(无则回退新地址,同 `subscribeOne`);
   - `site_url` / `icon_url` / `description` 采纳新源值;
   - `last_etag` / `last_modified` = 新抓取值(旧值对应旧 URL,必须重置);
   - `last_fetched_at` = now;`next_refresh_at` = now + 30min(同 `subscribeOne`);
   - `error_count` 清零、`last_error` 清空;
6. 返回完整 feed(含 `unread_count`,FEED_SELECT)。

既有 title/categoryId/sortOrder 行为不变;URL 流程先于小字段 SET 执行(URL 失败整体拒绝),二者可同发但编辑器只发 `{ url }`。

## 4. 数据语义

- 旧文章全部保留(feed_id 不变;「站点搬家」正是此场景)。
- `UNIQUE(feed_id, guid)` + `INSERT OR IGNORE`:同源迁移时重复项静默忽略,仅增量入库;新文章自然计入 unread_count。

## 5. 客户端

- store `feeds.ts` 新增 `editFeedUrl(feedId, url)`:PATCH `{ url }` → `load()`(与 `renameFeed` 同款);错误向上抛给弹窗展示。
- 新组件 `FeedUrlEditor.vue`:props `feed: Feed`,emits `close` / `saved`(保存成功先 `saved` 后 `close`);样式对齐 `RuleEditor/ProviderEditor`(`fixed inset-0 z-50` + `bg-black/40` + `@click.self` 关闭 + 深色文字/底色配对,纪律 2);URL 输入框预填当前地址;保存中禁用按钮;失败弹窗内红字就地报错并保持打开(如「已订阅该源」「抓取失败(HTTP 404)」「不允许访问内网地址」);成功关闭。弹窗直接调 store(错误需就地展示,不采用 RuleEditor 的 emit-save 分离式)。
- `Sidebar.vue`:两个源列表(分类内 / 未分类)的 ⋯ 菜单各加「编辑网址」,顺序:重命名 / 编辑网址 / 移动到 / 删除;点击收起菜单并打开弹窗;保存成功关闭弹窗,并由 Sidebar 标记文章列表失效(`articles.markStale()`,与加源同款——新地址可能补入新文章,返回阅读器时重拉)。

## 6. 测试

吸取 a935c3a 教训:双端接缝必须逐字段契约断言。

- worker(`test/feeds.test.ts`):
  - 改址成功:URL 更新、采纳新标题、旧文章保留、新文章入库、ETag 重置、error_count 清零;
  - 重复 URL(他源已占)→ 400,库内不变;
  - SSRF(如 `http://127.0.0.1/rss`)→ 400,库内不变;
  - 抓取失败(404)→ 502,旧 URL 与旧标题原样;
  - 同地址 → no-op 成功,零网络请求;
- web:
  - 侧栏菜单含「编辑网址」(`sidebar-actions.test.ts` 族);
  - store `editFeedUrl` 钉精确请求体 `{ url }`;
  - 弹窗:错误内联展示且不关闭;成功关闭。

## 7. 边界

- 移动端经同一侧栏 ⋯ 菜单自然可用(菜单项带 `md:` 显隐规则,与既有项一致)。
- 编辑失败不改动任何库内状态,重试无副作用。
