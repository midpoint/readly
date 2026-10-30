# 架构说明

Readly 是单用户、自托管的 RSS 阅读器。目标是用尽量少的运行时组件提供完整的订阅、阅读、检索与第三方客户端同步能力:一个 Cloudflare Worker、一个 D1 数据库,以及可选的 AI 服务商。

## 总览

```text
                        ┌──────────────────────────────┐
浏览器 SPA ── /api/* ──>│ Worker                        │──> D1
   │                    │  ├─ /api/*(Bearer AUTH_TOKEN) │
   │                    │  ├─ /accounts、/reader/*      │
   │                    │  │   (Google Reader API)      │
   │                    │  ├─ /fever* (Fever API)       │
   │                    │  └─ /api/ai/chat(代理模式)    │──> AI 服务商
   │                    └──────────────────────────────┘
   └─ AI 直连(可选)────────────────────────────────────> AI 服务商

Worker cron(每分钟)──> 抓取到期订阅 ──> 解析/去重 ──> D1
```

Worker 同时承担五类职责:

1. **静态资源**:`web/dist` 通过 Workers Assets 托管;非白名单路径回退到 `index.html`,由 Vue Router 接管。
2. **REST API**:`/api/*`,由 `AUTH_TOKEN` 保护;覆盖订阅、文章、状态、设置、AI 代理等。
3. **Google Reader API**:`/accounts`、`/reader/*`,使用设置页生成的独立凭据;详见 [Google Reader API 文档](google-reader-api.md)。
4. **Fever API**:`/fever`、`/fever/*`、`/fever.php`,使用另一组独立凭据;详见 [Fever API 文档](fever-api.md)。
5. **定时任务**:Cron Trigger 每分钟推进一批到期订阅的抓取。

`worker/wrangler.toml` 的 `run_worker_first` 将 `/api/*`、`/accounts`、`/accounts/*`、`/reader`、`/reader/*`、`/fever`、`/fever/*`、`/fever.php` 排除在 SPA 回退之外,保证 API 不会被静态资源吞掉。

## 运行时组件

### Web(浏览器端)

- Vue 3 + Vue Router + Pinia + Tailwind CSS v4,构建为可安装 PWA。
- 视图与组件在 `web/src/views`、`web/src/components`;状态在 `web/src/stores`。
- 重计算放在浏览器端:
  - `web/src/modules/cluster.ts`:事件聚类;
  - `web/src/modules/keywords.ts`:关键词匹配;
  - `web/src/modules/extract.ts` + `@mozilla/readability`:正文提取;
  - `web/src/modules/idb.ts`:IndexedDB 文章镜像(窗口 1000 篇),供事件聚类与关键词匹配(不是离线文章缓存)。
- 渲染文章 HTML 前经 DOMPurify 清洗(`web/src/modules/render.ts`),不信任服务端存储的 HTML。
- 偏好设置默认写 localStorage;缺失时从 `/api/settings` 拉取,变更后防抖回写。

### Worker(服务端)

- Hono 路由,入口 `worker/src/index.ts`;路由在 `worker/src/routes/`,可复用逻辑在 `worker/src/lib/`。
- `/api/*` 统一经过 `worker/src/auth.ts` 的 Bearer Token 中间件;比较使用常量时间实现。
- 抓取与解析:
  - `lib/http.ts`:带超时/大小限制的请求;
  - `lib/charset.ts`:头 charset → XML 声明 → BOM → UTF-8 的级联解码,覆盖 GBK/Big5 等;
  - `lib/feed-parser.ts`:RSS/Atom 解析;
  - `lib/refresh.ts`:到期源调度、条件请求(ETag/Last-Modified)、增量入库与错误计数。
- 安全:
  - `lib/ssrf.ts`:AI 代理只允许公网目标,拒绝重定向绕过;
  - `lib/greader.ts`:GReader 凭据派生与条目形状;
  - `lib/md5.ts`:Fever `api_key` 协议所需的 MD5(仅兼容用途);
  - `/reader/*` 与 `/fever*` 响应带 `Cache-Control: no-store`。
- 静态资源与 SPA 回退由 Workers Assets 处理;`/api` 的 404/错误返回 JSON。

### Shared(前后端共享)

`shared/src/index.ts` 存放前后端共用的类型与常量,例如阅读偏好、AI 服务商、设置键、GReader/Fever 凭据形状。修改共享契约时必须同时检查 worker 与 web 两侧。

### D1 数据模型

迁移在 `worker/migrations/`,当前核心表:

| 表 | 用途 |
|---|---|
| `categories` | 分类(名称、排序) |
| `feeds` | 订阅源(URL、标题、站点、分类、抓取状态、ETag/Last-Modified、错误信息) |
| `articles` | 文章(标题、作者、发布时间、摘要、正文、全文、语言、AI 摘要等) |
| `article_states` | 已读/收藏/稍后状态与对应时间戳 |
| `settings` | 键值设置(阅读偏好、AI 服务商、GReader/Fever 凭据等,值为 JSON) |

关键约束:

- `feeds.url` 唯一;`articles` 以 `(feed_id, guid)` 唯一,重复抓取不会重复入库。
- `articles` 删除时级联删除 `article_states`;删除订阅源时级联删除文章。
- `published_at` 使用 ISO 8601 字符串存储,分页与按时间过滤使用字典序比较。
- 设置值在 `settings.value` 中存 JSON;GReader/Fever 密码与(开启云同步时的)AI 密钥也在此表中,备份时需按敏感数据处理。

## 数据流

### 1. 订阅刷新

1. Cron 每分钟触发 `scheduled`,调用 `refreshDueFeeds`。
2. 按 `next_refresh_at` 选出到期源,默认每批 2 个(`refresh_batch_size`),避免超过免费版 CPU 限制。
3. 发起条件请求;按响应 charset 解码;解析 RSS/Atom。
4. 以 `(feed_id, guid)` 去重后插入新文章,更新源元数据、下次刷新时间与错误计数。
5. 前端「刷新全部」会循环调用刷新接口直至没有剩余源。

### 2. 网页阅读

1. SPA 用 `AUTH_TOKEN` 调用 `/api/feeds`、`/api/articles`、`/api/stats` 等接口。
2. 文章状态写入 `article_states`;列表与侧栏未读数从同一状态表聚合。
3. 偏好设置写入 `settings`;浏览器 localStorage 作为快速恢复来源。
4. 文章列表镜像写入 IndexedDB,供事件聚类与关键词匹配使用;它不承担离线阅读。

### 3. Google Reader 客户端同步

1. 客户端用设置页生成的用户名/密码调用 `ClientLogin`,得到 `Auth` 值。
2. 后续请求带 `Authorization: GoogleLogin auth=<token>`;Worker 从 `settings` 读取凭据并比对派生 token。
3. 订阅/标签/未读计数/文章流从 D1 查询;已读/收藏写操作更新 `article_states`。
4. 范围限定为核心同步:客户端不能增删改订阅,也不能触发刷新。

### 4. Fever 客户端同步

1. 客户端把 `api_key = md5("readly:<Fever 密码>")` 放在 POST 表单或查询参数中。
2. Worker 从 `settings.fever_auth` 读取凭据,计算并常量时间比较 MD5;失败仍返回 HTTP 200 `auth: 0`。
3. 客户端按 `max_id` / `since_id` / `with_ids` 分页读取 groups、feeds 与 items;写操作更新 `article_states` 并返回未读/收藏 ID 列表。
4. 范围同样限定为核心同步:不支持订阅管理、客户端触发刷新、favicon、Hot Links 与 XML。

### 5. AI 摘要

1. 浏览器从设置中读取当前服务商配置。
2. 直连模式由浏览器请求服务商;代理模式请求 `/api/ai/chat`,Worker 校验目标地址后转发。
3. 摘要结果写入文章缓存(`articles.ai_summary`),并展示在阅读区。

## 关键设计取舍

- **单 Worker + D1**:减少部署与运维面;静态资源、API、GReader、Fever 同源,客户端只需一个域名。
- **重计算放客户端**:Workers 免费版单次 CPU 约 10ms,聚类、关键词、正文提取不适合放在服务端。
- **单用户令牌**:`AUTH_TOKEN` 是一个共享访问令牌,不提供账户体系;定位是个人自托管。多用户需要多实例。
- **第三方客户端独立凭据**:GReader 与 Fever 各有一组密码,与 `AUTH_TOKEN` 分离,便于单独停用/轮换而不影响网页登录。
- **无 ORM**:D1 语句直接写在路由/库中,迁移用 SQL 文件,便于审计和适配 D1 限制(如批量绑定参数上限)。
- **渐进式增强**:PWA 只缓存应用壳;文章数据经 API 获取,IndexedDB 镜像仅服务聚类/关键词等本地计算;写操作需要网络。

## 目录职责

```text
shared/src/          前后端共享类型、常量、设置键
worker/src/routes/   REST、Google Reader、Fever 路由
worker/src/lib/      抓取、解析、字符集、SSRF、GReader/Fever 纯函数等
worker/migrations/   D1 迁移 SQL
web/src/views/       页面级视图
web/src/components/  UI 组件
web/src/stores/      Pinia 状态
web/src/modules/     客户端计算、提取、PWA/IDB、主题等
docs/                使用、开发、部署与设计档案
```

## 扩展方式

新增功能时通常需要:

1. 在 `shared/src` 增加共享类型/设置键(仅当前后端都要用)。
2. 在 `worker/src/routes` 增加路由,并在 `worker/src/index.ts` 挂载;必要时增加 `worker/migrations/` 迁移。
3. 在 `web/src/stores`/`views`/`components` 接入;涉及 HTML 渲染时继续走 DOMPurify。
4. 补 worker 集成测试与 web 组件测试,执行 `pnpm build && pnpm -r test && pnpm -r typecheck`。

Google Reader API 的契约以 [设计文档](superpowers/specs/2026-10-29-google-reader-api-design.md) 为准;Fever API 的契约以 [设计文档](superpowers/specs/2026-10-30-fever-api-design.md) 为准。修改端点行为前先更新对应文档与测试。
