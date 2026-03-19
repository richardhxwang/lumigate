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
