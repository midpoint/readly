# 设计与实施计划索引

本目录保存 Readly 开发过程中的设计文档(`specs/`)与实施计划(`plans/`)。它们是历史档案,记录当时的决策、测试与验收过程;当前行为以根目录 [README](../../README.md)、使用文档和代码为准。

计划中的复选框是执行时的任务清单,不代表当前完成状态。功能入口与使用说明请看 [文档首页](../README.md)。

## 功能档案

| 主题 | 设计文档 | 实施计划 |
|---|---|---|
| 总体产品设计 / 核心(RSS、阅读、分类) | [2026-10-13 设计](specs/2026-10-13-readly-design.md) | [01 核心](plans/2026-10-13-readly-01-core.md) |
| 阅读体验与 PWA | [2026-10-13 设计](specs/2026-10-13-readly-design.md) | [02 体验与 PWA](plans/2026-10-13-readly-02-experience-pwa.md) |
| 分类折叠 + 快捷键 | — | [计划](plans/2026-10-13-readly-sidebar-collapse-shortcuts.md) |
| 只看未读 | — | [计划](plans/2026-10-13-readly-unread-only.md) |
| 全文抓取 | [2026-10-13 设计](specs/2026-10-13-readly-design.md) | [03 全文抓取](plans/2026-10-14-readly-03-fulltext.md) |
| IndexedDB 镜像 + 事件聚类 | [2026-10-13 设计](specs/2026-10-13-readly-design.md) | [04 聚类](plans/2026-10-14-readly-04-cluster.md) |
| 关键词监控 | [2026-10-13 设计](specs/2026-10-13-readly-design.md) | [05 关键词](plans/2026-10-14-readly-05-keywords.md) |
| AI 摘要 | [2026-10-13 设计](specs/2026-10-13-readly-design.md) | [06 AI 摘要](plans/2026-10-14-readly-06-ai-summary.md) |
| 分隔线拖拽调宽 | — | [07b 分隔线](plans/2026-10-15-readly-07b-resizable-dividers.md) |
| 列表布局(紧凑视图) | — | [07c 列表布局](plans/2026-10-15-readly-07c-list-layout.md) |
| 收尾与验收 | — | [08 收尾](plans/2026-10-15-readly-08-wrapup.md) |
| 订阅源编辑网址 | [2026-10-16 设计](specs/2026-10-16-feed-url-edit-design.md) | [计划](plans/2026-10-16-readly-feed-url-edit.md) |
| GitHub → Cloudflare 自动部署 | [2026-10-16 设计](specs/2026-10-16-github-deploy-design.md) | [计划](plans/2026-10-16-readly-github-deploy.md) |
| 列表模式行内容精简 | [2026-10-16 设计](specs/2026-10-16-list-mode-minimal-design.md) | [计划](plans/2026-10-16-readly-list-mode-minimal.md) |
| 标已读时间档(3 天/1 周/1 月/1 年) | [2026-10-16 设计](specs/2026-10-16-mark-read-by-age-design.md) | [计划](plans/2026-10-16-readly-mark-read-by-age.md) |
| 正文默认排版升级(中文书籍派) | [2026-10-16 设计](specs/2026-10-16-reader-typography-design.md) | [计划](plans/2026-10-16-readly-reader-typography.md) |
| 侧栏精简 + 功能入设置 | [2026-10-16 设计](specs/2026-10-16-sidebar-slim-settings-design.md) | [计划](plans/2026-10-16-readly-sidebar-slim-settings.md) |
| Google Reader API 核心同步 | [2026-10-29 设计](specs/2026-10-29-google-reader-api-design.md) | [计划](plans/2026-10-29-readly-google-reader-api.md) |

## 阅读顺序建议

1. 先读[总体设计](specs/2026-10-13-readly-design.md),了解产品目标、范围与已取消的功能。
2. 按功能查阅对应的 spec,再看 plan 了解任务拆分、测试与验收方式。
3. 涉及 Google Reader API 的改动,以[GReader 设计](specs/2026-10-29-google-reader-api-design.md)为契约基准,并同步更新[使用文档](../google-reader-api.md)。
