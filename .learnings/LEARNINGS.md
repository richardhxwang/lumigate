# Learnings

## [LRN-20260316-001] correction

**Priority**: critical
**Status**: pending
**Area**: tools

### 内容
生成的 Excel/Word/PPT 文件全部空白。用户多次指出但我每次都声称"成功"而没有自己验证文件内容。

根本原因分析：
1. Excel: doc-gen 的 `generateXlsx` 使用 `ss.data` 字段，但 AI 输出 `rows` → 已修复接受两者，但可能仍有数值被存为 shared string index 而非实际值
2. Word: doc-gen 的 `generateDocx` 可能没有正确处理 sections 内容
3. PPT: 可能 slides 内容格式不匹配
4. 核心问题：我在报告"成功"前没有实际验证文件内容（VBR 违规）

### 建议修复
1. 每次生成文件后，用 Python 解析验证内容非空
2. doc-gen 需要调试：本地启动 node 直接测试
3. 不要只看文件大小就说"PASS"
4. 用 MiniMax 测试完整端到端流程

### 元数据
- Source: correction
- Pattern-Key: blind-success-reporting

---

## [LRN-20260316-002] correction

**Priority**: high
**Status**: pending
**Area**: tools

### 内容
用户反复要求"自己检查""自己improve"，不要等用户指出问题。这是第三次以上被提醒。

模式：
- 生成文件 → 看到文件大小 > 0 → 报告成功 → 用户说是空的
- 应该：生成文件 → 解析文件验证有内容 → 修复问题 → 再验证 → 才报告

### 建议修复
建立强制验证流程：文件生成后必须用程序打开验证内容。

### 元数据
- Source: correction
- See Also: LRN-20260316-001
- Pattern-Key: blind-success-reporting

---

## [LRN-20260318-001] best_practice

**Priority**: high
**Status**: pending
**Area**: infra

### 内容
PocketBase 的 `lc_messages.content` 存在 5000 字符限制。只在后端创建接口做截断不够，前端还会在 user message 创建、assistant message 落库、以及附件后台同步后 PATCH message 时重复写入 content；任何一条路径没截断，都会在回复完成后触发 `content must not more than 5000 characters`。

### 建议修复
对消息内容长度做双端兜底：
1. 前端在所有 `/lc/messages` POST/PATCH 调用前统一截断
2. 后端在 `/lc/messages` POST/PATCH 再次截断
3. 截断后附带明确标记，避免误以为模型输出丢失

### 元数据
- Source: task_review
- Pattern-Key: pb-message-length-dual-clamp

---

## [LRN-20260318-002] correction

**Priority**: high
**Status**: pending
**Area**: config

### 内容
用户明确要求：实现时尽量不要写散落的硬编码；能抽成变量、常量或配置入口的值，应统一抽取，并保留默认值，方便未来变更。像时间间隔、重试次数、长度阈值、自动续写轮数这类值，尤其不应直接埋在逻辑里。

### 建议修复
1. 新增行为参数时优先定义为命名常量
2. 需要跨模块或未来可调的值优先进入集中配置
3. 保留默认值，但避免魔法数字直接出现在分支逻辑中

### 元数据
- Source: correction
- Pattern-Key: avoid-magic-values

---

## [LRN-20260318-003] correction

**Priority**: high
**Status**: pending
**Area**: infra

### 内容
用户明确要求：LumiChat 相关数据在结构上应视为 `LC` 这一顶级业务域，和 `FN`、`LG` 同级，而不是混入通用 `admin/users` 语义里。关系字段可以继续引用 PocketBase 的 `users` auth collection，但 collection 命名、数据边界、以及后续 schema 设计都应优先体现 `lc_*` 这一独立域模型。

### 建议修复
1. 后续新增 LC collection 统一使用 `lc_*` 命名空间
2. 设计说明里明确 `LC` 是顶级业务域，不是 admin 子模块
3. 梳理现有 LC schema，避免把业务归属、权限归属、认证归属混为一层

### 元数据
- Source: correction
- Pattern-Key: lc-top-level-domain

---

## [LRN-20260318-004] correction

**Priority**: high
**Status**: pending
**Area**: infra

### 内容
用户强调这次 compose 失败的教训要记住：当目标只是更新单个服务时，不应直接用 `docker compose up --build`，否则会被 compose 中其它无关服务（尤其镜像名失效或私有镜像）拉取失败连带阻断，导致“改了代码但没上线”。

### 建议修复
1. 先执行 `docker compose config` 校验配置完整性
2. 单服务更新采用 `docker compose build <service>` + `docker compose up -d --no-deps <service>`
3. 发现 compose 镜像失效时，先修 compose 再做部署动作

### 元数据
- Source: correction
- See Also: ERR-20260318-001
- Pattern-Key: compose-single-service-safe-update

---

## [LRN-20260318-005] correction

**Priority**: critical
**Status**: pending
**Area**: infra

### 内容
用户强调“先看日志再判断问题”。如果某个关键链路出问题却没有可用日志，这不是偶发问题，而是系统设计缺陷。日志缺失会直接拖慢定位速度，导致反复试错。

### 建议修复
1. 默认流程固定为：先查日志，再下结论，再改代码
2. 所有关键组件必须有可追溯运行日志（网关、Nginx、Whisper、PB、解析服务、容器内子进程）
3. 日志必须有保留策略（轮转上限），避免“要么无日志，要么磁盘打满”
4. 发布前检查项新增：
   - 日志路径可写
   - 日志轮转已配置
   - `docker system df` 空间充足

### 元数据
- Source: correction
- See Also: ERR-20260318-002
- Pattern-Key: logs-first-systemic-observability

---

## [LRN-20260319-001] correction

**Priority**: high
**Status**: pending
**Area**: tools

### 内容
用户中断本轮实现，暴露出一个工作流问题：当任务从“重构后端运行时”切换到“让后端可调参数反映到 LumiChat 设置”时，不能直接在旧实现路径上继续编码。应该先收敛新的目标边界，确认优先级，再开始修改文件。否则会在未完成的重构上下文里插入新需求，导致变更分散、验证中断、用户不得不打断。

### 建议修复
1. 需求切换时先暂停当前实现，明确新的唯一主任务和验收边界
2. 在开始编辑前先确认当前代码状态、受影响文件和最小切入点
3. 只在目标重新收敛后再继续编码，避免同时推进两个半完成方向

### 元数据
- Source: correction
- Pattern-Key: rescope-before-edit

---

## [LRN-20260321-001] correction

**Priority**: critical
**Status**: pending
**Area**: architecture

### 内容
从 server.js 拆分路由时，函数依赖传递必须完整。chat.js 引用了 18 个 lumichat.js 中的函数但没传过去，导致发消息就崩溃。仅靠 `node -c` 语法检查不够——未传递的函数在运行时才报 `ReferenceError`。

根本原因：提取路由时只搬了代码，没系统性扫描闭包依赖。

### 建议修复
1. 拆分路由后必须跑依赖扫描脚本：比较 chat.js 里引用的函数名 vs deps 里传入的函数名
2. 用 `node -e "require('./routes/chat')({...mock deps...})"` 做运行时验证，不能只依赖语法检查
3. 大规模提取后，在容器内跑一次真实请求验证

### 元数据
- Source: task_review
- Pattern-Key: route-extraction-dep-completeness

---

## [LRN-20260321-002] correction

**Priority**: critical
**Status**: pending
**Area**: architecture

### 内容
`express.Router()` 挂载在参数化路径 (`/v1/:provider`) 下时必须加 `{ mergeParams: true }`，否则子路由拿不到父路由的 `req.params`。这个 bug 导致所有 proxy 请求崩溃，但 `node -c` 检测不出来。

### 建议修复
所有提取的子路由文件如果挂载在参数化路径下，一律用 `express.Router({ mergeParams: true })`。

### 元数据
- Source: task_review
- Pattern-Key: express-merge-params

---

## [LRN-20260321-003] best_practice

**Priority**: high
**Status**: pending
**Area**: workflow

### 内容
多 agent 并行修改同一个文件（server.js）会导致冲突覆盖。两个 agent（admin 提取 + lumichat 提取）同时改 server.js，后完成的覆盖了先完成的改动，导致路由挂载丢失、代码重复。

### 建议修复
1. 同一个文件不能分给两个并行 agent 改
2. 如果必须并行改同一文件，用顺序依赖（agent B 等 agent A 完成后再开始）
3. 完成后必须做合并验证

### 元数据
- Source: task_review
- Pattern-Key: no-parallel-same-file

---

## [LRN-20260321-004] correction

**Priority**: high
**Status**: pending
**Area**: config

### 内容
LumiChat 有两层 CSP：nginx 全局 CSP + server.js nonce-based CSP。server.js 的 CSP 覆盖 nginx 的。只改 nginx CSP 不够，必须同时改 server.js 里 `/lumichat` 路由的 CSP。KaTeX CDN 被拦就是因为只改了 nginx 没改 server.js。

### 建议修复
修改 CSP 时必须检查两处：nginx/nginx.conf 和 server.js 里对应页面的 setHeader。

### 元数据
- Source: task_review
- Pattern-Key: dual-csp-lumichat

---

## [LRN-20260321-005] best_practice

**Priority**: high
**Status**: pending
**Area**: workflow

### 内容
用户要求：有选项的东西（如审计工具清单、方案选择）要先讨论让用户选，不要直接做。已经在做的东西别停，但新增的要先确认。

### 建议修复
涉及工具选型、功能清单、方案对比时，先列出选项 + 推荐，等用户确认再执行。

### 元数据
- Source: correction
- Pattern-Key: ask-before-implementing-options

---

## [LRN-20260321-006] best_practice

**Priority**: high
**Status**: pending
**Area**: architecture

### 内容
PB fire-and-forget 写入 (`.catch(() => {})`) 绝对不能静默吞错误。本次 session 发现 30+ 处静默 catch，任何一个 PB 写失败都无迹可查。用户要求全链路可观测——从前端到 PB 任何节点出错都要 log + Loki 告警。

### 建议修复
所有 `.catch(() => {})` 改为 `.catch(e => log('error', 'pb_write_failed', { ... }))`。新增代码绝不允许空 catch。

### 元数据
- Source: task_review
- Pattern-Key: no-silent-catches

## [LRN-20260319-002] correction

**Priority**: high
**Status**: pending
**Area**: collaboration

### 内容
用户再次明确协作要求：任务应持续推进直到完成，不要因为存在次要不确定性就停下来等待；只有遇到真正影响设计正确性的关键分叉时，才提问，并且问题要附带推荐选项，方便用户快速拍板。

### 建议修复
1. 默认采取最稳妥的实现假设继续推进
2. 仅在关键架构分叉或高风险不可逆变更前提问
3. 提问时给出推荐选项和简短取舍，避免开放式追问

### 元数据
- Source: correction
- See Also: LRN-20260319-001
- Pattern-Key: keep-going-ask-only-on-critical-forks

---

## [LRN-20260319-003] task_review

**Priority**: high
**Status**: pending
**Area**: infra

### 内容
这次前端“明明改了但线上没变”的根因不是浏览器缓存，而是运行镜像没有挂源码目录，`lumichat.html` 和新增的 `lumigent/` 都需要通过镜像重建进入容器。仅看工作区文件和 `node -c` 会误判；必须同时核对“本地源码、容器内文件、运行日志”三处是否一致。

### 建议修复
1. 代码改动后先确认服务是否是 bind mount 还是 baked image
2. 新增目录或静态资源时，同步检查 `Dockerfile COPY` 是否覆盖
3. UI 未生效时按顺序检查：
   - `curl /lumichat` 返回的 build marker
   - 容器内对应文件内容
   - `data/logs/runtime/server.log` 的启动日志

### 元数据
- Source: task_review
- See Also: LRN-20260318-005

---

## [LRN-20260320-001] correction

**Priority**: critical
**Status**: pending
**Area**: infra

### 内容
这次“上传仍触发 fetch”反复出现的直接原因是：我改了代码并 build 了新镜像，但只执行了 `docker restart lumigate`，没有重建容器。结果运行中的容器继续使用旧文件，导致我误以为修复无效。

### 建议修复
1. 镜像更新后必须执行容器重建：`docker compose up -d --no-deps --force-recreate <service>`
2. 变更后固定做“运行中容器代码校验”：在容器内 `grep` 关键标记，确认新逻辑已加载
3. 把“restart 仅重启旧容器”作为发布检查项，避免再次把部署问题误判成业务逻辑问题

### 元数据
- Source: correction
- See Also: LRN-20260319-003
- Pattern-Key: restart-vs-recreate-container

---

## [LRN-20260319-004] task_review

**Priority**: high
**Status**: pending
**Area**: files

### 内容
大文件附件链路里，“上传成功 + 解析成功 + 模型有回答”不等于模型真的能看到文件后段。此次 5MB Excel 的真实尾行 marker 存在，但 `lcCleanSpreadsheetExtractedText` 的行数/字符上限把后段截断，导致模型只能看到中段并错误回答“未找到”或返回错误字段。

### 建议修复
1. 大表提取清洗阈值要可配置，并默认足够覆盖常见 5-10MB 表格
2. 回归测试必须增加“后段命中”与“不存在字段拒答”双断言
3. 排查顺序固定为：原文件真值 -> PB extracted_text 是否含目标 -> 模型上下文片段选择

### 元数据
- Source: task_review
- See Also: LRN-20260319-003
- Pattern-Key: verify-runtime-artifact-not-just-worktree

---
## [LRN-20260320-002] correction

**Priority**: critical
**Status**: pending
**Area**: infra

### 内容
用户再次纠正：排错必须先看真实运行日志，不能先猜代码路径。此前先看了不完整日志源，导致定位“未提供链接”回退分支偏慢。

### 建议修复
1. 故障排查默认第一步查 Loki/运行日志（按时间窗 + 错误关键词 + trace/session）
2. 先给出日志事实，再给出推断；不要把推断当结论
3. 无日志即视为可观测性缺口，先补日志再继续修复

### 元数据
- Source: correction
- See Also: LRN-20260318-005
- Pattern-Key: log-first-debugging

---

## [LRN-20260321-007] correction

**Priority**: critical
**Status**: pending
**Area**: workflow

### 内容
后端改了必须同步改前端。已犯 5+ 次。每次后端改动后 checklist：1) 前端是否依赖此行为？2) Docker 需要 rebuild？3) nginx 需要同步？4) 新 API 前端需要调？

### 元数据
- Source: correction (用户第 5+ 次提醒)
- Pattern-Key: backend-frontend-sync-checklist

---

## [LRN-20260321-008] correction

**Priority**: high
**Status**: pending
**Area**: tools

### 内容
财务分析 regex 必须同时覆盖繁体（港股）+ 简体（A股）+ 英文三种。pdftotext 输出取决于 PDF 字体编码，不能只做一种。

### 元数据
- Source: correction
- Pattern-Key: trilingual-regex

---

## [LRN-20260321-009] correction

**Priority**: critical
**Status**: pending
**Area**: architecture

### 内容
能用现成开源组件就用现成的，不要自己造轮子。用户反复强调。GitHub 上有成熟方案的直接拿来用，自己只写胶水代码和业务定制。

例子：
- RAG → RAGFlow (不是自己写 BM25+reranker)
- SMC 指标 → joshyattridge/smart-money-concepts (不是自己写 order block 检测)
- 交易框架 → Freqtrade / CCXT (不是自己写交易所 API)
- K线图表 → TradingView Lightweight Charts (不是自己画 canvas)
- 工作流编辑 → React Flow (不是自己写拖拽)

### 建议修复
每次做新功能前，先搜 GitHub 有没有现成的。只有确认没有或不满足需求才自己写。

### 元数据
- Source: correction (用户反复强调)
- Pattern-Key: use-existing-never-reinvent

---

## [LRN-20260321-010] best_practice

**Priority**: critical
**Status**: pending
**Area**: browser-compat

### 内容
CompressionStream API 在 Safari 和 Headless Chrome 中会 hang（永远不 resolve），导致加密上传的 packFiles 函数永远不返回。这不是报错，是静默挂起，极难调试。

### 建议修复
1. 不要在面向终端用户的 Web 应用中依赖 CompressionStream，改用纯 JS 压缩库（如 pako）或直接跳过压缩
2. 任何使用 Web Stream API 的地方都要加超时兜底
3. 上线前必须在 Safari + Chrome Headless 环境下测试文件上传链路

### 元数据
- Source: task_review
- Pattern-Key: compressionstream-safari-headless-hang

---

## [LRN-20260321-011] best_practice

**Priority**: high
**Status**: pending
**Area**: streaming

### 内容
服务端在 SSE 流中遇到 `<think>` 标签时，不能直接剥离丢弃——这些是模型的推理过程内容，前端需要展示为可折叠的 thinking block。必须作为 `reasoning_content` SSE 事件转发给前端。MiniMax 和 DeepSeek-R1 都会输出 `<think>` 标签。

### 建议修复
1. SSE clean pipe 遇到 `<think>...</think>` 时转发为 `event: reasoning_content`，不要吞掉
2. 前端接收 reasoning_content 事件后渲染为可折叠 thinking block
3. 新增模型时检查其是否输出 `<think>` 标签，确保流解析器能正确处理

### 元数据
- Source: task_review
- Pattern-Key: forward-think-tags-not-strip

---

## [LRN-20260321-012] best_practice

**Priority**: high
**Status**: pending
**Area**: architecture

### 内容
模型的 thinking/reasoning 能力必须按单个模型粒度配置，不能按 provider 粒度。同一个 provider 下不同模型的 thinking 能力差异很大：比如 OpenAI 的 o3 支持 thinking 但 gpt-4o 不支持；Anthropic 的 claude-3-5-sonnet 支持但 claude-3-haiku 不支持。按 provider 粒度配置会导致不支持 thinking 的模型被错误标记为支持。

### 建议修复
1. 维护一个 per-model capability map（如 `MODEL_CAPS[modelId].thinking = true/false`）
2. 前端 UI 根据当前选中模型动态显示/隐藏 thinking mode selector
3. 新增模型时必须在 capability map 中注册其能力

### 元数据
- Source: task_review
- Pattern-Key: per-model-not-per-provider-capability

---
