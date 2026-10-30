# Readly

自托管 RSS 阅读器。订阅管理、全文抓取、事件聚类、关键词监控、AI 摘要,以及 Google Reader API / Fever API 第三方客户端同步,运行在一个 Cloudflare Worker + D1 上。

- 前端:Vue 3 + Pinia + Tailwind CSS v4(PWA)
- 后端:Cloudflare Worker + D1(单 Worker 部署,含静态资源)
- 运行时:除可选的 AI 服务商外,无第三方运行时服务
- 测试:497 项(worker 213 + web 284)
- 许可:MIT

## 目录

- [快速开始](#快速开始)
- [功能](#功能)
- [架构](#架构)
- [第三方客户端](#第三方客户端)
- [部署到 Cloudflare](#部署到-cloudflare)
- [本地开发与测试](#本地开发与测试)
- [文档](#文档)
- [安全与限制](#安全与限制)
- [常见问题](#常见问题)
- [License](#license)

## 快速开始

### 本地运行

要求 Node.js 22+、pnpm 10。

```bash
pnpm install
pnpm build
pnpm --filter @readly/worker run d1:migrate:local
pnpm dev
```

打开 <http://localhost:5173>。`pnpm dev` 会同时启动 Vite(5173)和 Worker(8787),前端 API 请求由 Vite 代理到 Worker。首次运行必须先构建 `web/dist`;worker 的静态资源与测试都依赖它。

未设置 `AUTH_TOKEN` 时本地不校验令牌。需要令牌校验时,复制 `worker/.dev.vars.example` 为 `worker/.dev.vars` 并修改。更多说明见[开发指南](docs/development.md)。

## 功能

| 模块 | 能力 |
|---|---|
| 订阅管理 | RSS/Atom、OPML 导入导出、批量加源、站点自动发现、分类管理;源地址可随时修改(保存即抓取校验);自动识别 GBK/GB2312/Big5/UTF-16 等编码 |
| 阅读体验 | 亮/暗/跟随系统、12 色强调色与自定义颜色、5 套阅读主题;中文文章默认书籍式排版(首行缩进、两端对齐、标点挤压),字号/行距/宽度/字体可调;三栏分隔线拖拽、卡片/列表布局 |
| 阅读管理 | 未读/收藏/稍后读、日期分组、未读数实时同步、按 3 天/1 周/1 月/1 年批量标已读 |
| 全文抓取 | 摘要过短时自动抓取原文,也可手动抓取;浏览器端 Readability 提取,Worker 仅做代理 |
| 事件聚类 | 本地把内容相近的新闻归为事件组,范围与相似度可调;IndexedDB 保留 1000 篇镜像 |
| 关键词监控 | 普通词/正则、大小写、颜色规则;列表打点、正文高亮,可查看每条规则的命中文章 |
| AI 摘要 | OpenAI 兼容服务商,流式生成要点摘要;支持直连与 Worker 代理;密钥默认只存本机 |
| PWA | 可安装、应用壳离线可用;提供图标生成与构建产物校验脚本 |
| 第三方客户端 | Google Reader API 与 Fever API 核心同步:订阅、分类/分组、文章、已读/收藏写操作 |

### AI 网络路径与密钥

- **直连模式**:浏览器直接请求你填写的 `baseUrl`,适合 Ollama、LM Studio 等本地/局域网服务。
- **代理模式**:请求经 Worker 转发,拒绝内网地址(SSRF 防护),适合公网服务商;两种模式都有 120 秒超时。
- 默认密钥只存本机浏览器;开启「密钥云同步」后,服务商配置(含密钥)会写入 D1,便于新设备恢复。关闭时 D1 副本不含密钥。

## 架构

```text
浏览器 SPA ── /api/* ──────────────> Worker(令牌鉴权)──> D1
     │                                ├─ /accounts、/reader/*、/fever* ──> 第三方客户端 API
     │                                └─ /api/ai/chat(代理模式)──> AI 服务商
     └─ AI 直连(可选)────────────────────────────────────────> AI 服务商
Worker cron(每分钟)──> 抓取到期订阅 ──> 解析/去重 ──> D1
```

- 单 Worker 同时托管 SPA 静态资源、REST API 与两种第三方客户端 API;状态集中在 D1。
- 聚类、关键词匹配、正文提取在浏览器端完成,以适配 Workers 免费版约 10ms 的单次 CPU 限制。
- PWA 缓存应用壳;最近 1000 篇文章镜像存入 IndexedDB,用于事件聚类与关键词匹配;文章浏览仍需网络。
- 详细组件、数据流与设计取舍见[架构说明](docs/architecture.md)。

## 第三方客户端

兼容 Google Reader API 的客户端(Reeder、FeedMe、NewsFlash 等)可以接入 Readly。在 **设置 → 第三方客户端(Google Reader API)** 启用后获得:

- 服务器地址:`https://<你的 Worker 域名>`(自定义域名同理)
- 邮箱:`readly`
- 密码:设置页生成的 32 位十六进制独立密码;可随时重置或停用

在客户端选择「Google Reader」账户类型并填入以上三项。已读与收藏(Starred)双向同步,Readly 的分类会显示为 label。

支持范围是**核心同步**:不支持在客户端内添加/删除/改名/移动订阅,不能触发刷新(新文章由服务端 cron 抓取),仅 JSON 输出(无 XML),不支持 Broadcast 等扩展。密码为便于再次展示以明文存于 D1,泄露后请在设置页重置。

完整端点、兼容性与排错见 [Google Reader API 文档](docs/google-reader-api.md)。

### Fever API

兼容 Fever API 的客户端(Reeder Classic、Unread、FeedMe、Fiery Feeds、ReadKit 等)也可以在 **设置 → 第三方客户端(Fever API)** 启用独立凭据:

- Fever 地址:`https://<你的 Worker 域名>/fever/`(部分客户端要求填写完整路径)
- 邮箱/用户名:`readly`
- 密码:设置页生成的 32 位十六进制独立密码;可随时重置或停用

Fever 的 Saved 对应 Readly 收藏(Starred),分类对应 group;支持文章读取、已读/未读、收藏/取消收藏、按源/分类批量置读。与 GReader 一样,客户端内不能管理订阅或触发刷新,新文章由服务端 cron 抓取;不支持 favicon、Hot Links 与 XML。

完整端点、分页语义与排错见 [Fever API 文档](docs/fever-api.md)。

## 部署到 Cloudflare

最短路径(在仓库根执行,需已登录 Wrangler 或配置 Cloudflare API Token):

```bash
pnpm install
pnpm build
pnpm --filter @readly/worker exec wrangler d1 create readly
# 把返回的 database_id 写入 worker/wrangler.toml
pnpm --filter @readly/worker run d1:migrate:remote
pnpm --filter @readly/worker exec wrangler secret put AUTH_TOKEN
pnpm --filter @readly/worker run deploy
```

> **安全提示**:`AUTH_TOKEN` 必须设置。未设置时 Worker 不校验任何请求,实例对公网完全开放。

生产环境还可以:

- **Cloudflare Workers Builds(推荐)**:仓库连到 Worker 后,push 到 `main` 自动安装、构建、迁移并部署,无需额外 API Token。
- **GitHub Actions 手动备用**:`.github/workflows/deploy.yml`,需要两个仓库 Secrets,适合手动兜底。

配置项、D1 权限、`AUTH_TOKEN` 面板设置、免费额度与常见故障见[部署指南](docs/deployment.md)。

## 本地开发与测试

```bash
pnpm build && pnpm -r test     # worker 213 + web 284 = 497 项
pnpm -r typecheck
```

worker 测试依赖 `web/dist`,所以先执行 `pnpm build`。定时任务、单测过滤、PWA 脚本、故障排查等见[开发指南](docs/development.md)。

## 文档

完整索引见 [docs/README.md](docs/README.md);常用文档:

| 文档 | 内容 |
|---|---|
| [开发指南](docs/development.md) | 环境、脚本、测试、定时任务、排错 |
| [部署指南](docs/deployment.md) | 手动部署、Workers Builds、Actions 备用、备份与额度 |
| [Google Reader API](docs/google-reader-api.md) | 客户端配置、端点、同步范围、限制与排错 |
| [Fever API](docs/fever-api.md) | Fever 客户端配置、端点、分页、写操作与排错 |
| [架构说明](docs/architecture.md) | 组件、数据流、关键设计与安全边界 |
| [常见问题](docs/faq.md) | 令牌、多用户、备份、AI 密钥等 |
| [设计档案](docs/superpowers/README.md) | 全部设计文档与实施计划索引 |

## 安全与限制

- **单用户设计**:一个实例对应一个阅读库。多用户请部署多个实例。
- **访问令牌**:`AUTH_TOKEN` 保护 `/api/*`;未设置时所有请求放行。修改令牌后,已登录的网页需要重新输入。
- **Google Reader / Fever 密码**:为了在设置页再次展示,密码以明文存入 D1;重置密码会立即使旧客户端失效。
- **AI 密钥**:默认只存浏览器;开启云同步后才会写入 D1。使用代理模式时密钥会随请求经过 Worker。
- **数据**:订阅、文章、状态和设置都在 D1;浏览器另存访问令牌、偏好设置和(默认的)AI 密钥。请自行备份 D1。
- **客户端范围**:两种第三方 API 都仅做核心同步,不提供客户端侧订阅管理/刷新;详见对应文档。

## 常见问题

- **忘记 `AUTH_TOKEN` 怎么办?** 令牌无法从 Worker 读回;用 `wrangler secret put AUTH_TOKEN` 设置新值,然后在所有设备重新登录。
- **支持多用户吗?** 不支持。每个用户/阅读库部署一个实例。
- **怎么备份?** 网页端导出 OPML 可备份订阅;完整数据用 `wrangler d1 export` 导出 D1(含状态、设置、GReader/Fever 密码,妥善保管)。详见[部署指南](docs/deployment.md#备份与恢复)。
- **为什么客户端不能加源或刷新?** 两种第三方 API 都限定为核心同步;订阅管理和刷新由网页端/服务端 cron 负责。
- **该选 Google Reader 还是 Fever?** 客户端支持哪个就用哪个;两者都支持时优先 Google Reader(生态更活跃、支持更多同步能力)。
- **AI 密钥存在哪里?** 默认只在本机 localStorage;开启「密钥云同步」后写入 D1。直连模式不经过 Worker,代理模式经 Worker 转发。

更多问题见[常见问题](docs/faq.md)。

## License

[MIT](LICENSE)
