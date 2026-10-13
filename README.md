# Readly

自托管 RSS 阅读器:订阅管理、全文抓取、TTS 朗读、本地事件聚类与关键词监控、AI 摘要翻译。部署于 Cloudflare Workers + D1。

## 功能

1. RSS/Atom 订阅:OPML 导入导出、批量加源、站点自动发现、分类管理
2. 阅读体验:深浅主题、强调色、多套阅读主题、字号/行距/宽度可调
3. 全文抓取:摘要过短时自动提取原文(浏览器端 Readability)
4. TTS 朗读:浏览器内置语音逐句朗读(规划中)
5. 阅读管理:未读/收藏/稍后读、按日期分组
6. 事件聚类:本地把相近新闻归为事件组(规划中)
7. 关键词监控:本地规则匹配打标(规划中)
8. AI 摘要/翻译:OpenAI 兼容接口(规划中)
9. 一键部署 Cloudflare

## 本地开发

```bash
pnpm install
pnpm --filter @readly/worker d1:migrate:local
pnpm dev          # 前端 5173 + worker 8787
```

未配置 `AUTH_TOKEN` 时本地不校验令牌。

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

### 免费额度说明

- Workers 免费版单次调用 CPU 约 10ms:刷新按 `refresh_batch_size`(默认 2)分批,cron 每分钟推进一批,客户端「刷新全部」会循环调用直至完成;订阅源较多(>50)时建议升级 Workers Paid。
- D1 免费版 5GB/每日 500 万行读,个人使用充裕。

## 测试

```bash
pnpm -r test
```
