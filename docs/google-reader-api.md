# Google Reader API

Readly 实现了 Google Reader API 的**核心同步**子集,供 Reeder、FeedMe、NewsFlash 等客户端接入。完整契约以[设计文档](superpowers/specs/2026-10-29-google-reader-api-design.md)为准;本文面向配置与使用。

Readly 也提供独立的 [Fever API](fever-api.md);客户端只支持 Fever 时可使用后者。

## 启用

1. 打开 Readly 的 **设置 → 第三方客户端(Google Reader API)**。
2. 点击「启用 Google Reader API」。Readly 会生成:
   - 服务器地址:当前站点地址(Worker 域名或自定义域名);
   - 邮箱/用户名:`readly`;
   - 密码:32 位十六进制独立密码。
3. 在客户端选择「Google Reader」账户类型,填入以上三项。
4. 可随时在设置页「重置密码」或「停用」。重置会使旧密码立即失效;停用后所有 GReader 客户端返回 401。

密码与网页登录使用的 `AUTH_TOKEN` 相互独立。密码为便于再次展示以明文存于 D1;泄露时请直接重置。

## 认证

客户端可以用 `ClientLogin` 获取访问令牌:

```bash
BASE=https://你的域名
TOKEN=$(curl -s -X POST \
  -d 'Email=readly&Passwd=你的GReader密码' \
  "$BASE/accounts/ClientLogin" | sed -n 's/^Auth=//p')

curl -s -H "Authorization: GoogleLogin auth=$TOKEN" \
  "$BASE/reader/api/0/user-info"
```

`ClientLogin` 返回纯文本:

```text
SID=...
LSID=...
Auth=<token>
```

后续 `/reader/*` 请求都带 `Authorization: GoogleLogin auth=<token>`。`/reader/api/0/token` 返回 CSRF token(纯文本),写操作客户端可能会带上 `T` 参数。

## 支持的端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/accounts/ClientLogin` | 用户名密码换 `SID`/`LSID`/`Auth` |
| GET | `/reader/api/0/token` | 返回 CSRF token 文本 |
| GET | `/reader/api/0/user-info` | 当前用户信息 |
| GET | `/reader/api/0/subscription/list` | 订阅列表;分类出现在 `categories` |
| GET | `/reader/api/0/tag/list` | 标签列表(含分类 label) |
| GET | `/reader/api/0/unread-count` | 未读计数;`all=1` 包含零未读项 |
| GET | `/reader/api/0/stream/items/ids` | 文章 ID 列表,支持过滤与分页 |
| GET/POST | `/reader/api/0/stream/contents/<stream>` | 文章流内容 |
| GET/POST | `/reader/api/0/stream/items/contents` | 按重复的 `i` 参数批量取文章,保持请求顺序 |
| POST | `/reader/api/0/edit-tag` | 添加/移除已读、收藏 |
| POST | `/reader/api/0/mark-all-as-read` | 按流批量标已读,可用 `ts` 限定截止时间 |

所有 `/reader/*` 响应带 `Cache-Control: no-store`。列表与文章流返回 JSON;`ClientLogin`、`token` 与写操作的成功响应是纯文本。

## 文章流

| `s` 参数 | 内容 |
|---|---|
| `user/-/state/com.google/reading-list` | 全部文章 |
| `user/-/state/com.google/read` | 全部文章(协议兼容映射) |
| `user/-/state/com.google/kept-unread` | 全部文章(协议兼容映射) |
| `user/-/state/com.google/starred` | 仅收藏 |
| `feed/<十进制 id>` | 指定订阅源;`id` 来自 `subscription/list` |
| `user/-/label/<名称>` | 指定分类;名称需 URL 编码 |
| 其他 | 返回空结果 |

流 ID 同时兼容 `user/-/...` 和 `user/<用户 id>/...`(例如把 `user-info` 返回的 `userId` 拼进流 ID);实际数据范围由当前认证用户决定。

常用过滤参数:

| 参数 | 含义 |
|---|---|
| `xt` | 排除带指定标签的文章,例如 `xt=user/-/state/com.google/read` |
| `it` | 只保留带指定标签的文章,例如 `it=user/-/state/com.google/starred` |
| `ot` | 起始时间(下界):只返回不早于该时间的文章;支持 Unix 秒/毫秒/微秒 |
| `nt` | 截止时间(上界):只返回不晚于该时间的文章;支持 Unix 秒/毫秒/微秒 |
| `n` | 数量,默认 20,最大 1000 |
| `r=o` | 从旧到新;默认从新到旧 |
| `c` | 上一页返回的 `continuation` 游标 |

## 条目 ID

- 客户端应优先使用 `stream/items/ids` 或 `stream/contents` 返回的长格式 ID:
  `tag:google.com,2005:reader/item/<16 位十六进制>`。
- 也接受短 ID:16 字符且带前导 `0` 的按十六进制解析(Reeder 会回传这种左补零写法);无前导 `0` 的全数字字符串按十进制解析。真实 16 位十进制 ID(如 `1746307865812560`)不含前导 `0`,不会被误判。
- 主要时间戳:秒级为整数,毫秒/微秒为字符串,与 Google Reader 客户端习惯一致。

## 写操作范围

`edit-tag` 支持添加/移除两种状态标签:

- `user/-/state/com.google/read`
- `user/-/state/com.google/starred`

其他标签(包括自定义 label)不会改变 Readly 的分类或状态。`mark-all-as-read` 支持 `s` 指定流,`ts` 可选(秒/毫秒/微秒;缺省/非法时取当前时间),只标记早于该时间的未读文章。

## 限制

- **仅核心同步**:不支持在客户端内订阅、退订、改名、移动分类,也不支持 `quickadd`/`subscription/edit`。
- **不能触发刷新**:新文章由服务端 cron 抓取;客户端刷新只会重新拉取已有文章。
- **仅 JSON 输出**:不支持 `output=xml`;`ClientLogin`、`token` 与写操作成功响应为纯文本。
- **有限状态**:不支持 Broadcast、Like、Annotated、Saved Web Pages 等扩展流;未知流返回空。
- **label 按名称匹配**:分类名即 label 名称。若 D1 中存在同名分类,它们会合并为同一个 label;建议保持分类名唯一。
- **单用户**:一个 Readly 实例对应一个阅读库和一个 GReader 凭据。
- **密码明文存储**:为了设置页可再次展示,密码以明文存于 D1;请限制数据库访问并按需重置。

## 排错

| 现象 | 排查 |
|---|---|
| 401 / 无法登录 | 服务器地址填根地址(不要带 `/reader`);用户名必须是 `readly`;密码以设置页当前显示为准;停用后需重新启用 |
| 订阅列表为空 | 确认网页端已有订阅;刷新客户端;检查请求的 `Authorization` 头 |
| 某个源的文章流为空 | `feed/<id>` 使用 `subscription/list` 返回的十进制 ID,不是 RSS URL |
| label 流为空 | 对分类名做 URL 编码;确认分类下确实有文章 |
| 客户端看不到未读 | 使用 `unread-count` 或 `xt=user/-/state/com.google/read`;`read`/`kept-unread` 流本身返回全部文章 |
| 客户端无法添加订阅/刷新 | 设计限制,请用网页端管理订阅;刷新由服务端 cron 完成 |
| 修改密码后客户端失效 | 预期行为;在所有客户端更新为新密码 |
