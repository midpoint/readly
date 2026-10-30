# Fever API

Readly 实现了 Fever API 的同步子集,供 Reeder Classic、Unread、FeedMe、Fiery Feeds、ReadKit 等客户端接入。完整契约以[设计文档](superpowers/specs/2026-10-30-fever-api-design.md)为准;本文面向配置与使用。

## 启用

1. 打开 Readly 的 **设置 → 第三方客户端(Fever API)**。
2. 点击「启用 Fever API」。Readly 会生成:
   - Fever 地址:`https://<你的 Worker 域名>/fever/`;
   - 邮箱/用户名:`readly`;
   - 密码:32 位十六进制独立密码。
3. 在客户端选择「Fever」账户类型,填入以上三项。部分客户端要求填写**完整 Fever 地址**(含 `/fever/`),不要只填域名。
4. 可随时在设置页「重置密码」或「停用」。重置会使旧密码立即失效;停用后所有 Fever 请求返回 `auth: 0`。

Fever 密码与网页登录使用的 `AUTH_TOKEN`、Google Reader 密码相互独立。密码为便于再次展示以明文存于 D1;泄露时请直接重置。

## 认证

Fever 的 `api_key` 是 `md5(username + ":" + password)` 的小写十六进制值。客户端通常把 `api_key` 放在 POST 表单中;Readly 也接受查询参数,但查询串可能进入代理或访问日志,优先使用 POST。

```bash
BASE=https://你的域名
KEY=$(printf '%s' 'readly:你的Fever密码' | md5sum | cut -d ' ' -f1)

# 认证基线
curl -s -X POST -d "api_key=$KEY" "$BASE/fever/?api"

# 读取分组、订阅与最新文章
curl -s "$BASE/fever/?api&groups&api_key=$KEY"
curl -s "$BASE/fever/?api&feeds&api_key=$KEY"
curl -s "$BASE/fever/?api&items&max_id=0&api_key=$KEY"
```

认证成功时响应至少包含:

```json
{"api_version":3,"auth":1,"last_refreshed_on_time":1790812800}
```

`last_refreshed_on_time` 是最近一次抓取订阅的 Unix 秒(没有抓取记录时为 0)。认证失败、未启用或缺少 `api_key` 时返回 **HTTP 200**:

```json
{"api_version":3,"auth":0}
```

## 端点

以下路径等价,均支持 GET 与 POST:

- `/fever`
- `/fever/`
- `/fever.php`

读参数可放在查询串或表单体;同名时表单体优先。写参数同样两者都接受。响应始终为 JSON(即使请求 `api=xml`),并带 `Cache-Control: no-store`。

## 读取

| 参数 | 返回 | 说明 |
|---|---|---|
| `groups` | `groups`, `feeds_groups` | 分类作为 group;`feeds_groups` 只包含有订阅源的分组 |
| `feeds` | `feeds`, `feeds_groups` | 订阅源;`favicon_id` 固定 0,`is_spark` 固定 0 |
| `favicons` | `favicons` | 固定空数组(Readly 不存图标字节) |
| `items` | `items`, `total_items` | 文章;每次最多 50 条 |
| `unread_item_ids` | `unread_item_ids` | 升序 CSV;无记录的文章视为未读 |
| `saved_item_ids` | `saved_item_ids` | 升序 CSV;收藏 = Readly 的 Starred |
| `links` | `links` | 固定空数组(无 Hot Links) |

可以在一次请求中组合多个读参数;也支持在同一次请求中携带写操作,Readly 会先执行写、再返回读取结果。

### items 分页

选择器优先级为 `max_id` > `with_ids` > `since_id`:

| 参数 | 行为 |
|---|---|
| `max_id=0` | 最新 50 条,id 降序 |
| `max_id=N` | `id < N` 的 50 条,id 降序 |
| `with_ids=1,2,3` | 指定文章(去重、忽略非法值、最多 50),id 升序 |
| `since_id=N` | `id > N` 的 50 条,id 升序 |
| 全部缺省 | 等价于 `since_id=0`,最旧 50 条升序 |

`total_items` 始终是 D1 中的全部文章数,不受分页影响。文章字段:

| 字段 | 说明 |
|---|---|
| `id`, `feed_id` | 正整数 |
| `title`, `author`, `url` | 字符串;作者/链接缺失时为空串 |
| `html` | 优先 `content_full`,其次 `content`、`excerpt`,最后空串 |
| `is_saved`, `is_read` | 0/1;分别对应收藏与已读 |
| `created_on_time` | 发布时间,Unix 秒 |

## 写入

写操作放在 POST 表单或查询参数中:

| 参数 | 作用 |
|---|---|
| `mark=item&id=N&as=read` | 标已读;保留首次 `read_at` |
| `mark=item&id=N&as=unread` | 标未读并清空 `read_at` |
| `mark=item&id=N&as=saved` | 收藏;保留首次 `starred_at` |
| `mark=item&id=N&as=unsaved` | 取消收藏并清空 `starred_at` |
| `mark=feed&id=N&as=read&before=T` | 该源中发布时间早于 `T` 的未读文章置读 |
| `mark=group&id=0&as=read&before=T` | 全部源 |
| `mark=group&id=N&as=read&before=T` | 指定分类(N 为 group id) |
| `mark=group&id=-1&as=read&before=T` | 无操作(Sparks 不存在) |

- `id` 支持逗号分隔的多个文章 ID(最多 50 个);不存在的 ID 忽略。
- `before` 为 Unix 秒;也接受毫秒或微秒。缺失/非法时取当前时间。
- 标记 article 的 read/unread 响应附带 `unread_item_ids`;saved/unsaved 附带 `saved_item_ids`;feed/group 置读附带 `unread_item_ids`。
- 只修改目标标记,保留 Readly 的「稍后读」等其他状态。
- Fever 的 Saved 映射为 Readly 的收藏(Starred),不会映射「稍后读」。

## 限制

- **仅同步,不管理订阅**:不能在客户端内加源、删源、改名、移动分类;也不支持 `unread_recently_read`。
- **不能触发刷新**:新文章由服务端 cron 抓取;客户端刷新只会重新拉取已有文章。
- **仅 JSON**:不支持 XML 输出。
- **无 favicon 与热点**:`favicons`/`links` 为空,feed 的 `favicon_id` 为 0;客户端会显示默认图标。
- **单用户**:一个 Readly 实例对应一个阅读库和一组 Fever 凭据。
- **密码明文存储**:为了设置页可再次展示,密码以明文存于 D1;请限制数据库访问并按需重置。
- **无速率限制**:面向单用户自托管场景。

## 排错

| 现象 | 排查 |
|---|---|
| 客户端提示用户名/密码错误 | 确认地址是完整的 `/fever/` 路径;用户名必须是 `readly`;密码以设置页当前显示为准;停用后需重新启用 |
| 请求返回 `auth: 0` | 检查 `api_key` 是否为 `md5("readly:<密码>")`;确认 Fever 已启用 |
| 登录成功但文章为空 | 确认网页端已有文章;先用 `?api&items&max_id=0` 验证;首次同步客户端可能需要多轮拉取 |
| 分组/订阅为空 | 确认网页端已有分类与订阅;客户端刷新订阅列表 |
| 客户端看不到新文章 | Fever 客户端不能触发刷新;等待后台 cron(每分钟)或网页端手动刷新 |
| XML 客户端不兼容 | Readly 仅支持 JSON,请在客户端选择 JSON/默认模式 |
| 修改密码后客户端失效 | 预期行为;在所有客户端更新为新密码 |

如果客户端同时支持 Google Reader API,通常优先使用 [Google Reader API](google-reader-api.md):它的客户端生态更活跃,支持更多同步能力。
