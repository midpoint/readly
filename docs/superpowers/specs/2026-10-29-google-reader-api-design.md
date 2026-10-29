# Readly — Google Reader API 支持 · 设计文档

- 日期:2026-10-29
- 状态:已评审通过(用户确认:替换 Fever 方案;认证沿用设置页独立密码;范围为核心同步,不含客户端订阅管理)
- 背景:让 Reeder Classic、FeedMe、NewsFlash、Read You 等支持 Google Reader API 的客户端接入 Readly。该 API 无官方文档,契约以 FreshRSS 实现、Miniflux 实现及 2025 年 Reeder/NewsFlash 实测记录(davd.io)为准。

## 1. 目标与范围

**做**

- ClientLogin 认证、`GoogleLogin auth` 请求头校验、`/token`。
- 读:`user-info`、`subscription/list`、`tag/list`、`unread-count`、`stream/items/ids`、`stream/items/contents`、`stream/contents/*`。
- 写:`edit-tag`(已读/收藏增删)、`mark-all-as-read`。
- 设置页「第三方客户端(Google Reader API)」独立凭据管理。
- 部署配置 `run_worker_first` 与 README 说明。

**不做(YAGNI)**

- 客户端内订阅管理:`subscription/quickadd`、`subscription/edit`、标签重命名/删除。加源、删源、改名、移分类仍在 Readly 网页端。
- XML 输出(`output=xml` 忽略,始终 JSON)。
- OAuth、Broadcast / Annotated / Like / Saved-web-pages 流(请求返回空)。
- 客户端触发订阅刷新(仍由 cron 刷新)。
- 文章级自定义标签(Readly 无此模型;仅把分类作为 label 暴露)。
- 客户端「标记最近已读为未读」等非标准扩展。

## 2. 认证与凭据

### 2.1 凭据存储

- 新增设置键 `SETTING_KEYS.greaderAuth = "greader_auth"`,值为 `{ username: string, password: string }` 或 `null`。
- 用户名固定常量 `GREADER_USERNAME = "readly"`;密码为 16 字节随机数的 32 位小写 hex(设置页 `crypto.getRandomValues` 生成)。
- 未配置/`null`/字段非法 → 所有 GReader 端点 401(ClientLogin 同样拒绝)。
- 密码以明文存 D1,用于设置页再次展示;泄露即重置。

### 2.2 令牌

- `token = username + "/" + sha256hex(username + ":" + password)`。
- SHA-256 用 `crypto.subtle.digest`,不引入 MD5/新依赖。
- ClientLogin 成功返回该令牌;后续请求头 `Authorization: GoogleLogin auth=<token>`。
- 头解析:`/^GoogleLogin\s+auth=(.+)$/i`;令牌与期望值用 `timingSafeEqualStr` 比较。
- 失败/缺失/禁用 → 401,`text/plain` `Unauthorized`,`Cache-Control: no-store`。

### 2.3 ClientLogin

`GET|POST /accounts/ClientLogin`

- 参数:`Email`、`Passwd`;GET 从查询串,POST 支持 `application/x-www-form-urlencoded`、`multipart/form-data` 与 `application/json`。
- 精确匹配配置的用户名与密码;`Email` 大小写敏感。
- 成功(默认 `text/plain`):
  ```
  SID=<token>
  LSID=<token>
  Auth=<token>
  ```
- `output=json` → `{"SID":"<token>","LSID":"<token>","Auth":"<token>"}`(JSON)。
- 失败 → 401 `Unauthorized`。

### 2.4 其它认证端点

- `GET /reader/api/0/token` → `text/plain` 令牌(写操作 `T` 参数用)。
- 服务端**不校验 `T`**:本 API 为无 Cookie 的 Bearer 风格认证,无 CSRF 面;客户端兼容优先。

## 3. 通用约定

- 路径前缀:`/accounts/*`、`/reader/api/0/*`;均不在 `/api/*` 下,不经过 AUTH_TOKEN 中间件。
- 响应 `Cache-Control: no-store`;JSON 端点 `Content-Type: application/json; charset=utf-8`;写操作与 token 为 `text/plain`。
- 参数 = 查询参数 ∪ 表单体(重复键保留全部,查询在前、表单在后,按需 `getAll` 语义)。JSON 体仅 ClientLogin 支持。
- `output` 参数忽略,始终 JSON(ClientLogin 的 `output=json` 除外,见 2.3)。
- 时间戳:`published`/`updated` 为 Unix 秒整数;`crawlTimeMsec` 为毫秒字符串;`timestampUsec` 为微秒字符串。
- 条目 ID 三种输入格式(解析顺序):
  1. 长格式 `tag:google.com,2005:reader/item/<16 位 hex>`;
  2. 16 字符无前缀 ID:有前导 `0` 时按 hex 解析(Reeder 会回传左补零的无前缀 hex,如 `0000000000000010` → 16);
  3. 无前导 `0` 的字符串:全数字按十进制解析(如 16 位十进制 ID `1746307865812560`),其余 16 字符 hex 按 hex 解析。
  说明:十进制与 hex 的歧义通过「前导 0」区分:左补零的 16 字符形式视为 hex,真实十进制 ID 不含前导 0。
  输出长格式统一 16 位小写 hex 左补零。
- 流 ID 同时接受 `user/-/...` 与 `user/<任意用户 id>/...` 两种写法;值域由鉴权用户决定,路径中的用户 id 不参与过滤。
- 非法/缺失必需参数:对应端点返回空结果或 `OK` 无操作,不 500(ClientLogin 与鉴权除外)。

## 4. 端点契约

### 4.1 `GET /reader/api/0/user-info`

```json
{"userId":"1","userName":"readly","userProfileId":"1","userEmail":"readly","isBloggerUser":false,"signupTimeSec":0,"isMultiLoginEnabled":false}
```

### 4.2 `GET /reader/api/0/subscription/list`

```json
{
  "subscriptions": [
    {
      "id": "feed/1",
      "title": "源标题",
      "url": "https://example.com/rss",
      "htmlUrl": "https://example.com",
      "iconUrl": "https://example.com/icon.png",
      "categories": [{"id": "user/-/label/科技", "label": "科技", "type": "folder"}]
    }
  ]
}
```

- `id` 为 `feed/<feeds.id>`;`url` 为订阅地址;`htmlUrl = site_url ?? ""`;`iconUrl = icon_url ?? ""`;未分类 `categories: []`。
- 按 `feeds.sort_order, feeds.id` 排序。

### 4.3 `GET /reader/api/0/tag/list`

```json
{
  "tags": [
    {"id": "user/-/state/com.google/starred"},
    {"id": "user/-/state/com.google/read"},
    {"id": "user/-/state/com.google/reading-list"},
    {"id": "user/-/state/com.google/kept-unread"},
    {"id": "user/-/label/科技", "label": "科技", "type": "folder"}
  ]
}
```

- 系统标签固定四项在前;分类 label 按 `sort_order, id` 追加;无分类数据时仅四项。

### 4.4 `GET /reader/api/0/unread-count`

```json
{
  "max": 7,
  "unreadcounts": [
    {"id": "feed/1", "count": 5, "newestItemTimestampUsec": "1760000000000000"},
    {"id": "user/-/label/科技", "count": 6, "newestItemTimestampUsec": "1760000000000000"},
    {"id": "user/-/state/com.google/reading-list", "count": 7, "newestItemTimestampUsec": "1760000001000000"}
  ]
}
```

- `max` = reading-list 未读数。
- `newestItemTimestampUsec` = 该范围内最新文章的 `published_at` 微秒字符串,无文章为 `"0"`。
- `all=1` 时包含未读数为 0 的 feed 与 label;否则只输出 `count > 0` 的 feed/label。
- reading-list 条目始终输出。

### 4.5 `GET /reader/api/0/stream/items/ids`

参数:

| 参数 | 说明 |
|---|---|
| `s` | 流 ID(必需);缺失返回 `{"itemRefs":[]}` |
| `n` | 条数,默认 20,上限 1000;非法取默认 |
| `ot` | 只返回 `published_at >= ot`(时间下界;接受 Unix 秒/毫秒/微秒) |
| `nt` | 只返回 `published_at <= nt`(时间上界;接受 Unix 秒/毫秒/微秒) |
| `xt` | 排除标签,可重复;支持 `.../read`、`.../starred` |
| `it` | 包含标签,可重复;支持 `.../read`、`.../starred` |
| `r` | `r=o` 为发布时间升序,否则降序 |
| `c` | 游标(服务端产出,原样回传) |

响应:

```json
{"itemRefs": [{"id": "42"}, {"id": "41"}], "continuation": "<cursor>"}
```

- `itemRefs[].id` 为十进制字符串;有更多结果才带 `continuation`。
- `ot` 是「最早时间」(下界),`nt` 是「最晚时间」(上界),边界均包含;这是原始 Google Reader 的语义。时间参数按量级识别秒/毫秒/微秒,兼容客户端回传 `timestampUsec`。
- 排序:`published_at DESC, id DESC`(或 `r=o` 时升序)。
- `xt=read` 排除已读;`xt=starred` 排除收藏;`it=read` 仅已读;`it=starred` 仅收藏;两者可组合(先包含后排除的常规语义:同时提供时以 `it` 为包含集合、`xt` 为排除集合,SQL 中 `it` 条件 AND `xt` 条件)。多值之间为 AND。
- 游标编码:JSON `{"p": "<published_at>", "id": <id>}` → `btoa` → URL-safe(`+`→`-`,`/`→`_`,去 `=`);解码失败视为无游标。

### 4.6 `GET|POST /reader/api/0/stream/items/contents`

- 参数 `i` 可重复(查询或表单);解析三种 ID 格式,去重,最多 1000 个。
- 响应 `{"items": [...]}`,顺序与请求顺序一致;不存在的 id 跳过。
- 无 `i` → `{"items":[]}`。

### 4.7 `GET|POST /reader/api/0/stream/contents/*`

- 路径剩余部分为 stream ID(URL 解码后);支持含 `/` 的流 ID。
- 其余参数与 4.5 相同(含 `c`),响应:

```json
{"id": "<streamId>", "updated": 1760000000, "items": [...], "continuation": "<cursor>"}
```

- `updated` 为当前 Unix 秒;有更多结果才带 `continuation`。
- 与 4.5 共享查询构造;`n` 上限 1000。

### 4.8 item 形状

```json
{
  "id": "tag:google.com,2005:reader/item/000000000000002a",
  "title": "标题",
  "author": "作者或空串",
  "published": 1760000000,
  "updated": 1760000000,
  "crawlTimeMsec": "1760000000000",
  "timestampUsec": "1760000000000000",
  "alternate": [{"href": "https://example.com/post", "type": "text/html"}],
  "canonical": [{"href": "https://example.com/post"}],
  "summary": {"direction": "ltr", "content": "摘要或空串"},
  "content": {"direction": "ltr", "content": "<p>正文</p>"},
  "categories": [
    "user/-/state/com.google/reading-list",
    "user/-/state/com.google/read",
    "user/-/state/com.google/starred",
    "user/-/label/科技"
  ],
  "origin": {"streamId": "feed/1", "title": "源标题", "htmlUrl": "https://example.com"}
}
```

- `content.content`:`content_full ?? content ?? excerpt ?? ""`。
- `summary.content`:`excerpt ?? ""`。
- `alternate/canonical` 的 href:`url ?? ""`。
- `categories`:始终含 reading-list;已读加 read;收藏加 starred;源有分类时加对应 label。
- `origin.htmlUrl = site_url ?? ""`。
- `author = author ?? ""`;`title` 原样(非空)。

### 4.9 `POST /reader/api/0/edit-tag`

- 表单参数:`i`(可重复)、`a`(可重复,添加标签)、`r`(可重复,移除标签)、`T`(忽略)。
- 标签语义:
  - `user/-/state/com.google/read`:添加 → 已读(`read_at` 保留首次);移除 → 未读(`read_at=NULL`)。
  - `user/-/state/com.google/starred`:添加 → 收藏(`starred_at` 保留首次);移除 → 取消(`starred_at=NULL`)。
  - 其它标签(含 `user/-/label/*`、`kept-unread`、`broadcast`)忽略。
- 同一请求可同时改已读与收藏;只改目标标记、保留其余标记(与 `PATCH /api/articles/:id` 一致)。
- 不存在的文章 id 忽略。
- 响应 `text/plain` `OK`,200;无有效操作也返回 `OK`。

### 4.10 `POST /reader/api/0/mark-all-as-read`

- 表单参数:`s`(流 ID)、`ts`(截止时间,接受 Unix 秒/毫秒/微秒;非法/缺失取当前时间)、`T`(忽略)。
- 标记该流内 `published_at < ts` 的未读文章为已读(`read_at = now`),复用 `mark-all-read` 的 `INSERT ... SELECT ... ON CONFLICT` 模式。
- 流映射:
  - reading-list / read / kept-unread → 全部;
  - starred → 仅收藏;
  - `feed/<id>` → 该源;
  - `user/-/label/<名>` → 该分类(不存在则无操作);
  - 其它 → 无操作。
- 响应 `text/plain` `OK`,200。

## 5. 流映射

| stream ID | 范围 |
|---|---|
| `user/-/state/com.google/reading-list` | 全部文章 |
| `user/-/state/com.google/read` | 全部文章(客户端惯例:该流不回退为「仅已读」) |
| `user/-/state/com.google/kept-unread` | 全部文章 |
| `user/-/state/com.google/starred` | `is_starred=1` |
| `feed/<十进制 id>` | 该源 |
| `user/-/label/<分类名>` | 该分类;名称为 URL 解码后的分类名 |
| `user/-/state/com.google/broadcast` 等 | 空 |

- 无法识别的 stream → 空结果(不报错)。

## 6. 设置页(第三方客户端 · Google Reader API)

位置:`Settings.vue` 中「订阅数据」之后、「帮助」之前;实现为独立组件 `web/src/components/GoogleReaderSettings.vue`(Settings 仅挂载)。

- onMounted 读取 `/api/settings`,取 `greader_auth`,合法对象(用户名/密码均非空字符串)则进入已启用态。
- 未启用:说明 +「启用 Google Reader API」(`data-greader-enable`)。
- 已启用:
  - 服务器地址 `location.origin`(`data-greader-endpoint`)、邮箱(`data-greader-username`)、密码(`data-greader-password`),各带复制按钮(`data-greader-copy-endpoint|username|password`);
  - 「重置密码」(`data-greader-reset`,二次确认)、「停用」(`data-greader-disable`,二次确认)。
- 启用/重置生成 32 位 hex 密码,`PUT /api/settings` `{kv:{greader_auth:{username:"readly",password}}}`;停用写 `{kv:{greader_auth:null}}`;成功后才更新本地状态。
- 复制用 `navigator.clipboard.writeText`;失败提示手动复制;成功提示「已复制」。
- 文案:客户端选择「Google Reader」账户类型;仅核心同步(加源/删源仍在网页端);不支持 XML;新文章由后台定时刷新。
- 深浅色类名成对声明。

## 7. 路由与部署配置

- `worker/src/routes/greader.ts`:导出 Hono 子应用 `greader`,内含全部端点;`fever` 无关。
- `worker/src/index.ts`:`app.route("/", greader)`(路径自带 `/accounts`、`/reader` 前缀)。注册顺序在 `/api` 路由之后、`notFound` 之前。
- `worker/wrangler.toml`:`run_worker_first = ["/api/*", "/accounts", "/accounts/*", "/reader", "/reader/*"]`——否则静态资源 + SPA 回退会返回 index.html。
- 无数据库迁移(复用 `settings` 表)。

## 8. 文件清单

| 文件 | 变更 |
|---|---|
| `worker/src/routes/greader.ts` | 新增:全部 GReader 端点与认证 |
| `worker/src/index.ts` | 挂载 greader 子应用 |
| `worker/wrangler.toml` | `run_worker_first` 增加 GReader 路径 |
| `shared/src/index.ts` | `GReaderAuth` 类型、`GREADER_USERNAME`、`SETTING_KEYS.greaderAuth` |
| `web/src/components/GoogleReaderSettings.vue` | 新增:设置区块 |
| `web/src/views/Settings.vue` | 挂载新组件 |
| `worker/test/greader.test.ts` | 新增 |
| `web/src/components/__tests__/google-reader-settings.test.ts` | 新增 |
| `README.md` | 功能条目、客户端配置小节、测试计数 |

## 9. 测试

### 9.1 worker

- ClientLogin:正确凭据返回三行令牌(文本)/ `output=json` 返回 JSON;错误凭据 401;未配置 401;GET 与 POST、JSON 体。
- 令牌端点:`/token` 返回令牌;无头/错头 401;header 大小写与空格容错。
- user-info、subscription/list(含未分类与分类)、tag/list、unread-count(`all=0/1`、label、reading-list、newestItemTimestampUsec)。
- stream/items/ids:五种流、`xt=read/starred`、`it=read/starred`、`ot`/`nt`、`n` 上限、`r=o`、continuation 往返、未知流空结果。
- stream/contents:路径含斜杠的流、GET 与 POST、分页。
- stream/items/contents:重复 `i`(urlencoded 与 multipart 至少一种)、三种 ID 格式、顺序保持、缺失 id 跳过。
- edit-tag:批量 `i`、添加/移除已读、添加/移除收藏、同时改两标记、保留其它标记、label 忽略、响应 `OK`。
- mark-all-as-read:feed/label/reading-list/starred、`ts` 过滤、毫秒归一、无效流无操作、响应 `OK`。
- 安全:`/api/articles` 无 Bearer 仍 401;`/reader/*` 无 GoogleLogin 头 401。
- 响应头:`no-store`;JSON 内容类型。

### 9.2 web

- 未启用 → 启用:PUT 请求体精确为 `{kv:{greader_auth:{username:"readly",password:/^[0-9a-f]{32}$/}}}`(与 worker 读取同键),并出现三项凭据。
- 已有配置从 GET `/api/settings` 渲染。
- 重置:新密码与旧不同;停用:PUT null 并回到未启用态。
- 复制按钮写入预期文本(stub `navigator.clipboard`)。
- 加载失败显示「Google Reader 设置加载失败」。

### 9.3 验收

- `pnpm build && pnpm -r test && pnpm -r typecheck` 全绿(计数以实际为准并更新 README)。
- 本地实例 curl 走完整同步:ClientLogin → token → subscription/list → unread-count → stream/items/ids → stream/items/contents → edit-tag(已读/收藏)→ 回读验证。
- headless Chrome 浅/深截图:设置页区块未启用/已启用;启用、重载持久、重置、停用。

## 10. 已知接受项

- 不支持客户端加源/删源/改名(`subscription/edit`、`quickadd`);这些操作在 Readly 网页端。
- 仅 JSON;`output=xml` 忽略。
- `T` 令牌不校验(无 Cookie 认证面)。
- `read` 流返回全部文章(客户端惯例),不是「仅已读」。
- 文章级 label 标签忽略,分类仅作为 feed 级 label 暴露。
- 不实现 Broadcast/Annotated/Like/Saved-web-pages。
- `unread-count` 每次请求做聚合查询;单用户数据量下可接受。
- GReader 密码在 D1 明文存储(为了可再次展示),与「AI 密钥云同步」同级风险面;泄露后重置。
- `/accounts/*`、`/reader/*` 无速率限制(单用户自托管)。
- 客户端时钟偏差会影响 `mark-all-as-read` 的 `ts` 边界(早于 ts 才标已读)。
