# Readly — 自托管在线 RSS 阅读器 · 设计文档

- 日期:2026-10-13
- 状态:已评审通过(用户确认)
- 形态:响应式 Web + PWA,手机为主、桌面三栏,部署于 Cloudflare
- 变更记录:2026-10-14 —— 功能 4(TTS 朗读)经用户决定**取消**,不纳入实施;其余范围不变。

## 1. 概述

Readly 是一个类似 inoreader 的个人 RSS 阅读服务:订阅、阅读、管理一体化,并内置三块「本地计算」能力——事件聚类、关键词监控、语音朗读——全部在浏览器端完成,不联网、不上传。服务端(Cloudflare Worker + D1)只负责抓取代理、数据存储与可选的 AI 转发。

九大功能:

1. RSS / Atom 订阅:OPML 导入导出、批量加源、分类管理、站点自动发现
2. 阅读体验:字号/行距/字体/宽度可调,深浅主题 + 自定义强调色 + 多套阅读主题
3. 全文抓取:摘要过短时自动抓取原文(客户端 Readability)
4. TTS 朗读:浏览器内置语音,正文直接朗读,逐句高亮
5. 阅读管理:未读 / 收藏 / 稍后读,按日期与来源组织
6. 事件聚类:本地把相近新闻归为「事件组」,呈现时间脉络
7. 关键词监控:本地规则匹配打标,可查每条规则的命中文章
8. AI 摘要 / 翻译:OpenAI 兼容接口,自选服务商,国内模型直连
9. 部署:单 Worker 一键部署到 Cloudflare(含免费额度适配)

界面语言:简体中文(硬编码,不做 i18n)。
视觉基调:克制的编辑感——大量留白、系统字体栈、细边框、无渐变堆砌;强调色仅用于交互态与标记。

## 2. 非目标(YAGNI)

- 多用户注册/登录、社交分享、评论
- 原生 App(以 PWA 替代)、桌面客户端
- 云端 TTS、云端 embedding 聚类
- 全文搜索、邮件日报、规则自动学习(未来可加)
- i18n 多语言界面

## 3. 架构

```
┌────────────────────── Cloudflare(单一 Worker 部署)─────────────────────┐
│  Static Assets: web/dist(Vue3 SPA + PWA)                                │
│  /api/*(Hono):                                                          │
│    · feeds 抓取/解析/发现入队 · 文章 CRUD/状态 · 设置 · 统计             │
│    · /api/proxy/html  HTML 代理(全文提取用,SSRF 防护)                  │
│    · /api/ai/chat     OpenAI 兼容转发(SSE 透传,可选)                   │
│  D1(SQLite):categories / feeds / articles / article_states / settings    │
│  Cron(* * * * *):按 D1 游标分批刷新订阅源                                │
└──────────────────────────────────────────────────────────────────────────┘
浏览器端(Web Worker / 主线程,不联网、不上传):
  · 全文提取(DOMParser + Readability + DOMPurify)   · 事件聚类(TF-IDF+余弦)
  · 关键词匹配(子串/正则)                            · TTS(Web Speech API)
  · OPML 解析/生成                                    · IndexedDB 文章镜像
```

### 3.1 部署形态

单一 Worker:`wrangler deploy` 一条命令同时发布前端静态资源(Workers Static Assets,SPA 回退)、API 路由、D1 绑定与 Cron,不拆 Pages + 独立 Worker,避免两个部署单元与跨域配置。

### 3.2 Workers 免费版 CPU 限制适配(重要)

免费版 Workers 单次调用 CPU 上限约 10ms(网络等待不计入)。因此:

- **全文提取放客户端**:Worker 只做 `/api/proxy/html` 原样代理(近零 CPU),Readability/DOMPurify 在浏览器跑,不吃 Worker 配额,同时更符合「本地计算」。
- **刷新分批进行**:Cron 每分钟触发一次,按 `feeds.next_refresh_at` 游标每次最多处理 `refresh_batch_size`(默认 2,存 settings)个到期的源;客户端「刷新全部」同样循环调用 `/api/refresh?batch=1` 直至完成(返回 `{done, processed, remaining}`)。源多时可通过设置调大或升级 Workers Paid(CPU 上限 30s)。
- **订阅发现不用整页 DOM 解析**:仅对目标页前 256KB 做正则扫描提取 `<link rel="alternate">` 与 `<title>`,CPU 有界。

### 3.3 本地计算边界(隐私承诺)

事件聚类与关键词监控全程在浏览器 Web Worker 内对本地 IndexedDB 镜像计算:**不发任何网络请求、结果不上传、不落 D1**。设置(档位、规则)本身可同步到 D1 以便跨设备,但计算与命中结果只在本机。

## 4. 仓库结构(pnpm workspace)

```
readly/
├─ package.json                  # 根:workspace 脚本(dev/build/deploy/test)
├─ pnpm-workspace.yaml
├─ .gitignore
├─ README.md                     # 部署全流程 + 免费额度说明(随实施产出)
├─ docs/superpowers/specs/2026-10-13-readly-design.md
├─ shared/                       # @readly/shared:纯类型与常量(无运行时逻辑)
│   └─ src/index.ts              # Article/Feed/Category/Settings DTO、聚类档位常量等
├─ worker/                       # @readly/worker:Hono + D1
│   ├─ wrangler.toml             # assets/d1/cron 配置
│   ├─ migrations/0001_init.sql
│   └─ src/
│       ├─ index.ts              # Hono app + export default { fetch, scheduled }
│       ├─ env.ts                # Env 类型(DB/AUTH_TOKEN/ASSETS)
│       ├─ auth.ts               # Bearer 令牌中间件(恒定时间比较)
│       ├─ routes/{auth,categories,feeds,articles,settings,stats,refresh,proxy,ai}.ts
│       ├─ lib/{feed-parser,discover,refresh,http,ssrf,sanitize-url,respond}.ts
│       └─ __tests__/            # Vitest(miniflare/pool-workers)
└─ web/                          # @readly/web:Vue3 + Vite + Tailwind + PWA
    ├─ vite.config.ts            # dev 代理 /api → 8787;vite-plugin-pwa
    ├─ public/                   # icons(SVG + 180/192/512 PNG)、manifest
    └─ src/
        ├─ main.ts / App.vue / router.ts
        ├─ api/client.ts         # fetch 封装:令牌注入、401 跳登录、错误规整
        ├─ stores/{auth,feeds,articles,reader,settings,analysis}.ts   # Pinia
        ├─ views/{Login,Inbox,Events,Keywords,KeywordDetail,Settings,AddFeed}.vue
        ├─ components/{Sidebar,ArticleList,ArticleListItem,ReaderPane,ArticleBody,
        │              TtsPlayer,ThemePanel,ClusterView,ClusterGroupCard,AiPanel,
        │              RuleEditor,OpmlDialog,AddFeedDialog,DateGroupHeader,...}.vue
        ├─ modules/
        │   ├─ extract.ts        # Readability + DOMPurify 全文提取
        │   ├─ html.ts           # HTML→纯文本、绝对化 URL、高亮注入
        │   ├─ tokenize.ts       # CJK 二元组 + 拉丁词 分词
        │   ├─ tfidf.ts          # 稀疏向量、IDF、余弦
        │   ├─ cluster.ts        # 并查集聚类 + 代表选取
        │   ├─ keywords.ts       # 规则编译与匹配
        │   ├─ sentences.ts      # 中英切句(TTS/翻译共用)
        │   ├─ tts.ts            # SpeechSynthesis 播放器(队列/高亮/唤醒锁)
        │   ├─ idb.ts            # IndexedDB 文章镜像(读写/滚动窗口/同步)
        │   └─ analysis.worker.ts# 聚类+关键词计算 Worker(消息协议)
        ├─ styles/{main.css,themes.css}
        └─ modules/__tests__/    # Vitest 单测
```

依赖(实施时取最新 stable):vue 3、vue-router 4、pinia、tailwindcss 4、vite 7、vite-plugin-pwa、hono 4、fast-xml-parser 5、@mozilla/readability、dompurify、linkedom(worker 测试用)、vitest、@cloudflare/vitest-pool-workers、wrangler 4。

## 5. 数据模型(D1)

`worker/migrations/0001_init.sql`:

```sql
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,            -- feed 地址(去重键)
  site_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  icon_url TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_fetched_at TEXT,                -- ISO8601 UTC
  next_refresh_at TEXT,                -- 分批刷新的到期游标
  last_etag TEXT,                      -- 条件请求
  last_modified TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,   -- 连续失败计数,退避用
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_feeds_due ON feeds(next_refresh_at);

CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,                  -- 去重键(rss guid/id/link 兜底 hash)
  url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  published_at TEXT NOT NULL,          -- ISO8601 UTC,缺失时用抓取时间
  excerpt TEXT,                        -- 纯文本摘要(≤400字)
  content TEXT,                        -- 订阅源提供的 HTML(已清洗)
  content_full TEXT,                   -- 客户端提取的全文 HTML
  image_url TEXT,                      -- 列表缩略图
  lang TEXT,                           -- 粗判标题语言 zh/en/other
  ai_summary TEXT,                     -- JSON {one_liner, points[]}
  ai_translation TEXT,                 -- JSON {lang, paragraphs:[{i,t}]}
  extracted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(feed_id, guid)
);
CREATE INDEX idx_articles_pub ON articles(published_at DESC, id DESC);
CREATE INDEX idx_articles_feed ON articles(feed_id, published_at DESC);

CREATE TABLE article_states (
  article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_later INTEGER NOT NULL DEFAULT 0,
  read_at TEXT, starred_at TEXT, later_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE settings (               -- 单用户 KV
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                -- JSON
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

说明:

- 布尔用 INTEGER 0/1;时间统一存 UTC ISO8601,展示层本地化。
- `settings` 已知键:`reader_prefs`(外观/阅读偏好)、`ai_providers`(服务商列表,不含密钥除非用户选择云端存储)、`fetch_prefs`(自动全文抓取开关与阈值)、`keyword_rules`、`cluster_prefs`(范围 N 与档位)、`refresh_batch_size`(每次刷新批大小,默认 2)、`refresh_interval`(刷新间隔,默认 30min)、`retention_days`(0=永久保留;>0 时 Cron 清理已读且超期的文章)。
- 单用户模式无 user_id 列,简化模型。
- 体积控制:单篇文章 content 截断至 256KB;retention 默认关闭。

## 6. API 设计

统一前缀 `/api`;所有请求(含登录校验)都要求请求头 `Authorization: Bearer <AUTH_TOKEN>`——登录页仅是输入并验证令牌。错误格式 `{"error":{"code":"...","message":"..."}}`,HTTP 语义状态码。列表接口用 keyset 分页(游标 = `published_at|id`,避免 offset 漂移)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/check` | 校验令牌是否有效(登录页用) |
| GET | `/api/stats` | 侧栏徽标:总未读数、收藏数、稍后数、每源/每分类未读数 |
| GET/POST | `/api/categories` | 列表 / 新建 `{name}` |
| PATCH/DELETE | `/api/categories/:id` | 改名、排序 / 删除(源回落未分类,不删源) |
| POST | `/api/categories/reorder` | `{ids:[]}` 排序 |
| GET | `/api/feeds` | 全部源(含未读计数、分类、状态) |
| POST | `/api/feeds` | `{urls:[], categoryId?}` 批量订阅:抓取→解析→建源→入首批文章(每源最新 ≤50 条),逐条返回成功/失败 |
| POST | `/api/feeds/discover` | `{url}` 网站地址→候选 feed 列表(正则扫描 `<link rel=alternate>` + 常见路径 `/feed /rss /atom.xml /feed.xml`) |
| PATCH/DELETE | `/api/feeds/:id` | 改名/移动分类/排序 / 删除(级联删文章) |
| POST | `/api/feeds/:id/refresh` | 单源刷新(立即执行,不受分批限制) |
| POST | `/api/refresh?batch=N` | 分批刷新到期源;返回 `{done, processed, remaining}` |
| GET | `/api/articles` | 查询:`view=all\|unread\|starred\|later`、`feed_id`、`category_id`、`cursor`、`limit`(默认 30,≤100) |
| GET | `/api/articles/:id` | 详情(含 content_full / ai 字段) |
| PATCH | `/api/articles/:id` | `{is_read?,is_starred?,is_later?}` 状态;写入 article_states(upsert) |
| POST | `/api/articles/mark-all-read` | `{scope:{type:"all"\|"feed"\|"category", id?}}` 返回影响条数 |
| POST | `/api/articles/:id/fulltext` | `{content_full}` 持久化客户端提取结果,写 extracted_at |
| GET | `/api/articles/mirror` | 镜像同步:`cursor_id` + `limit`(≤200),返回含 content 的紧凑行(不含 ai/full),供 IndexedDB |
| GET/PUT | `/api/settings` | 读全部 / 批量 upsert `{key:value,...}` |
| GET | `/api/proxy/html?url=` | 代理 GET 目标页原始 HTML(UA 伪装、20s 超时、≤3MB 截断、SSRF 防护);仅返回 text/html |
| POST | `/api/ai/chat` | OpenAI 兼容转发:`{baseUrl,apiKey,model,messages,stream}`→ 透传 SSE(同受 SSRF 防护);用户 AI 配置含 `useProxy` 开关 |

刷新策略(`lib/refresh.ts`):

- 条件请求:带 `If-None-Match/If-Modified-Since`;304 仅更新 `last_fetched_at`。
- UA:`Readly/1.0 (+self-hosted RSS reader)`;跟随重定向;响应 >5MB 中止。
- 解析归一化后 `INSERT OR IGNORE`(按 `feed_id+guid` 去重);首次订阅仅保留最新 50 条;正文 HTML 以保守白名单清洗(去 script/style/iframe/on* 事件/js: 链接)。
- 成功:清空 error_count,`next_refresh_at = now + refresh_interval`(settings,默认 30min);失败:error_count+1,`next_refresh_at = now + min(2^error_count, 24)h` 退避,写 last_error。
- 单次调用处理的源数受 `refresh_batch_size` 限制(免费版适配,见 3.2)。

## 7. 前端设计

### 7.1 路由与布局

| 路由 | 视图 | 说明 |
|---|---|---|
| `/login` | Login | 输入访问令牌 → `/api/auth/check` |
| `/` | Inbox | 三栏:Sidebar / ArticleList / ReaderPane;查询参数 `?view=&feed=&category=&a=<articleId>` 保深链 |
| `/events` | Events | 事件聚类 |
| `/keywords`、`/keywords/:id` | Keywords / KeywordDetail | 规则管理 / 单规则命中列表 |
| `/add` | AddFeed | 加源:单条 URL+自动发现 / 多行批量 / OPML 导入 |
| `/settings` | Settings | 分组:订阅管理(OPML 导出、清理)、AI、外观、抓取、朗读、数据 |

响应式:≥1024px 三栏(侧栏可折叠);<1024px 单栏栈式——列表页 → 点开文章全屏阅读,底部 Tab(列表/事件/关键词/设置),手势返回。

### 7.2 状态(Pinia)

- `auth`:令牌、有效性;401 统一跳登录。
- `feeds`:分类+源树、未读计数(/api/stats)、CRUD action。
- `articles`:当前视图列表、游标分页、无限滚动、状态变更乐观更新、mark-all-read。
- `reader`:当前文章、渲染 HTML(高亮注入)、阅读偏好(即时应用)、TTS 状态。
- `settings`:服务端设置镜像 + localStorage 首选项(读取顺序:localStorage → D1,写入:两边都写,localStorage 立即、D1 防抖 1s)。
- `analysis`:聚类结果、关键词命中缓存、Worker 通信。

### 7.3 主题系统

- 应用外观:`light | dark | system`(CSS `prefers-color-scheme`)+ 强调色 `--accent`(12 个预设色板 + 自定义取色器),所有交互态/标记/徽标取该变量。
- 阅读主题(正文区预设,6 套):

| id | 名称 | 背景 | 文字 | 字体 |
|---|---|---|---|---|
| classic | 经典 | #ffffff / 暗色 #1a1a1a | #1f2328 | 系统无衬线 |
| sepia | 护眼米黄 | #f5f0e1 | #3b3529 | 系统无衬线 |
| paper | 羊皮纸 | #faf7f0 | #2b2b2b | 衬线(Noto Serif SC/Songti 回退) |
| night | 夜间 | #121212 | #c8c8c8 | 系统无衬线 |
| contrast | 高对比 | #ffffff | #000000 | 系统无衬线,加深字重 |
| serif-mono | 报刊 | #fdfdfa | #222 | 标题衬线 + 正文系统栈 |

- 可调项(滑块,即时生效):字号 14–24px、行距 1.4–2.2、正文宽度 560–900px、字体族(系统/衬线/自定义回退栈)。
- 不使用 Web 字体下载(隐私与性能),全部系统字体栈。
- 持久化:`localStorage.reader_prefs` 即时 + D1 `settings.reader_prefs` 同步(跨设备)。

### 7.4 阅读管理交互

- 列表行:未读圆点、来源、相对时间、标题、摘要一行、缩略图(有则显示);日期分组头:今天/昨天/本周/本月/更早。
- 打开即已读(默认开,可关);滚动到底自动已读(默认开,可关);批量:全选已读、全部标已读(可限定源/分类)。
- 快捷键(桌面):`j/k` 上/下一条、`o/Enter` 打开、`s` 收藏、`v` 稍后读、`m` 切换已读、`Esc` 关闭文章。
- PWA:manifest + 图标、应用壳预缓存;离线可读 IndexedDB 镜像内文章(见 9.4)。

## 8. 功能详规

### 8.1 订阅(功能 1)

- 格式支持:RSS 2.0、RSS 1.0/RDF、Atom 1.0、JSON Feed 1.x;命名空间取 `content:encoded`、`dc:creator`、`dc:date`、`media:thumbnail|content`、`enclosure`。
- 字段兜底:guid← `guid|id|link`(缺失用 title+published 的 hash);日期← `pubDate|published|updated|dc:date`(非法则 now);摘要← content:encoded/description 去标签截 400 字;图片← enclosure(image/*)|media:thumbnail|正文首个 `<img>`;lang← 标题中文字符占比粗判。
- OPML(客户端模块):导入解析 `outline` 树(带 `xmlUrl` 即源,父节点视为分类),去重上报 `POST /api/feeds`;导出生成 OPML 2.0(`head` + 分类嵌套,用于迁移备份)。
- 站点发现:`POST /api/feeds/discover`;找不到时提示手动填写 feed 地址。

### 8.2 阅读体验(功能 2)

见 7.3;预览面板即时预览(滑动条改动立刻反映在示例文本上),不做「保存」按钮。

### 8.3 全文抓取(功能 3)

- 客户端流水线:开文章 → 判断 `content_full` 为空且(手动点击 或 自动条件满足)→ `GET /api/proxy/html?url=` → `DOMParser` 解析文档 → `@mozilla/readability` 提取 → `DOMPurify` 清洗(白名单标签/属性,`a[href]` 强制 rel=noopener) → URL 绝对化、`img[data-src]` 提升 → 渲染 + `POST /api/articles/:id/fulltext` 持久化。
- 自动抓取条件(settings.`fetch_prefs`):`auto=true` 且 纯文本长度 < `min_chars`(默认 300)且文章有 url;仅在打开文章时惰性触发,不批量预抓。
- 手动:阅读器工具栏「抓取全文」按钮;失败给明确提示(超时/无法提取/被拒 403),不重试。
- 提取结果标记来源:正文顶部小字「全文来自原文页」并可切换回订阅摘要。

### 8.4 TTS 朗读(功能 4)

- 引擎:`window.speechSynthesis`(免费、可离线、系统音色);无可用语音时禁用按钮并提示。
- 切句(`sentences.ts`):按 `。!?!?;:` 与换行切分中文,按 `.!?` 切分拉丁(简单小数/缩写保护),合并 <4 字的碎片,单句 >200 字再按逗号细分;返回 `{text, start, end}` 与 DOM 文本节点偏移的映射,用于高亮。
- 播放器(`tts.ts`):逐句 `speak`,onend 驱动下一句(避免 Chrome 长队列缺陷);控制:播放/暂停/继续/停止、上一句/下一句、语速 0.5–2.0、音色选择(按文章 lang 过滤,优先 zh 音色)、点击任意句子从此开始;播放中当前句 `<mark class="tts-active">` 高亮 + `scrollIntoView({block:"center"})`;支持 MediaSession 元数据(锁屏控制);播放时申请 Screen Wake Lock。
- 朗读内容:优先 `content_full`,否则 `content`,否则 excerpt;跳过代码块与图片说明。

### 8.5 阅读管理(功能 5)

见 7.4;状态存 `article_states`,列表/详情/统计统一 join。

### 8.6 事件聚类(功能 6)

- 入口:Events 视图;面板可选「范围」100/200/300 条(本地镜像中最近的文章)与「相似度」宽松/适中/严格(默认适中)。
- 算法(`tokenize + tfidf + cluster`,在 `analysis.worker.ts` 运行):

  1. 文档文本 = 标题(权重 ×3)+ 摘要/正文前 500 字;去 URL、数字、标点。
  2. 分词:CJK 连续段取字符二元组(过滤纯标点);拉丁按词(小写,长度 ≥3);去中英停用词表(~120 词)。
  3. TF-IDF:tf=1+ln(count),idf=ln((1+N)/(1+df))+1;稀疏 `Map<term, weight>` + L2 归一化。
  4. 候选对:倒排索引仅比较共享词条的文档对;余弦相似度 ≥ 松弛阈值(0.42)才进入建边。
  5. 聚类:相似度 ≥ 档位阈值即为一条边,并查集求连通分量;≥2 篇的分量成「事件组」,单篇不展示。
  6. 组代表:组内与其他成员平均相似度最高的文章(medoid)标题作为组标题;组内按时间升序(发展脉络);组间按组内最新文章时间降序。
  7. 阈值:宽松 0.45 / 适中 0.58 / 严格 0.70(经验初值;实施时用内置合成样本 + 真实源校准并锁进单测)。
- 呈现:事件组卡片(组标题、篇数徽标、来源头像串、时间跨度)→ 展开时间线(每篇:来源、时间、标题,点击进阅读器)。
- 性能预算:300 篇 ≤ 2s(中端手机);Worker 分片计算并回报进度;切换档位/范围自动重算,可取消。
- 全程无网络请求,结果仅存内存。

### 8.7 关键词监控(功能 7)

- 规则结构:`{id, name, keyword, is_regex, case_sensitive, color, enabled}` 列表存 D1 `settings.keyword_rules`(跨设备同步规则本身)。
- 匹配(`keywords.ts`,Worker 内运行):普通词=子串匹配(默认不区分大小写;中文天然等价);正则=`new RegExp(pattern, case_sensitive?"":"i")`,编译失败即标红提示;匹配范围=标题+正文纯文本;每篇每规则最多记 200 处命中位置。
- 命中呈现:文章列表行显示规则色标;阅读器正文中命中词高亮(`<mark>`,颜色=规则色);关键词视图列出规则(命中数、启停开关、编辑删除);规则详情页列出全部命中文章(标题+命中次数+时间,点击跳转)。
- 范围说明:匹配对象为本地镜像文章(默认最近 1000 条,见 9.4),界面明确标注该范围;新文章入库后增量更新命中缓存。

### 8.8 AI 摘要 / 翻译(功能 8)

- 服务商配置(settings.`ai_providers`):多套 `{id, name, baseUrl, model, apiKey?, useProxy}`;内置预设:OpenAI(`https://api.openai.com/v1` / `gpt-4o-mini`)、DeepSeek(`https://api.deepseek.com/v1` / `deepseek-chat`)、Kimi(`https://api.moonshot.cn/v1` / `moonshot-v1-8k`)、智谱(`https://open.bigmodel.cn/api/paas/v4` / `glm-4-flash`)、硅基流动(`https://api.siliconflow.cn/v1`),字段均可改。
- 调用路径:默认浏览器直连 `POST {baseUrl}/chat/completions`(stream=true);设置 `useProxy` 时改走 `/api/ai/chat` 透传(解决 CORS)。SSE 分片解析为增量文本流式上屏,支持中止。
- 摘要:输入标题 + 正文纯文本截 6000 字;system 提示要求严格 JSON 输出 `{"one_liner":"一句话总结","points":["要点1",...3-5条]}`,语言=文章来源语言;解析失败降级为纯文本展示;结果存 `articles.ai_summary`,可重新生成。
- 翻译:切段(复用 `sentences.ts` 的块级切段:p/h1-h3/li/blockquote 为段)→ 按 ~3000 字分批,单批请求携带编号段落,要求输出 `[{"i":1,"t":"译文"}]` → 校验编号对齐;呈现三态:原文 / 译文 / 对照(段落下拉式对照);长文流式逐批填充;结果存 `articles.ai_translation`。目标语言:中文/英文/日语/韩语。
- 密钥存储:默认仅 `localStorage`(界面明示「密钥只存本机,不上传」);设置里可选「同步到云端(D1)」以便多设备(明确风险提示)。
- 无配置时按钮置灰并引导到设置页。

### 8.9 部署(功能 9)

见 13。

## 9. 本地计算模块规格(实现级)

### 9.1 分词/向量(`tokenize.ts` / `tfidf.ts`)

纯函数、无依赖:输入文本 → `tokens: string[]`;`buildTfIdf(docs) → {docs: SparseVec[], idf: Map}`;`cosine(a, b)`。停用词表内置(中英各约 60 词,覆盖「的/了/是/the/a/is/and」等)。全部可单测。

### 9.2 聚类(`cluster.ts`)

`cluster(articles, {threshold}) → Cluster[]`;medoid 选取、零向量处理(跳过比较)、空结果返回 []。测试:构造 3 组近似文本 + 噪声,断言分组正确与阈值单调性(宽松 ≥ 适中的组数)。

### 9.3 Worker 协议(`analysis.worker.ts`)

消息:`{type:"cluster", payload}` / `{type:"keywords", payload}` → 进度 `{type:"progress", value}` → 结果 `{type:"result", ...}` / `{type:"error"}`;支持 `{type:"cancel"}`。聚类与关键词均在此 Worker,不阻塞主线程。

### 9.4 IndexedDB 镜像(`idb.ts`)

- 库 `readly`,store `articles`(key=id,索引 `published_at`、`feed_id`)、`meta`(游标/时间)。
- 滚动窗口:保留最近 `MIRROR_LIMIT = 1000` 篇,超出按 published_at 淘汰;单篇 content 截断 256KB。
- 同步:`GET /api/articles/mirror` 从最新向旧翻页,应用启动时后台同步,刷新完成后增量同步新 id;离线时镜像即数据源(列表+阅读可离线)。
- 聚类读取镜像前 N(100/200/300)篇;关键词匹配全镜像。

## 10. 错误处理与边界

- 订阅源:单源失败不影响其他源;UI 源列表显示失败标记(⚠ + last_error 悬浮说明);连续失败退避(见 6)。
- 代理/提取:超时 20s;目标 >3MB 截断;403/反爬 → 提示「该站点拒绝抓取」;非 HTML 提示不支持。
- AI:HTTP 4xx/5xx 透传错误信息(如 Key 无效、余额不足、模型不存在);流中断保留已生成内容并提示重试;JSON 解析失败降级纯文本。
- TTS:无语音引擎 → 按钮禁用 + 提示;iOS 首次播放需用户手势(播放按钮满足)。
- 镜像:IndexedDB 写失败降级为内存缓存并提示(隐私模式等)。
- 空状态:无订阅 → 引导页(导入 OPML / 添加订阅);无事件组 → 「当前范围没有找到相近的新闻」。

## 11. 安全

- 认证:单用户 `AUTH_TOKEN`(wrangler secret);所有 /api 请求校验 Bearer,恒定时间比较;前端令牌存 localStorage,401 统一跳登录。
- SSRF 防护(`lib/ssrf.ts`,用于 proxy 与 ai):仅允许 http/https;**拒绝**私网与保留地址(localhost、127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7、0.0.0.0),拒绝重定向到私网。
- HTML 清洗:订阅内容与提取正文经 DOMPurify/白名单清洗,去 script/iframe/事件属性/js: 协议。
- AI 密钥:默认不出本机;用户显式选择时才写入 D1(设置页提示)。
- 隐私承诺:聚类与关键词计算零网络请求(实施时以代码评审确认 Worker 内无 fetch 调用)。

## 12. 测试策略

Vitest 单测(与实现同里程碑交付):

- `worker/lib/feed-parser`:RSS2 / Atom / RDF / JSON Feed 四种 fixture 归一化断言;日期兜底、guid 兜底、图片提取。
- `worker/lib/discover`:HTML fixture 中 link 提取与常见路径;`ssrf`:私网/协议矩阵。
- `worker/routes`(miniflare/pool-workers):auth 401、feeds 增删查、articles 列表分页与状态 upsert、settings 读写。
- `web/modules`:tokenize/tfidf/cluster(合成样本+阈值单调)、keywords(普通/正则/大小写/无效正则)、sentences(中英混合样板)、html(切段/纯文本/绝对化)、opml(导入导出 roundtrip)、SSE 解析。
- `shared`:常量与类型守卫。

手动 E2E 验收清单(README 附录):真实源订阅→阅读→主题切换→全文抓取→朗读→标状态→聚类→关键词→AI(可用 mock 服务商)→OPML 导出再导入。每功能至少一条验收判据。

## 13. 部署与开发流程

本地开发:

```
pnpm install
pnpm --filter worker d1:migrate:local     # 应用迁移到本地 D1
pnpm dev                                  # vite dev(5173,代理 /api)+ wrangler dev(8787)
```

首次部署(README 详述):

```
pnpm build                                        # 构建 web
cd worker
wrangler d1 create readly                         # 记下 database_id 填入 wrangler.toml
wrangler d1 migrations apply readly --remote
wrangler secret put AUTH_TOKEN                    # 设置访问令牌
wrangler deploy                                   # 发布 Worker+静态资源+Cron
```

免费额度:Workers 免费版 10 万请求/天、~10ms CPU/次(已按 3.2 适配,源多时建议升级 $5/月);D1 免费 5GB/500 万行读每天,个人使用充裕。

## 14. 里程碑(实施顺序)

- **M0 脚手架**:workspace、TS/Tailwind/Vite/wrangler 骨架、0001 迁移、auth 中间件、`/api/auth/check`、登录页、shared 类型。
- **M1 订阅与阅读核心**:feed 解析/发现/刷新(含分批)、categories/feeds/articles/stats API、三栏 UI、状态管理、日期分组、批量操作、快捷键、OPML 导入导出、批量加源。
- **M2 阅读体验与 PWA**:主题系统(外观+6 阅读主题+强调色)、滑块偏好、D1 同步、响应式单栏、PWA 与图标。
- **M3 全文抓取**:proxy 路由(SSRF)、客户端提取流水线、惰性自动抓取、持久化。
- **M4 本地分析**:IDB 镜像与同步、tokenize/tfidf/cluster、Events UI;关键词规则 CRUD、匹配 Worker、高亮与规则详情。
- **M5 TTS**:切句、播放器、逐句高亮、语速/音色、Wake Lock。
- **M6 AI**:服务商配置与预设、SSE 流式客户端、摘要、翻译三态、缓存与代理开关。
- **M7 收尾**:worker 集成测试、README 部署文档、手动 E2E 清单执行、细节打磨(空态/错误态/动效)。

每个里程碑:先实现纯逻辑模块与其单测,再接入 UI;里程碑末做该块 E2E 自查。

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| 免费版 CPU 10ms 限制导致刷新失败 | 分批刷新 + 客户端驱动(3.2);文档建议升级 Paid |
| 各站 feed 格式怪异/日期缺失/guid 缺失 | 兜底链 + fixture 测试覆盖(8.1) |
| AI 服务商 CORS 拒直连 | `useProxy` 开关走 Worker 转发 |
| iOS Web Speech 音色/行为差异 | 音色选择 + 无引擎禁用 + 用户手势启动;播放器逻辑集中单测 |
| 反爬站点拒绝抓取(403) | 明确提示不重试;保留订阅摘要阅读 |
| 文章体积增长 | content 截断 256KB + 可选 retention 清理 |
| 聚类在低端机卡顿 | Web Worker + 倒排剪枝 + 进度提示 + 范围上限 300 |
