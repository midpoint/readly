# 常见问题

## AUTH_TOKEN 是什么?忘记或想更换怎么办?

`AUTH_TOKEN` 是保护 `/api/*` 的共享访问令牌;网页登录时输入它。它无法从 Worker 读回。忘记或需要更换时:

```bash
pnpm --filter @readly/worker exec wrangler secret put AUTH_TOKEN
```

设置新值后,已在网页登录的设备需要重新输入。GReader 客户端使用独立密码,不受 `AUTH_TOKEN` 影响。

**不要不设置 `AUTH_TOKEN` 就暴露到公网**:未设置时 Worker 不校验任何请求。

## 支持多用户或团队共享吗?

不支持。Readly 是单用户设计:一个实例、一个阅读库、一个 `AUTH_TOKEN`。需要多用户时,为每个用户部署独立实例和 D1。

## 如何备份和恢复数据?

- **订阅**:网页端「设置 → 订阅数据 → 导出全部订阅(OPML)」。
- **完整数据**:用 Wrangler 导出 D1:

  ```bash
  pnpm --filter @readly/worker exec wrangler d1 export readly --remote --output ../readly-backup.sql
  ```

  备份包含文章、阅读状态、设置、GReader 密码,以及开启云同步时的 AI 密钥,应按敏感文件保管。
- **恢复**:见[部署指南的备份与恢复](deployment.md#备份与恢复);恢复前务必再备份当前库。

## 为什么 Google Reader 客户端不能添加订阅或刷新?

Readly 的 GReader 实现范围是**核心同步**,用于在客户端阅读已有文章和同步已读/收藏状态。订阅管理(加源、删源、改名、移动分类)请在网页端完成;刷新由服务端 cron 自动进行,客户端刷新只会重新拉取已有文章。

## AI 密钥存在哪里?直连和代理怎么选?

- 默认只存本机 `localStorage`;开启「密钥云同步」后,服务商配置(含密钥)会写入 D1,方便新设备恢复。
- **直连**:浏览器直接请求 `baseUrl`,适合 Ollama、LM Studio 等本地/局域网服务。
- **代理**:请求经 Worker 转发,适合公网服务商;Worker 会拒绝内网地址,防止 SSRF。

## 支持哪些浏览器?

建议使用较新的现代浏览器(Chrome 116+ / Safari 17.4+ / Firefox 124+)。更旧的浏览器上,AI 请求的超时信号合并会回退为内置兼容实现,直连和代理模式都可继续使用。

## PWA 离线时能做什么?

PWA 会缓存应用壳,离线时可以打开应用界面;但文章列表与正文来自 Worker/D1,需要网络。IndexedDB 中的最近 1000 篇文章镜像用于事件聚类与关键词匹配,不是离线阅读缓存。抓取、标记已读/收藏、AI 摘要等操作也需要网络。

## 数据都存放在哪里?

- **D1**:订阅、文章、阅读状态、设置、GReader 凭据;开启云同步时的 AI 配置。
- **浏览器 localStorage**:阅读偏好、AI 密钥(默认)、网页访问令牌。
- **IndexedDB**:用于事件聚类/关键词匹配的最近 1000 篇文章镜像。

清除浏览器数据不会删除 D1 中的订阅和文章,但会丢失本地偏好与未同步的 AI 密钥。

## 如何更新已部署的实例?

手动部署:

```bash
git pull
pnpm install
pnpm build
pnpm --filter @readly/worker run d1:migrate:remote
pnpm --filter @readly/worker run deploy
```

使用 Cloudflare Workers Builds 时,push 到 `main` 会自动完成迁移和部署。升级前建议先备份 D1。
