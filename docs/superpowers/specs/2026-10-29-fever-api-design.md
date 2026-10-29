# Readly — Fever API 支持 · 设计文档

- 日期:2026-10-29
- 状态:已评审通过(用户确认:采用独立 Fever 密码,设置页可启用/重置/停用)
- 背景:让 Reeder / Unread / FeedMe 等支持 Fever API 的第三方客户端接入 Readly。Fever 官方文档已下线,契约以 FreshRSS 镜像的官方文档为准,并参考 FreshRSS / Miniflux / Fusion 的现网实现。

## 1. 目标与范围

**做**

- Fever API 认证(`api_key = md5(username:password)`)与设置页独立凭据管理。
- 读:groups、feeds、favicons(空)、items(三种分页)、unread_item_ids、saved_item_ids、links(空)。
- 写:mark item(read/unread/saved/unsaved)、mark feed/group as read。
- 三种兼容路径:`/fever`、`/fever/`、`/fever.php`;JSON 输出。
- 部署配置 `run_worker_first` 与 README 说明。

**不做(YAGNI)**

- favicon 图片存储与下发(favicons 返回空数组,feeds.favicon_id 固定 0;客户端回退默认图标)。
- Hot Links / Sparks / Kindling 特殊源(links 返回空数组;group id -1 为无操作)。
- XML 输出(仅 JSON;与 Miniflux 一致)。
- 通过 API 增删改订阅、删除文章、`unread_recently_read`。
- 客户端触发订阅刷新(仍由现有 cron 刷新)。
- 映射 Readly 独有的「稍后读」(Fever 无对应概念)。

## 2. 认证与凭据

### 2.1 凭据存储

- 新增设置键 `SETTING_KEYS.feverAuth = "fever_auth"`,值为 `{ username: string, password: string }` 或 `null`。
- 邮箱固定常量 `FEVER_USERNAME = "readly"`;密码为 16 字节随机数的 32 位小写 hex(设置页经 `crypto.getRandomValues` 生成)。
- 未启用(键缺失/`null`/字段非法)→ Fever 端点一律返回 `auth: 0`。
- 密码以明文存 D1:仅用于在设置页再次展示,便于用户回填客户端;其等价于客户端访问凭据,泄露即重置。文档中注明。

### 2.2 校验

- 客户端提交 `api_key = md5(username + ":" + password)`,可为查询参数或表单字段。
- Web Crypto 不支持 MD5,新增 `worker/src/lib/md5.ts`(纯 JS,UTF-8 输入,输出小写 hex),以 RFC 1321 向量 + 含中文向量测试。
- 计算期望值后与提交值都转小写,再用现有 `timingSafeEqualStr` 常量时间比较。
- 失败、缺 `api_key`、Fever 未启用 → **HTTP 200** `{"api_version":3,"auth":0}`(Fever 惯例,客户端据此判定失败),不区分原因。
- 成功基线:`{"api_version":3,"auth":1,"last_refreshed_on_time":<number>}`;`last_refreshed_on_time = max(feeds.last_fetched_at)` 的 Unix 秒,无数据为 0。

### 2.3 与 AUTH_TOKEN 的关系

- `/fever*` 不在 `/api/*` 下,不经过 `authMiddleware`;由 Fever 自身认证。
- `/api/*` 的 Bearer 令牌校验完全不变。

## 3. API 契约

### 3.1 端点与请求解析

- 路径:`/fever`、`/fever/`、`/fever.php`,注册 GET 与 POST;三者同一处理器。
- 参数 = URL 查询参数 ∪ 表单体(`application/x-www-form-urlencoded` 或 `multipart/form-data`),同名时表单体优先。`?api` 参数忽略(客户端惯例)。动作以「键存在」判定,值为空字符串同样有效(`feeds=`、`groups=` 等)。
- 仅接受字符串参数值;非字符串忽略。
- 响应:`Content-Type: application/json; charset=utf-8`,`Cache-Control: no-store`。除鉴权失败外不使用非 200 状态码;数据库异常沿用全局 500。
- 一次请求可同时携带写动作与读参数:先执行写动作,再按固定顺序附加读区块。

### 3.2 读动作

| 参数 | 响应附加字段 | 说明 |
|---|---|---|
| `groups` | `groups`, `feeds_groups` | `groups:[{id,title}]` = 分类(按 sort_order,id);`feeds_groups:[{group_id,feed_ids}]`,`feed_ids` 为升序 CSV;仅输出有源的分类 |
| `feeds` | `feeds`, `feeds_groups` | `feeds:[{id,favicon_id:0,title,url,site_url,is_spark:0,last_updated_on_time}]`;`site_url` 无值为 `""`;`last_updated_on_time` 为 `last_fetched_at` 的 Unix 秒,无值为 0 |
| `favicons` | `favicons: []` | Readly 不存图标字节 |
| `items` | `items`, `total_items` | 见 3.3 |
| `unread_item_ids` | `unread_item_ids` | 升序 CSV 字符串,含无状态行的文章;全已读为 `""` |
| `saved_item_ids` | `saved_item_ids` | 升序 CSV 字符串,收藏 = `is_starred=1` |
| `links` | `links: []` | 无热点数据 |

### 3.3 items

item 形状:`{id, feed_id, title, author, html, url, is_saved, is_read, created_on_time}`

- `author`:`author ?? ""`;`url`:`url ?? ""`;`title` 原样。
- `html`:`content_full ?? content ?? excerpt ?? ""`(优先已提取全文,其次源正文,再次摘要)。
- `is_saved` = `is_starred`;`is_read` = `is_read`;无状态行视为均 0。
- `created_on_time` = `published_at` 的 Unix 秒(`Date.parse` 失败为 0)。
- `total_items` = `COUNT(*) FROM articles`(每次 items 请求都返回)。

选择器优先级 `max_id > with_ids > since_id`,每页最多 50:

| 条件 | 结果 |
|---|---|
| `max_id=0` | 最新 50 条,id 降序 |
| `max_id=N>0` | `id < N` 的 50 条,id 降序 |
| `with_ids=1,2,3` | 指定 id(去重、非正整数忽略、最多 50)按 id 升序 |
| `since_id=N` 或全缺省 | `id > N` 的 50 条,id 升序;缺省按 `N=0`(最旧 50 条) |

`max_id` 非数字或负数时忽略并回退到后续选择器;`with_ids` 全非法时返回空 `items`(仍带 `total_items`)。

### 3.4 写动作

| 参数 | 行为 | 响应附加 |
|---|---|---|
| `mark=item&id=N&as=read` | 置读,`read_at` 保留首次(COALESCE) | `unread_item_ids` |
| `mark=item&id=N&as=unread` | 置未读并清空 `read_at` | `unread_item_ids` |
| `mark=item&id=N&as=saved` | 置收藏,`starred_at` 保留首次 | `saved_item_ids` |
| `mark=item&id=N&as=unsaved` | 取消收藏并清空 `starred_at` | `saved_item_ids` |
| `mark=feed&id=N&as=read&before=T` | 该源 `published_at < T` 的未读置读 | `unread_item_ids` |
| `mark=group&id=0&as=read&before=T` | 全部源 | `unread_item_ids` |
| `mark=group&id=-1&as=read&before=T` | 无操作(Sparks 不存在) | `unread_item_ids` |
| `mark=group&id=N>0&as=read&before=T` | 该分类下的源 | `unread_item_ids` |

- 单条标记只改目标标记,保留其余标记(与现有 `PATCH /api/articles/:id` 语义一致);不存在的文章 id 忽略。
- `id` 支持逗号分隔(去重、非正整数忽略、最多 50),以 `INSERT ... SELECT ... FROM articles WHERE id IN (...)` 避免给不存在的文章建状态行。
- `before` 为 Unix 秒;`T > 10^10` 时按毫秒除以 1000;缺失/非数字/≤0 时取当前时间。比较字段为 `published_at`(与下发的 `created_on_time` 一致),因此客户端时钟偏差可能导致临界条目被多标。
- `as` 非上述值、`mark` 非 item/feed/group → 不落库,仅返回基线。
- 置读写入 `read_at = 本次操作时间`(与 `mark-all-read` 一致)。

## 4. 路由与部署配置

- `worker/src/routes/fever.ts`:导出 `feverHandler(c)`;内部完成参数合并、鉴权、动作分发。
- `worker/src/index.ts`:
  ```ts
  app.on(["GET", "POST"], "/fever", feverHandler);
  app.on(["GET", "POST"], "/fever/", feverHandler);
  app.on(["GET", "POST"], "/fever.php", feverHandler);
  ```
- `worker/wrangler.toml`:`run_worker_first = ["/api/*", "/fever", "/fever/*", "/fever.php"]`——否则静态资源 + SPA 回退会把 `/fever` 变成 index.html。

## 5. 设置页(第三方客户端 · Fever API)

位置:`Settings.vue` 中「订阅数据」之后、「帮助」之前。

- onMounted 追加读取 `/api/settings`,`fever = sanitize(all[SETTING_KEYS.feverAuth])`(对象且 username/password 均为非空字符串,否则 null)。加载失败显示提示,不阻塞其他区块。
- 未启用:说明文字 + 「启用 Fever API」(`data-fever-enable`)。
- 已启用:
  - 服务器地址 `location.origin + "/fever/"`(`data-fever-endpoint`)、邮箱(`data-fever-username`)、密码(`data-fever-password`),分别带复制按钮(`data-fever-copy-endpoint|username|password`);
  - 「重置密码」(`data-fever-reset`,二次确认)、「停用」(`data-fever-disable`,二次确认)。
- 启用/重置:生成 32 位 hex 密码 → `PUT /api/settings` `{kv:{fever_auth:{username:"readly",password}}}`;停用 → `{kv:{fever_auth:null}}`。成功后才更新本地显示;失败提示「保存失败」。
- 复制用 `navigator.clipboard.writeText`,失败提示手动复制;成功提示「已复制」。
- 密码明文、等宽字体展示,便于选择复制;深浅色类名成对声明。
- 文案注明:兼容 Reeder / Unread / FeedMe 等;收藏 = 客户端 Saved;不支持 favicon / 热点;新文章由后台定时刷新。

## 6. 文件清单

| 文件 | 变更 |
|---|---|
| `worker/src/lib/md5.ts` | 新增:纯 JS MD5(UTF-8 → 小写 hex) |
| `worker/src/routes/fever.ts` | 新增:Fever 处理器 |
| `worker/src/index.ts` | 注册三条路径 |
| `worker/wrangler.toml` | `run_worker_first` 增加 Fever 路径 |
| `shared/src/index.ts` | `FeverAuth` 类型、`FEVER_USERNAME`、`SETTING_KEYS.feverAuth` |
| `web/src/views/Settings.vue` | 新区块与逻辑 |
| `worker/test/md5.test.ts` | 新增 |
| `worker/test/fever.test.ts` | 新增 |
| `web/src/views/__tests__/settings-fever.test.ts` | 新增 |
| `README.md` | 功能条目、第三方客户端配置小节、测试计数 |

无数据库迁移(复用 `settings` 表)。

## 7. 测试

### 7.1 worker

- MD5 向量:`""`、`"abc"`、`"message digest"`、`"readly:<32hex>"`、`"中文"`。
- 鉴权:正确 key(auth 1 + 数字 last_refreshed_on_time);错误/缺失 key、未配置、配置为 null → auth 0;大小写 hex 均可。
- 路径:`/fever`、`/fever/`、`/fever.php`;GET 查询参数与 POST 表单体(含空值动作键,模拟 Unread 行为)。
- feeds/groups:分类与源形状、`feeds_groups` 只含非空分类、未分类源不出现、favicon_id/is_spark/site_url 缺省。
- favicons/links:空数组。
- items:五种选择器与排序、50 条上限、total_items、html 三级回退、is_read/is_saved、created_on_time。
- ids:未读/收藏 CSV 升序,含无状态行,空集为 `""`。
- mark:单条四种 as(保留其他标记、清空时间戳)、feed/group 的 before 过滤、group 0/-1/分类、毫秒归一、非法 as 不落库、响应附带正确 ids。
- 安全:`/api/articles` 无 Bearer 仍 401;Fever 路径无 Bearer 可访问。
- 响应头:no-store。

### 7.2 web

- 未启用状态 → 点启用:PUT 请求体精确为 `{kv:{fever_auth:{username:"readly",password:/^[0-9a-f]{32}$/}}}`(与 worker 读取同键,双端契约断言),并出现三项凭据。
- 已有配置从 GET `/api/settings` 渲染。
- 重置:新密码与旧不同,PUT 两次。
- 停用:PUT `{kv:{fever_auth:null}}`,回到未启用状态。
- 复制按钮写入预期文本(stub `navigator.clipboard`)。

### 7.3 验收

- `pnpm build && pnpm -r test && pnpm -r typecheck` 全绿(计数以实际为准并更新 README)。
- headless Chrome 浅/深截图:设置页 Fever 区块未启用/已启用两态;启用流程、重载后仍显示、重置、停用。
- 本地实例 curl 走一遍 Reeder 式同步:auth → groups/feeds → items(since_id)→ mark item → unread_item_ids 回读 → mark feed/group。

## 8. 已知接受项

- favicons 为空、feed.favicon_id 为 0(非正数),客户端显示默认/空白图标。
- 客户端不能触发刷新,新文章延迟取决于现有 cron(每分钟)。
- `before` 基于 `published_at`,客户端时钟偏差会影响临界文章。
- Fever 密码在 D1 明文存储(为了可再次展示),与「AI 密钥云同步」同级风险面;泄露后需在设置页重置。
- `/fever` 无速率限制(单用户自托管)。
- MD5 仅为协议兼容,不用于存储安全。
- 不支持 XML 输出;请求 `api=xml` 仍返回 JSON。
