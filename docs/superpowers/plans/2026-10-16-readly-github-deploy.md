# Readly GitHub→Cloudflare 自动部署 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** push 到 main(或手动触发)即自动完成:安装 → 构建 → 类型检查+全量测试 → D1 远端迁移 → `wrangler deploy`;D1 未配置(占位符)时友好跳过。

**Architecture:** 单个 GitHub Actions 工作流 `.github/workflows/deploy.yml`(纯 shell 步骤 + 官方 setup actions,不引入 wrangler action 以复用仓库内 wrangler 4.149.0);守卫步骤以 grep 占位符决定后续步骤的 `if` 开关;CF 凭据仅注入到底层两个 wrangler 步骤。README 增补一次性配置说明。

**Tech Stack:** GitHub Actions、pnpm 10 / Node 22、wrangler 4、pyyaml(本机校验用)。

## Global Constraints

- 设计文档:`docs/superpowers/specs/2026-10-16-github-deploy-design.md`(已评审)。行为以该文档 §2 表为准。
- 触发:`push` 到 `main` + `workflow_dispatch`;`concurrency: { group: deploy-production, cancel-in-progress: false }`。
- 守卫:grep 的字符串必须逐字为 `PLACEHOLDER_REPLACE_AFTER_D1_CREATE`;命中 → `GITHUB_OUTPUT ready=false` + `::notice::` 指引,后续步骤经 `if: steps.guard.outputs.ready == 'true'` 全跳过(成功退出);`::notice::` 文案**不得含反引号**(防 shell 命令替换)。
- `pnpm/action-setup@v4` **不传 version**(读 packageManager=pnpm@10.0.0);`actions/setup-node@v4` 用 node 22 + `cache: pnpm`;顺序必须是 pnpm 先于 setup-node。
- 质量门逐字为 `pnpm -r typecheck && pnpm -r test`(409 项);仅「迁移」「部署」两步注入 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 两个 Secrets,其余步骤不接触。
- 不改 `worker/wrangler.toml`(占位符保留,由用户完成后替换);任何密钥不入仓库。
- 网络注意:本机对外操作照旧(推送由控制者做,使用仓库本地已配置的代理配方,实施者**不需要**也不应执行 git push)。

---

### Task 1: 工作流 + README + 本机全链验证

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `README.md`(在「### 免费额度说明」段之后、「## 测试」之前,插入新章节)

**Interfaces:**
- Consumes:`package.json`(engines node>=22、packageManager pnpm@10.0.0)、`worker/package.json`(scripts `deploy`/`d1:migrate:remote`、wrangler ^4)、`worker/wrangler.toml`(占位符字符串)。
- Produces:工作流契约——Secrets 名 `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`;守卫输出 `ready`;README 章节「自动部署(GitHub Actions)」。

- [ ] **Step 1: 创建工作流文件**

新建 `.github/workflows/deploy.yml`,内容逐字如下:

```yaml
# push 到 main 自动构建、测试、迁移并部署到 Cloudflare。
# 一次性前置(见 README「自动部署(GitHub Actions)」):
#   1) 仓库 Secrets:CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID
#   2) worker/wrangler.toml 的 database_id 已替换占位符(wrangler d1 create readly)
#   3) Worker 密钥 AUTH_TOKEN 已设置(wrangler secret put AUTH_TOKEN,一次性)
name: Deploy to Cloudflare

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: 占位符守卫(D1 未创建时跳过部署)
        id: guard
        run: |
          if grep -q "PLACEHOLDER_REPLACE_AFTER_D1_CREATE" worker/wrangler.toml; then
            echo "ready=false" >> "$GITHUB_OUTPUT"
            echo '::notice::跳过部署:worker/wrangler.toml 的 database_id 仍是占位符。请先运行 wrangler d1 create readly 并把返回的 database_id 写入 wrangler.toml 后重新推送;所需 Secrets 与步骤见 README「自动部署(GitHub Actions)」。'
          else
            echo "ready=true" >> "$GITHUB_OUTPUT"
          fi

      - uses: pnpm/action-setup@v4
        if: steps.guard.outputs.ready == 'true'

      - uses: actions/setup-node@v4
        if: steps.guard.outputs.ready == 'true'
        with:
          node-version: 22
          cache: pnpm

      - name: 安装依赖
        if: steps.guard.outputs.ready == 'true'
        run: pnpm install --frozen-lockfile

      - name: 构建 web(worker assets 前置)
        if: steps.guard.outputs.ready == 'true'
        run: pnpm build

      - name: 质量门(类型检查 + 全量测试)
        if: steps.guard.outputs.ready == 'true'
        run: pnpm -r typecheck && pnpm -r test

      - name: 应用 D1 迁移(远端,幂等)
        if: steps.guard.outputs.ready == 'true'
        run: pnpm --filter @readly/worker d1:migrate:remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: 部署到 Cloudflare
        if: steps.guard.outputs.ready == 'true'
        run: pnpm --filter @readly/worker deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 2: README 增补章节**

在 `README.md` 的「### 免费额度说明」小节结尾(即 `## 测试` 之前)插入:

````markdown
## 自动部署(GitHub Actions)

推送到 `main` 会自动执行:构建 → 类型检查 → 全量测试 → D1 迁移 → `wrangler deploy`(工作流见 `.github/workflows/deploy.yml`);也可在 GitHub 的 Actions 页手动触发。工作流检测到 `database_id` 仍是占位符时会**自动跳过部署**并给出提示。

一次性准备:

1. **创建 D1 并把 ID 写入配置**:

   ```bash
   pnpm --filter @readly/worker exec wrangler d1 create readly
   # 把返回的 database_id 填入 worker/wrangler.toml,提交并推送
   ```

2. **设置 Worker 访问令牌**(本地执行一次即可,密钥跨部署保留,CI 不需要该值):

   ```bash
   pnpm --filter @readly/worker exec wrangler secret put AUTH_TOKEN
   ```

3. **在 GitHub 仓库添加两个 Secrets**(Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`:Cloudflare 后台 → My Profile → API Tokens → Create Token,选 “Edit Cloudflare Workers” 模板,并追加 **D1 → Edit** 权限
   - `CLOUDFLARE_ACCOUNT_ID`:Cloudflare 后台右侧栏的 Account ID

完成后,每次 push 到 `main` 即自动部署。
````

- [ ] **Step 3: 本机验证 A —— YAML 解析**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml')); print('YAML-OK')"`
Expected: `YAML-OK`(任何解析错误即停,修复后重跑)。

- [ ] **Step 4: 本机验证 B —— 守卫逻辑双分支演练**

分支 1(当前仓库,占位符 → 跳过):

```bash
D=$(mktemp -d); GITHUB_OUTPUT="$D/out" bash -c 'if grep -q "PLACEHOLDER_REPLACE_AFTER_D1_CREATE" worker/wrangler.toml; then echo "ready=false" >> "$GITHUB_OUTPUT"; echo NOTICE-SKIP; else echo "ready=true" >> "$GITHUB_OUTPUT"; echo DEPLOY; fi'; echo "---"; cat "$D/out"
```

Expected: 输出 `NOTICE-SKIP`,随后文件内容为 `ready=false`。

分支 2(替换后 → 部署):

```bash
T=$(mktemp -d); mkdir -p "$T/worker"; sed 's/PLACEHOLDER_REPLACE_AFTER_D1_CREATE/11111111-2222-3333-4444-555555555555/' worker/wrangler.toml > "$T/worker/wrangler.toml"; (cd "$T" && GITHUB_OUTPUT="$T/out" bash -c 'if grep -q "PLACEHOLDER_REPLACE_AFTER_D1_CREATE" worker/wrangler.toml; then echo "ready=false" >> "$GITHUB_OUTPUT"; echo NOTICE-SKIP; else echo "ready=true" >> "$GITHUB_OUTPUT"; echo DEPLOY; fi'); cat "$T/out"
```

Expected: 输出 `DEPLOY`,文件内容为 `ready=true`。

(说明:演练体与 YAML `run: |` 块逐字一致——守卫体不引用任何环境变量,除 `GITHUB_OUTPUT`。)

- [ ] **Step 5: 本机验证 C —— 命令链逐字复跑**

依序执行并记录输出摘录:

```bash
pnpm install --frozen-lockfile     # 期望:Lockfile is up to date / 无 ERR_PNPM_OUTDATED_LOCKFILE
pnpm build                         # 期望:vue-tsc + vite build 成功
pnpm -r typecheck                  # 期望:0 错误
pnpm -r test                       # 期望:worker 143 + web 266 = 409 全绿
pnpm --filter @readly/worker exec wrangler deploy --dry-run
```

最后一条预期:dry-run 完成(No deploy),输出含 Worker、`ASSETS`/`DB` 绑定与 cron 触发信息。**若因占位符 database_id 报错:如实记录完整报错并停下报告**(控制者裁决,实施者不得为此修改 wrangler.toml)。

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml README.md
git commit -m "feat(ci): GitHub→Cloudflare 自动部署工作流(守卫/质量门/D1 迁移)

push main 自动:install→build→typecheck+test→d1 迁移→wrangler deploy;
database_id 为占位符时友好跳过;README 增补一次性配置说明。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review 记录

- 规格覆盖:§2 触发行/并发/7 步表/if 门/env 注入 → Step 1 全程逐字;§3 Secrets/一次性准备 → Step 1 头部注释 + Step 2 README;§4 验证策略 → Step 3/4/5;§5 不做项 → 计划中无附加功能;§6 边界(workflow_dispatch 自举、CI 迁移非交互)→ README 与真机验收说明。
- 占位符扫描:无 TBD/TODO;YAML、README、命令与期望输出均给出完整内容。
- 一致性:`ready` 输出名、if 条件串、Secrets 名在两个文件与演练脚本中逐字一致;`::notice::` 文案无反引号(单一引号 echo)。
- 计数核对:409 = 143 + 266;以实际运行为准。

