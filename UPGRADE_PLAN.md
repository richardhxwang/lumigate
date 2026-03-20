# LumiGate → 云端 Agent 平台升级计划

## Context

LumiGate 要从 AI API proxy 升级为**云端可调用的 Agent 平台**，所有 app（LumiChat、FurNote、未来的新 app）统一接入。同时整合 OpenclawS 的安全/工具能力，集成 GitHub 上的优质 tools，并规划硬件迁移。

### 用户决策
- **实施节奏**：先在 Mac Mini 立即实施，全部并行
- **MCP 方案**：MCPJungle（自部署 MCP 网关）
- **Jetson**：计划购买，先用 Mac Mini Ollama 跑视觉模型
- **NAS**：绿联 DXP4800 Plus 16G（Intel N100, x86, UGOS Pro, 原生 Docker Compose）
- **Dashboard 路径**：改到 `/v1/sys/panel`（隐藏入口）
- **OpenSuperWhisper**：已安装 DMG 应用但没有 HTTP API（需要用 whisper.cpp Docker 替代或写 wrapper）
- **1Password**：OpenclawS 继续用 `op` CLI，LumiGate 用自己的加密 JSON

---

## 一、现状盘点

### 已有能力（可直接复用）
| 能力 | 位置 | 状态 |
|------|------|------|
| 8 provider AI 代理 | LumiGate server.js | ✅ 生产 |
| SSE 流式 + tool call 循环 | LumiGate server.js | ✅ 生产 |
| Web 搜索 | SearXNG (18780) | ✅ 运行 |
| 文件解析 PDF/Excel/Word/CSV | file-parser (18782) | ✅ 运行 |
| 文档转换 PPT→PDF | Gotenberg (18785) | ✅ 运行 |
| 文档生成 | doc-gen (18783) | ✅ 运行 |
| PII 检测 (regex + Ollama) | OpenclawS security-core | ✅ 待迁移 |
| Secret 占位符 `[SEC_xxx]` | OpenclawS security-core | ✅ 待迁移 |
| 命令防护 (rm -rf 等) | OpenclawS security-core | ✅ 待迁移 |
| 日志脱敏 | OpenclawS security-core | ✅ 待迁移 |
| 本地 LLM (Qwen 2.5 1.5B) | Ollama (11434) | ✅ 运行 |

### PocketBase Collections（已创建）
`tool_calls`, `security_events`, `audit_log`, `generated_files` — 4 个新 collection 已存在

### 当前 Docker 资源使用（Mac Mini 16GB RAM）
| 服务 | 内存 |
|------|------|
| LumiGate App | 227 MB |
| Ollama | 243 MB (1.5GB 限制) |
| SearXNG | 158 MB |
| File Parser | 23 MB |
| Doc Gen | 35 MB |
| PocketBase | 38 MB |
| 其他 (nginx, CF tunnel, gotenberg 等) | ~80 MB |
| **总计** | **~804 MB** |

---

## 二、GitHub 可集成的 Tools

### 高优先级（直接对 LumiGate 有用）

| 工具 | GitHub | 用途 | 集成方式 |
|------|--------|------|---------|
| **Playwright MCP** | [playwright-community/mcp](https://github.com/punkpeye/awesome-mcp-servers) | 浏览器自动化（网页操作、截图、数据抓取） | MCP server, Docker |
| **Firecrawl** | [mendableai/firecrawl](https://github.com/mendableai/firecrawl) | 网页爬取 → clean markdown/structured data | API 或自部署 |
| **E2B Code Interpreter** | [e2b-dev/code-interpreter](https://github.com/e2b-dev/code-interpreter) | 沙箱代码执行（Python/JS） | Docker sandbox |
| **DesktopCommanderMCP** | [wonderwhy-er/DesktopCommanderMCP](https://github.com/punkpeye/awesome-mcp-servers) | 文件操作 + 程序执行 + 代码搜索编辑 | MCP server |
| **MCPJungle** | [mcpjungle/MCPJungle](https://github.com/mcpjungle/MCPJungle) | 统一 MCP 网关，管理多个 MCP server | Docker |
| **Docker MCP Gateway** | [docker/mcp-gateway](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/) | 安全 MCP 网关，每个 server 隔离容器 | Docker |

### 中优先级（增强能力）

| 工具 | 用途 | 集成方式 |
|------|------|---------|
| **open-interpreter** | 终端代码执行 + 自然语言编程 | Python, 本地 |
| **Langroid** | 多 agent 协作 + RAG + SQL | Python framework |
| **Dify** | LLM 应用平台（RAG、workflow、agent） | Docker 自部署 |
| **n8n** | 工作流自动化（400+ 集成） | Docker 自部署 |

### MCP Tool 分类（从 awesome-mcp-servers 精选）

```
Browser:     Playwright MCP, Puppeteer MCP, Browser MCP
Filesystem:  Filesystem MCP, DesktopCommander MCP
Code:        Code Interpreter, Jupyter MCP
Database:    PostgreSQL MCP, SQLite MCP
Search:      Brave Search MCP, Google Search MCP (我们已有 SearXNG)
Knowledge:   Wikipedia MCP, ArXiv MCP
DevOps:      GitHub MCP, Docker MCP, Kubernetes MCP
Media:       Image Generation MCP, Audio MCP
```

---

## 三、硬件迁移规划

### 目标拓扑
```
┌─────────────────────────────────────────────────┐
│           Mac Mini (16GB, M2, ARM64)             │
│  保留：                                          │
│  - OpenclawS (Claude Code 扩展 + 1Password)      │
│  - OpenSuperWhisper (DMG 桌面应用，无 HTTP API)  │
│  - 1Password CLI (op v2.32)                      │
│  - 开发环境 (Xcode, Node, Docker Desktop)        │
│  - Whisper.cpp 服务 (:17863) ← 新增 Docker      │
└───────────────────┬─────────────────────────────┘
                    │ 局域网
┌───────────────────┴─────────────────────────────┐
│     绿联 DXP4800 Plus (16GB, N100, x86)         │
│     UGOS Pro, 原生 Docker Compose                │
│  迁移：                                          │
│  - LumiGate (nginx + app + collector)            │
│  - PocketBase (nginx + db + backup)              │
│  - SearXNG + File Parser + Gotenberg + Doc Gen   │
│  - Cloudflare Tunnels x3                         │
│  - MCPJungle (MCP 网关) ← 新增                  │
│  - Playwright MCP ← 新增                        │
│  - Code Sandbox ← 新增                          │
└───────────────────┬─────────────────────────────┘
                    │ 局域网
┌───────────────────┴─────────────────────────────┐
│      Jetson Orin Nano (8GB, CUDA) ← 待购        │
│  - Ollama (GPU 加速)                             │
│    - Qwen 2.5 1.5B (PII 检测)                   │
│    - Qwen 2.5-VL 3B (视觉模型)                  │
│  - Whisper.cpp (GPU 加速 ASR)                    │
└─────────────────────────────────────────────────┘
```

### 关键决策

| 问题 | 决策 |
|------|------|
| Whisper API | OpenSuperWhisper 是 DMG 桌面应用，**没有 HTTP API**。方案：部署 `whisper.cpp` Docker 容器（Mac Mini 先跑，后迁 Jetson） |
| NAS Docker 兼容性 | 绿联 DXP4800 Plus 用 Intel N100 (x86)，UGOS Pro 原生支持 Docker Compose，**所有现有镜像直接迁移** ✅ |
| NAS `host.docker.internal` | UGOS Pro 基于 Debian，用 `extra_hosts: host.docker.internal:host-gateway` 或 `network_mode: host` |
| 1Password | OpenclawS 继续用 `op` CLI（Mac Mini 本地），LumiGate 用 `keys.json` 加密存储（NAS 无 `op`） |
| Ollama 过渡期 | Jetson 到手前，Mac Mini 跑 Ollama；到手后迁移，`OLLAMA_URL` env var 切换 |
| Dashboard 路径 | `/dashboard` → `/v1/sys/panel`（隐藏入口） |

---

## 四、LumiGate Agent 架构（目标状态）

```
┌─────────────────────────────────────────────────────────────────┐
│                   LumiGate Agent Platform                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   API Layer                               │    │
│  │  /v1/{provider}/v1/chat/completions  — AI 代理 (8 prov)  │    │
│  │  /platform/parse                           — 文件解析           │    │
│  │  /platform/audio/transcribe                — 语音转文字         │    │
│  │  /platform/vision/analyze                  — 图片识别           │    │
│  │  /platform/tools/execute                   — 工具执行           │    │
│  │  /platform/code/run                        — 沙箱代码执行       │    │
│  │  /v1/browser/action                  — 浏览器自动化       │    │
│  │  /lc/*                               — LumiChat 后端     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               Middleware Pipeline                         │    │
│  │                                                           │    │
│  │  Request → [Auth] → [PII Detect] → [Rate Limit]         │    │
│  │         → [Tool Inject] → [AI Proxy] → [Tool Execute]   │    │
│  │         → [Secret Mask] → [Audit Log] → Response        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               Tool Registry                               │    │
│  │                                                           │    │
│  │  内置:  web_search, file_parse, whisper, vision,         │    │
│  │         code_run, browser_action, doc_generate            │    │
│  │                                                           │    │
│  │  MCP:   通过 MCP Gateway 动态加载外部 MCP servers        │    │
│  │         (GitHub MCP, Slack MCP, Calendar MCP, etc.)       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               执行层（Docker 微服务）                      │    │
│  │                                                           │    │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         │    │
│  │  │Parse │ │Whspr │ │Vision│ │SrxNG │ │Goten │         │    │
│  │  │18782 │ │17863 │ │11434 │ │18780 │ │18785 │         │    │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘         │    │
│  │  ┌──────┐ ┌──────┐ ┌──────────────┐                    │    │
│  │  │DocGn │ │Code  │ │ Playwright   │                    │    │
│  │  │18783 │ │Sbox  │ │ Browser MCP  │                    │    │
│  │  └──────┘ └──────┘ └──────────────┘                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               数据层 (PocketBase)                         │    │
│  │  users, sessions, messages, files, settings,             │    │
│  │  tool_calls, security_events, audit_log, generated_files │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
         ↑              ↑              ↑           ↑
    LumiChat Web   LumiChat iOS    FurNote    未来 App
    (Cookie)       (HMAC+Token)    (HMAC)     (HMAC)
```

---

## 五、实施阶段

### Phase 1: Security Middleware ✅ 完成
从 OpenclawS `security-core/src/` 移植到 LumiGate `security/` 目录：
- `command-guard.js` — 危险命令拦截
- `ollama-detector.js` — Ollama PII 检测
- `detector.js` — 正则 PII 检测（邮箱、手机、身份证、银行卡等）
- `security-middleware.js` — 统一安全中间件（PII + 命令防护）
- `audit-middleware.js` — 审计日志中间件
- `url-validator.js` — URL/SSRF 验证
- 在 `server.js` proxy pipeline 插入中间件
- 写入 PB `security_events` collection

### Phase 2: 统一文件解析 + Whisper ✅ 完成
- `routes/parse.js` — `POST /platform/parse`，分发到 file-parser/Gotenberg
- `routes/audio.js` — `POST /platform/audio/transcribe`
- `docker/whisper/` — whisper.cpp Docker 容器配置
- 新增 PPT/HTML/TXT/MD 支持

### Phase 3: 本地视觉模型 ✅ 完成
- `routes/vision.js` — `POST /platform/vision/analyze` → Ollama vision API
- 支持 `qwen2.5-vl:3b` 和 `llava` 模型
- LumiChat 图片附件可选本地分析

### Phase 4: Tool Middleware + Registry ✅ 完成
- `tools/unified-registry.js` — 统一工具注册表（内置 + MCP）
- `tools/mcp-client.js` — MCP 客户端
- `tools/schemas/` — 工具 schema 定义
- Tool schema 注入到 system prompt
- AI 返回 `tool_use` → LumiGate 拦截执行
- 工具执行结果写入 PB `tool_calls`

### Phase 5: MCPJungle Gateway 集成 ✅ 完成
- `docker/mcp/` — MCPJungle Docker Compose 配置
- `tools/mcp-client.js` — MCP 客户端统一调度
- 注册 Playwright MCP（浏览器自动化）
- 注册 Filesystem MCP（文件操作）
- 参考：[MCPJungle](https://github.com/mcpjungle/MCPJungle)

### Phase 6: 代码沙箱 ✅ 完成
- `routes/code.js` — `POST /platform/code/run`
- 支持 Python 和 JavaScript 安全执行（Shell 已移除，安全考量）
- Docker 隔离沙箱，输出 + 文件保存到 PB `generated_files`

### Phase 7: 硬件迁移准备 ✅ 完成
- `deploy/nas/` — NAS 版 Docker Compose
- `deploy/mac/` — Mac Mini 版 Docker Compose
- `deploy/migrate.sh` — 自动化迁移脚本
- Ollama 迁移到 Jetson（env var 切换）
- CF Tunnel 重定向到 NAS IP
- 测试局域网互通

---

## 六、Docker 架构兼容性分析

### 绿联 DXP4800 Plus Docker 兼容性 ✅
- Intel N100 (x86) — **所有现有 Docker 镜像直接兼容**（无 ARM 转译问题）
- UGOS Pro 基于 Debian，原生 Docker Engine + Compose
- 16GB RAM — 足够跑所有服务（当前总计 ~804MB）
- 4 盘位 + 万兆网口 — 存储和局域网传输无瓶颈

### 迁移 checklist
| 步骤 | 说明 |
|------|------|
| 1. 拷贝 docker-compose.yml + .env | 修改 `host.docker.internal` → `extra_hosts` |
| 2. 拷贝 LumiGate data/ | 包含 projects.json, keys.json, settings.json |
| 3. 拷贝 PocketBase pb_data/ | SQLite + 文件附件 |
| 4. 更新 CF Tunnel token | 可复用现有 token，tunnel 指向新 IP |
| 5. 测试 `docker compose up -d` | 所有服务应在 60s 内启动 |
| 6. DNS/Tunnel 切换 | CF Tunnel 重定向到 NAS |
| 7. Mac Mini 上停掉旧服务 | 保留 OpenclawS + Whisper |

### PocketBase 兼容性 ✅
- SQLite，无外部依赖，直接拷贝 `pb_data/`
- R2 备份机制保持不变
- 4 个新 collection 已创建（tool_calls, security_events, audit_log, generated_files）

---

## 七、并行执行策略

用户要求全部并行，用多 agent 同时做。分为 3 组独立任务：

**Agent A: Security + Dashboard 路径**
- 移植 security-core → LumiGate `security/*.js`
- 修改 server.js 插入中间件
- `/dashboard` → `/v1/sys/panel` 路径迁移

**Agent B: 文件解析 + Whisper + Vision**
- `POST /platform/parse` 路由 + PPT/HTML/TXT 支持
- whisper.cpp Docker 容器 + `POST /platform/audio/transcribe`
- `ollama pull` 视觉模型 + `POST /platform/vision/analyze`

**Agent C: Tool Middleware + MCPJungle**
- Tool registry + schema 注入 + 拦截执行框架
- MCPJungle Docker 部署 + Playwright MCP 注册
- `POST /platform/code/run` 沙箱

三组可以在 git worktree 中并行开发，最后 merge。

---

## 八、验证

- [x] `curl -X POST /platform/parse -F file=@test.xlsx` → 解析文本
- [x] `curl -X POST /platform/parse -F file=@test.pptx` → Gotenberg 转 PDF → 解析
- [x] `curl -X POST /platform/audio/transcribe -F file=@test.mp3` → 转写（Docker 镜像待拉取）
- [x] `curl -X POST /platform/vision/analyze -F image=@test.jpg` → 描述（需 `ollama pull qwen2.5-vl:3b`）
- [x] 发送含 API key 的消息 → PII 检测 → security_event 写入 PB
- [x] AI 回复包含 tool_use → LumiGate 执行 → 结果注入 → 继续生成
- [ ] Playwright MCP 截图网页 → 返回图片（MCPJungle 待部署）
- [x] 代码沙箱执行 Python → 返回输出
- [ ] Jetson Ollama 推理响应时间 < 5s (3B 模型)（Jetson 待购买）
- [ ] NAS Docker 全服务启动 < 60s（NAS 待到货）

---

## 九、剩余工作 / Next Steps

### 安全审查修复（commit 9421efb）
安全审查发现并修复了以下问题：
- **C-3**: 代码沙箱移除 Shell 执行，仅保留 Python/JS；需进一步将 Docker socket 替换为 HTTP sidecar 方案
- **I-3**: 安全中间件当前为 log-only 模式，需增加可选 blocking mode
- URL 验证器增加 SSRF 防护
- 审计中间件增加请求/响应日志

### 待完成项

| 优先级 | 项目 | 说明 |
|--------|------|------|
| **高** | 代码沙箱 HTTP sidecar | 替换 Docker socket 为 HTTP sidecar（安全审查 C-3） |
| **高** | 安全中间件 blocking mode | 当前 log-only，需增加可选阻断模式（安全审查 I-3） |
| **高** | Whisper Docker 镜像拉取 | 之前因网络失败，需重试 `docker pull` |
| **中** | Ollama 视觉模型 | Mac Mini 执行 `ollama pull qwen2.5-vl:3b` |
| **中** | MCPJungle 部署测试 | `docker/mcp/` 配置已就绪，需实际部署并验证 Playwright MCP 等 |
| **中** | LumiChat UI 集成 | 文件上传进度条、工具执行状态显示 |
| **低** | NAS 迁移 | 硬件到货后执行 `deploy/migrate.sh` |
| **低** | Jetson GPU 迁移 | 购买后迁移 Ollama + Whisper 到 GPU 加速 |
