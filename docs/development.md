# 开发指南

## 环境要求

- Node.js 22 或更高版本
- pnpm 10(`corepack enable` 后由 `packageManager` 自动选择版本)
- 可选:Chrome/Chromium,用于 PWA 调试与视觉/对比度验收

## 首次启动

```bash
pnpm install
pnpm build
pnpm --filter @readly/worker run d1:migrate:local
pnpm dev
```

打开 <http://localhost:5173>。`pnpm dev` 通过 `concurrently` 同时启动:

- Vite 开发服务器 `http://localhost:5173`(端口 5173)
- Wrangler 本地 Worker `http://localhost:8787`

Vite 将 `/api` 代理到 Worker。首次运行必须先 `pnpm build`,因为 Worker 的静态资源绑定和 worker 集成测试都依赖 `web/dist`。

本地 D1 数据默认由 Wrangler 持久化;执行迁移即可创建/升级表结构。不要在未备份时清理本地 D1 状态。

## 本地访问令牌

`AUTH_TOKEN` 未设置时,`/api/*` **不校验任何请求**(实现见 `worker/src/auth.ts`)。这在可信的本机环境方便开发,但不要把这种配置暴露到公网。

需要模拟生产鉴权时:

```bash
cp worker/.dev.vars.example worker/.dev.vars
# 编辑 AUTH_TOKEN 后重启 pnpm dev
```

网页登录页输入同一个令牌;前端保存在 localStorage 的 `readly_token` 键中。修改令牌后需要重新登录。

## 常用脚本

### 根目录

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 同时启动 Worker 与 Web 开发服务器 |
| `pnpm build` | 构建 web(`web/dist`),worker 的 assets 依赖它 |
| `pnpm test` | 递归运行所有包测试 |
| `pnpm typecheck` | 递归运行类型检查 |
| `pnpm deploy` | 构建 web 后部署 worker |

### Worker

| 命令 | 作用 |
|---|---|
| `pnpm --filter @readly/worker dev` | 仅启动 Wrangler 本地 Worker |
| `pnpm --filter @readly/worker test` | worker 测试(vitest + `@cloudflare/vitest-pool-workers`) |
| `pnpm --filter @readly/worker typecheck` | `tsc --noEmit` |
| `pnpm --filter @readly/worker run d1:migrate:local` | 应用本地 D1 迁移 |
| `pnpm --filter @readly/worker run d1:migrate:remote` | 应用远端 D1 迁移 |
| `pnpm --filter @readly/worker run deploy` | `wrangler deploy` |

### Web

| 命令 | 作用 |
|---|---|
| `pnpm --filter @readly/web dev` | Vite 开发服务器 |
| `pnpm --filter @readly/web build` | `vue-tsc --noEmit && vite build` |
| `pnpm --filter @readly/web test` | web 测试(jsdom) |
| `pnpm --filter @readly/web typecheck` | `vue-tsc --noEmit` |
| `pnpm --filter @readly/web run icons` | 由 `logo.svg` 重新生成 PWA 图标 |
| `pnpm --filter @readly/web run verify:pwa` | 校验构建产物中的 manifest、Service Worker 与图标 |

## 测试

完整门禁(提交前建议执行):

```bash
pnpm build && pnpm -r test && pnpm -r typecheck
```

当前基线:worker 213 + web 284 = **497** 项。worker 测试依赖 `web/dist`,所以不要跳过 `pnpm build`。

只跑某个文件时:

```bash
pnpm --filter @readly/worker exec vitest run test/fever.test.ts
pnpm --filter @readly/worker exec vitest run test/greader.test.ts
pnpm --filter @readly/web exec vitest run src/components/__tests__/fever-settings.test.ts
pnpm --filter @readly/web exec vitest run src/components/__tests__/google-reader-settings.test.ts
pnpm --filter @readly/worker typecheck
pnpm --filter @readly/web typecheck
```

测试约定:

- worker 测试通过 `SELF.fetch` 走真实 Hono 路由和本地 D1,不 mock 数据库;测试前会清理表。
- web 组件测试在 jsdom 中挂载真实组件,只 mock 网络边界(`@/api/client`)。
- GReader 的批量 ID 场景要覆盖超过 D1 100 个绑定参数上限的情况(实现使用 `json_each(?)`)。
- Fever 的 `items` 要覆盖 `max_id` / `with_ids` / `since_id` 三种分页与 50 条上限;写操作要断言落库后的状态与返回的 ids。
- 涉及双端字段的改动,客户端测试要钉住精确请求体,worker 测试要断言落库结果。

## 定时任务调试

`GET /__scheduled` 会被 SPA 回退吞掉,应使用 Wrangler 的测试端点:

```bash
curl -X POST "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

注意:`pnpm dev` 启动的 Worker **没有** `--test-scheduled`,该端点会返回 `200 ok` 但不真正执行。需要先单独启动:

```bash
pnpm --filter @readly/worker exec wrangler dev --test-scheduled
```

执行结果看 worker 日志中的 `[readly] scheduled refresh:` 行。调试时也可以直接 `POST /api/refresh` 触发刷新。

## PWA 与图标

```bash
pnpm --filter @readly/web run icons
pnpm build
pnpm --filter @readly/web run verify:pwa
```

修改 `web/logo.svg` 后重新生成图标;发布前用 `verify:pwa` 检查 manifest、Service Worker 与图标是否进入构建产物。

## 目录结构

```text
shared/          前后端共享类型与常量
worker/src/      Worker 路由、抓取/解析、D1 访问、GReader/Fever
worker/test/     Worker 集成测试
worker/migrations/ D1 迁移
web/src/         Vue 视图、组件、Pinia、客户端计算模块
web/src/**/__tests__/ 组件/模块测试
docs/            使用、开发、部署、架构与设计档案
```

详细的模块职责见[架构说明](architecture.md)。

## 常见开发故障

| 现象 | 处理 |
|---|---|
| `/api/*` 全部 401 | `AUTH_TOKEN` 与页面保存的令牌不一致;检查 `worker/.dev.vars` 或远端 Secret,清掉 localStorage 后重新登录 |
| worker 测试报 assets/`web/dist` 缺失 | 先执行 `pnpm build` |
| 端口 5173/8787 被占用 | 关闭上一次 `pnpm dev`,或改用其他端口并同步 Vite 代理 |
| 长时间运行 `wrangler dev` 后所有 `/api` 挂起 | 本地 workerd 运行时卡死;重启 `pnpm dev` 即可,代码与本地 D1 数据不受影响 |
| 中文标题乱码 | 新抓取会自动按 charset 解码;存量乱码文章不会自愈,删除并重新订阅该源 |
| 本地 D1 与测试数据混淆 | 测试使用隔离的 D1;开发库迁移/清理前先备份 |
| 修改类型后 web/worker 任一侧报错 | 共享类型在 `shared/src`,执行 `pnpm -r typecheck` 同时检查两侧 |

更多部署相关问题见[部署指南](deployment.md)。
