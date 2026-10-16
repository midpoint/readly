# Readly

自托管 RSS 阅读器:订阅管理、全文抓取、本地事件聚类与关键词监控、AI 摘要。部署于 Cloudflare Workers + D1。

- 前端:Vue 3 + Pinia + Tailwind CSS(PWA,可安装、应用壳离线可用)
- 后端:Cloudflare Worker + D1(单 Worker 部署,含静态资源);无第三方运行时服务
- 测试:409 项(worker 143 + web 266),全绿

## 功能

1. RSS/Atom 订阅:OPML 导入导出、批量加源、站点自动发现、分类管理;**源地址可随时修改**(保存即抓取校验,失败保持原地址不受影响);**自动识别源编码**(GBK/GB2312/Big5/UTF-16 等,中文标题不再乱码)
2. 阅读体验:亮/暗/跟随系统 + 12 色调色板与自定义强调色、5 套阅读主题(经典/护眼米黄/羊皮纸/夜间/高对比);**中文文章默认「书籍式排版」**(首行缩进两格、两端对齐、标点挤压,仅对中文生效,西文保持 Web 常规排版),字号/行距/宽度/字体可调;三栏分隔线拖拽调宽(双击复位)、卡片/列表两种列表布局,偏好本地即时生效并同步云端
3. 全文抓取:摘要过短时自动抓取原文(浏览器端 Readability 提取,服务端仅做代理)
4. 阅读管理:未读/收藏/稍后读、按日期分组;列表与侧栏未读数实时同步
5. 事件聚类:自动把内容相近的新闻归成事件组(本地计算,不联网),可调范围与相似度
6. 关键词监控:本地规则匹配(普通词/正则、大小写、颜色),文章列表打点、正文高亮,每条规则可查看命中文章
7. AI 摘要:自选 OpenAI 兼容服务商(国内模型可直连),流式生成要点摘要;密钥默认只存本机
8. 一键部署 Cloudflare

### AI 网络路径与密钥说明

- **直连模式**:浏览器直接请求你在设置中填写的 baseUrl,不经过服务端;本地/局域网服务(如 Ollama、LM Studio)可用此模式。
- **代理模式**:请求经 Worker 转发,并**拒绝内网地址**(SSRF 防护),适合公网服务商;两种模式都带 120 秒超时。
- 开启「密钥云同步」后,新设备会采用云端(D1)中的服务商配置;关闭时(默认)密钥只存本机浏览器。

## 项目结构

```
shared/   TypeScript 类型与常量(前后端共用)
worker/   Cloudflare Worker:API 路由、抓取/解析、D1 迁移(src/routes、src/lib、migrations)
web/      Vue 3 SPA(PWA):视图、组件、Pinia stores、本地计算模块(聚类/关键词/提取)
docs/superpowers/  设计文档与分阶段实施计划(开发过程留档,含评审结论)
```

## 本地开发

```bash
pnpm install
pnpm build                                # 先构建 web(worker 的 assets/测试都需要 web/dist)
pnpm --filter @readly/worker run d1:migrate:local
pnpm dev          # 前端 5173 + worker 8787
```

未配置 `AUTH_TOKEN` 时本地不校验令牌。可复制 `worker/.dev.vars.example` 为 `worker/.dev.vars` 以在本地启用令牌校验。

提示:`GET /__scheduled` 会被 SPA 静态资源回退吞掉(返回 index.html);本地触发定时任务请用:

```bash
curl -X POST "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

注意:`pnpm dev` 未带 `--test-scheduled`,此时该端点仍返回 `200 ok` 但**不会真正执行**;需先以 `pnpm --filter @readly/worker exec wrangler dev --test-scheduled` 启动。执行结果见 worker 日志中的 `[readly] scheduled refresh:` 行。

## PWA

生产构建产出可安装 PWA(manifest + Service Worker,应用壳离线可用):

```bash
pnpm --filter @readly/web icons        # 重新生成图标(改 logo.svg 后)
pnpm --filter @readly/web verify:pwa   # 校验构建产物中的 manifest/SW/图标
```

## 部署到 Cloudflare

```bash
pnpm install
pnpm build

cd worker
npx wrangler d1 create readly          # 记下 database_id 写入 wrangler.toml
npx wrangler d1 migrations apply readly --remote
npx wrangler secret put AUTH_TOKEN     # 设置你的访问令牌(必做)
npx wrangler deploy
```

部署后在浏览器打开 Worker 域名,输入 AUTH_TOKEN 即可使用。

浏览器要求:需较新的现代浏览器(Chrome 116+ / Safari 17.4+ / Firefox 124+)。更旧的浏览器上,AI 请求的超时信号合并会回退为内置兼容实现(直连与代理两种模式均适用),无功能损失。

### 免费额度说明

- Workers 免费版单次调用 CPU 约 10ms:刷新按 `refresh_batch_size`(默认 2)分批,cron 每分钟推进一批,客户端「刷新全部」会循环调用直至完成;订阅源较多(>50)时建议升级 Workers Paid。
- D1 免费版 5GB/每日 500 万行读,个人使用充裕。

## 自动部署(Cloudflare Workers Builds)

在 Cloudflare 后台把 Worker 连到本仓库后,push 到 `main` 即自动完成:安装依赖 → 构建 → D1 远端迁移 → `wrangler deploy`。构建在 Cloudflare 侧执行,**无需配置任何 API Token**(Workers Builds 会自动生成账户级 Token)。

接入步骤:

1. **创建 Worker 并绑定仓库**:Cloudflare 后台 → Workers & Pages → *Create application* → *Import a repository*,授权 GitHub 并选择本仓库(若已有同名 Worker 则在其 **Settings → Builds → Connect**);项目名填 `readly`。
2. **按下表配置**(monorepo 关键项):

   | 配置项 | 值 |
   |---|---|
   | Git branch | `main` |
   | Root directory | `/`(整仓:web 构建 + 根 lockfile) |
   | Build variable | `SKIP_DEPENDENCY_INSTALL` = `1` |
   | Build command | `pnpm install --frozen-lockfile && pnpm build` |
   | Deploy command | `pnpm --filter @readly/worker run d1:migrate:remote && pnpm --filter @readly/worker run deploy` |

3. **一次性准备**:

   - 创建 D1 并把 ID 写入配置:

     ```bash
     pnpm --filter @readly/worker exec wrangler d1 create readly
     # 把返回的 database_id 填入 worker/wrangler.toml,提交并推送
     ```

   - 设置 Worker 访问令牌(本地执行一次,密钥跨部署保留):

     ```bash
     pnpm --filter @readly/worker exec wrangler secret put AUTH_TOKEN
     ```

完成后,每次 push 到 `main` 自动部署。免费额度:3,000 构建分钟/月(本项目构建约 1-2 分钟)。

> 备注:若首跑时「D1 迁移」步骤报权限错(自动 Token 的迁移权限未在文档中明示),把迁移从 Deploy command 中移除即可(部署不受影响),迁移改为在本地执行 `pnpm --filter @readly/worker run d1:migrate:remote`。

### 手动备用部署(GitHub Actions)

`.github/workflows/deploy.yml` 保留为**仅手动触发**的备用通道(Actions 页 → Deploy to Cloudflare (manual fallback) → Run workflow;`worker/wrangler.toml` 的 `database_id` 仍为占位符时会友好跳过)。使用它需在仓库 Settings → Secrets and variables → Actions 配置两个 Secrets:

- `CLOUDFLARE_API_TOKEN`:Cloudflare 后台 API Tokens,选 “Edit Cloudflare Workers” 模板并追加 **D1 → Edit** 权限
- `CLOUDFLARE_ACCOUNT_ID`:Cloudflare 后台右侧栏的 Account ID

## 测试

```bash
pnpm build && pnpm -r test     # worker 143 + web 266 = 409 项
pnpm -r typecheck
```

## 设计文档

`docs/superpowers/specs/` 为已评审的设计文档,`docs/superpowers/plans/` 为分阶段实施计划(含每个功能的验收记录)。

## License

[MIT](LICENSE)
