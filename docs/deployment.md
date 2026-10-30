# 部署指南

Readly 是单个 Cloudflare Worker + 一个 D1 数据库。前端构建产物由 Worker 的 Workers Assets 托管,不需要单独的静态站点或服务器。

以下命令默认在仓库根目录执行。需要先满足:

- Node.js 22+、pnpm 10
- Cloudflare 账号
- 已执行 `wrangler login`,或已配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`

## 手动部署

### 1. 创建 D1

仓库里的 `worker/wrangler.toml` 已有一个 `database_id`,它属于原维护者的实例。**部署到自己的 Cloudflare 账号时,必须创建自己的 D1 并替换这个值**:

```bash
pnpm --filter @readly/worker exec wrangler d1 create readly
```

把命令返回的 `database_id` 写入 `worker/wrangler.toml` 的 `[[d1_databases]]` 段。`database_id` 不是密钥,但仍应对应你自己的数据库。

### 2. 构建并迁移

```bash
pnpm install
pnpm build
pnpm --filter @readly/worker run d1:migrate:remote
```

`pnpm build` 必须先执行:Worker 的 assets 目录指向 `web/dist`,构建缺失会导致部署后没有前端页面。

### 3. 设置访问令牌

```bash
pnpm --filter @readly/worker exec wrangler secret put AUTH_TOKEN
```

输入一个足够长的随机字符串。**`AUTH_TOKEN` 未设置时 Worker 不校验任何请求,实例对公网完全开放。** 这是本项目最重要的部署安全项。

### 4. 部署

```bash
pnpm --filter @readly/worker run deploy
```

部署完成后打开 Worker 域名,输入 `AUTH_TOKEN` 登录。

### 更新版本

```bash
git pull
pnpm install
pnpm build
pnpm --filter @readly/worker run d1:migrate:remote
pnpm --filter @readly/worker run deploy
```

先迁移再部署,避免新代码访问旧表结构。若使用 Workers Builds,deploy command 已包含远端迁移(见下文)。

### 自定义域名

在 Cloudflare 后台的 Worker → **Settings → Domains & Routes** 添加自定义域名。Google Reader 客户端填写这个域名即可,通常不需要带 `/reader` 或 `/api` 路径。

## 自动部署(Cloudflare Workers Builds,推荐)

把仓库连接到 Cloudflare Worker 后,push 到 `main` 会自动执行安装、构建、D1 迁移和部署。构建在 Cloudflare 侧进行,**不需要额外配置 API Token**(Workers Builds 会生成账户级 Token)。

接入步骤:

1. Cloudflare 后台 → Workers & Pages → *Create application* → *Import a repository*,授权 GitHub 并选择本仓库;若已有同名 Worker,则在 **Settings → Builds → Connect** 接入。项目名填 `readly`。
2. 按下表配置 monorepo 构建:

   | 配置项 | 值 |
   |---|---|
   | Git branch | `main` |
   | Root directory | `/`(整仓:web 构建 + 根 lockfile) |
   | Build variable | `SKIP_DEPENDENCY_INSTALL` = `1` |
   | Build command | `pnpm install --frozen-lockfile && pnpm build` |
   | Deploy command | `pnpm --filter @readly/worker run d1:migrate:remote && pnpm --filter @readly/worker run deploy` |

3. 一次性准备:
   - 创建 D1 并把 `database_id` 写入 `worker/wrangler.toml` 后提交;
   - 设置 `AUTH_TOKEN`:Workers & Pages → `readly` → **Settings → Variables and Secrets** → **Add** → 类型 **Secret(加密)** → 名称 `AUTH_TOKEN` → 填入口令 → **Deploy**。也可用命令行:

     ```bash
     pnpm --filter @readly/worker exec wrangler secret put AUTH_TOKEN
     ```

> 若首次构建时 D1 迁移报权限错误(自动 Token 的迁移权限未明示),可把迁移从 Deploy command 中移除,改为在本地执行 `pnpm --filter @readly/worker run d1:migrate:remote`;部署本身不受影响。

## GitHub Actions 手动备用

`.github/workflows/deploy.yml` 是**仅手动触发**的备用通道(Actions 页 → *Deploy to Cloudflare (manual fallback)* → Run workflow)。使用前:

1. 在仓库 **Settings → Secrets and variables → Actions** 配置:
   - `CLOUDFLARE_API_TOKEN`:Cloudflare API Token,选择 “Edit Cloudflare Workers” 模板并追加 **D1 → Edit** 权限;
   - `CLOUDFLARE_ACCOUNT_ID`:Cloudflare 后台右侧栏的 Account ID。
2. 确认 `worker/wrangler.toml` 的 `database_id` 不是占位符;工作流会在占位符时友好跳过。
3. 确保 Worker 的 `AUTH_TOKEN` 已设置。

工作流会执行:安装依赖 → 构建 → 类型检查与全量测试 → 远端 D1 迁移 → 部署。

## 免费额度与规模

- **Workers 免费版**:单次调用 CPU 约 10ms。刷新默认每批 2 个源(`refresh_batch_size`),cron 每分钟推进一批;源较多(>50)时建议升级 Workers Paid。
- **D1 免费版**:5GB 存储、每日 500 万行读,个人使用通常足够。
- **Workers Builds**:约 3,000 构建分钟/月;本项目构建约 1–2 分钟。

## 备份与恢复

订阅可以随时在网页端导出 OPML。完整数据(文章、阅读状态、设置、GReader / Fever 凭据、可选同步的 AI 密钥)需要备份 D1:

```bash
pnpm --filter @readly/worker exec wrangler d1 export readly --remote --output ../readly-backup.sql
```

恢复前先另行备份,再执行:

```bash
pnpm --filter @readly/worker exec wrangler d1 execute readly --remote --file ../readly-backup.sql
```

备份文件包含明文 GReader / Fever 密码;若开启了 AI 密钥云同步,也包含 AI 密钥。请按敏感文件保管,不要提交到仓库或公开分享。

## 安全检查清单

- [ ] `AUTH_TOKEN` 已设置且足够长;确认未设置时 Workers 不鉴权
- [ ] `worker/wrangler.toml` 使用自己的 `database_id`
- [ ] GReader 密码仅分享给可信客户端;泄露时在设置页重置
- [ ] Fever 密码仅分享给可信客户端;泄露时在设置页重置
- [ ] 若开启 AI 密钥云同步,确认 D1 访问权限与备份文件的保管
- [ ] 定期备份 D1,并妥善保管备份文件
- [ ] 不要把 `worker/.dev.vars`、API Token、备份 SQL 提交到仓库

## 常见部署故障

| 现象 | 处理 |
|---|---|
| 部署后打开域名是 404/空白 | 先 `pnpm build`,确认 `web/dist` 存在再部署 |
| 所有请求都不需要登录 | `AUTH_TOKEN` 未设置;立即用 `wrangler secret put AUTH_TOKEN` 设置并重新部署 |
| 登录后仍 401 | 页面保存的令牌与 Worker Secret 不一致;清除 localStorage 后重新输入 |
| D1 迁移权限错误 | 参考上方 Workers Builds 备注,改为本地执行迁移 |
| 工作流提示跳过部署 | `worker/wrangler.toml` 的 `database_id` 仍是占位符 |
| 新文章不更新 | 检查 Cron Trigger 是否存在;免费版每批处理数量有限,源多时需要多轮;也可在网页端点「刷新全部」 |
| 免费版出现 CPU 超限 | 降低 `refresh_batch_size`,或升级 Workers Paid |
| 自定义域名下 GReader 连不上 | 客户端服务器地址填自定义域名根地址,并确认已为该域名配置 Worker 路由 |
| 自定义域名下 Fever 连不上 | 客户端 Fever 地址填 `https://自定义域名/fever/`(完整路径),并确认已为该域名配置 Worker 路由 |
