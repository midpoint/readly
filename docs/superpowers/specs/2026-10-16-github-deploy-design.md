# Readly — GitHub → Cloudflare 自动部署 · 设计文档

- 日期:2026-10-16
- 状态:已评审通过(用户确认三决策:GitHub Actions 路线、部署前自动迁移、占位符则跳过)
- 背景:项目已开源(midpoint/readly);接入自动化部署后,push main 即完成 build + 测试 + D1 迁移 + `wrangler deploy`。

## 1. 现状前置事实

- `worker/wrangler.toml` 的 `database_id` 仍为 `PLACEHOLDER_REPLACE_AFTER_D1_CREATE`(D1 尚未创建);
  `[assets]` 指向 `../web/dist`(SPA 回退 + `run_worker_first: ["/api/*"]`);`[triggers] crons = ["* * * * *"]`。
- 仓库无 `.github/`;worker 依赖 `wrangler ^4`;根 `engines.node >= 22`、`packageManager: pnpm@10.0.0`。
- Worker 密钥 `AUTH_TOKEN` 经 `wrangler secret put` 设置,跨部署保留,CI 无需持有。

## 2. 工作流设计(`.github/workflows/deploy.yml`)

- **触发**:`push` 到 `main`;`workflow_dispatch`(手动)。
- **并发**:`concurrency: { group: deploy-production, cancel-in-progress: false }`(不打断进行中的部署)。
- **Job**:`ubuntu-latest`,`timeout-minutes: 15`,步骤依序:

| # | 步骤 | 内容 | 失败行为 |
|---|---|---|---|
| 0 | checkout | `actions/checkout@v4` | 停 |
| 1 | 占位符守卫 | `grep -q "PLACEHOLDER_REPLACE_AFTER_D1_CREATE" worker/wrangler.toml` 命中 → `GITHUB_OUTPUT ready=false` + `::notice::` 指引(先 `wrangler d1 create readly` 并替换占位符),后续步骤**全部跳过**;未命中 → `ready=true` | 成功退出 |
| 2 | 环境 | `pnpm/action-setup@v4`(**不传 version**,读 packageManager 字段)→ `actions/setup-node@v4`(node 22, `cache: pnpm`) | 停 |
| 3 | 安装 | `pnpm install --frozen-lockfile` | 停 |
| 4 | 构建 | `pnpm build`(web dist;worker assets 前置) | 停 |
| 5 | 质量门 | `pnpm -r typecheck && pnpm -r test`(409 项) | 停 |
| 6 | 迁移 | `pnpm --filter @readly/worker d1:migrate:remote`(幂等,无新迁移为 no-op) | 停 |
| 7 | 部署 | `pnpm --filter @readly/worker deploy` | 停 |

- 步骤 2-7 均带 `if: steps.guard.outputs.ready == 'true'`(守卫未通过时整条链跳过)。
- 步骤 6/7 注入 `env: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID`(仅这两个步骤持有,install/build/test 不接触)。

## 3. Secrets 与一次性准备(README 收录)

- 仓库 Secrets:`CLOUDFLARE_API_TOKEN`(CF 后台 API Tokens,基于 "Edit Cloudflare Workers" 模板并追加 **D1:Edit** 权限)、`CLOUDFLARE_ACCOUNT_ID`(后台右侧栏)。两个值**只放 GitHub Secrets,不入仓库**。
- 一次性:① `pnpm --filter @readly/worker exec wrangler d1 create readly` → 把返回的 database_id 填入 `wrangler.toml`(该值非机密,随仓库提交)→ push;② 本地 `wrangler secret put AUTH_TOKEN`(生产访问令牌,必做)。
- 完成后:push main 自动部署;Actions 页可手动触发。

## 4. 验证策略

- 本机:YAML 语法/结构解析校验;守卫逻辑两分支本地演练(mock 占位符/已替换两种 wrangler.toml);**逐字复跑命令链**:`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm -r typecheck` → `pnpm -r test` → `pnpm --filter @readly/worker exec wrangler deploy --dry-run`。
- 真机:用户配好 Secrets + database_id 后,push 触发首个真实部署(或 workflow_dispatch 手动触发)为最终验收。

## 5. 明确不做(YAGNI)

- Cloudflare Workers Builds(云端构建)、PR 预览环境、部署结果通知(以后需要再加)。

## 6. 边界与已知限制(如实披露)

- `workflow_dispatch` 按钮在该工作流位于默认分支后才出现(首次 push 后即满足,自举无碍)。
- `wrangler d1 migrations apply --remote` 在 CI 非 TTY 下的自动确认行为以真机首部署为准(wrangler v4 非交互环境直接应用;若出现交互卡顿,真机验收时改为显式传入确认方式)。
- 未设置 `AUTH_TOKEN` 的 Worker 行为与本地一致(不校验令牌)——README 已将 `secret put` 标注为必做。
