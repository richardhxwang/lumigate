# LumiGate 代码审查与外网实测报告 v9

日期: 2026-03-13
目标环境: `https://lumigate.autorums.com`
测试方式: 代码静态审查 + 外网黑盒/白盒混合验证 + 低成本真实 LLM 请求 + 受控并发压力测试
成本约束: 实际 LLM 调用成本远低于 `0.3 RMB`

## 一、结论摘要

本轮以外网 `autorums.com` 接口为最高优先级进行了复核。结论如下:

- 发现 `1` 个 `Critical` 级漏洞: `HMAC` 项目可以通过 `/v1/token` 被原始 project key 绕过，直接换取短期 token。
- 发现 `1` 个 `High` 级设计缺陷: 项目重命名没有做唯一性与级联一致性处理，可能造成权限、密钥路由、短期 token 绑定异常。
- 发现 `1` 个 `Medium` 级外网可用性问题: 文档中的普通 `curl` 调用流程在公网会被 Cloudflare `1010` 阻断，必须伪装成浏览器式请求头才可达应用层。
- 发现 `1` 个 `Low` 级部署脆弱点: 应用代码直接信任 `X-Forwarded-For`，当前在 Cloudflare 下未被我利用成功，但一旦直连或代理链变化，IP 限制与限流逻辑存在被伪造的风险。

同时，本轮确认了若干正向结果:

- 公网 `/health`、`/providers`、`/models/openai` 可以正常返回。
- 路径穿越请求被阻断。
- 非法 JSON 请求被 `400` 拒绝。
- 真实 LLM 请求可以成功转发，且本次成本极低。

## 二、按严重度排序的问题

### 1. Critical: HMAC 项目可被 `/v1/token` 绕过

相关代码:

- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L2725)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L2741)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L2799)

问题描述:

- 主代理 `/v1/:provider` 对 `authMode === "hmac"` 的项目会拒绝原始 `project key` 直连。
- 但 `/v1/token` 在解析到有效 `project key` 后，直接签发短期 token，没有再次校验该项目是否必须使用 HMAC。
- 这导致攻击者只要拿到 HMAC 项目的原始 key，就能绕过签名要求，直接换取 `et_` token，然后使用该 token 正常访问代理接口。

外网复现结果:

- 2026-03-13 在 `https://lumigate.autorums.com` 上新建了一个临时 `HMAC` 项目。
- 使用原始 `X-Project-Key` 直接调用 `POST /v1/token`。
- 服务返回 `200`，并签发有效 `et_...` token。

风险:

- HMAC 的安全边界被破坏。
- 文档中宣称 “key never sent” 的前提被实际代码打破。
- 一旦 HMAC 项目 key 泄露，攻击者无需伪造签名即可长期换取短期 token。

修复建议:

- 在 `/v1/token` 中，如果解析出的项目 `authMode === "hmac"`，则必须拒绝原始 `project key` 路径。
- `/v1/token` 与 `/v1/:provider` 需要共用同一套鉴权策略，避免一处严格、一处宽松。

### 2. High: 项目重命名缺少唯一性校验和一致性迁移

相关代码:

- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L1408)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L1412)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L679)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L2028)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L2751)

问题描述:

- `PUT /admin/projects/:name` 中修改 `newName` 时，没有检查新名字是否已存在。
- 也没有同步更新以下依赖项目名的状态:
  - 用户绑定的 `projects`
  - 多 key 配置中的 `project`
  - 已签发短期 token 中的 `projectName`
  - 其它基于项目名索引的内存桶与统计数据

风险:

- 可以重命名成已存在项目名，造成冲突。
- 项目级 provider key 可能选错。
- 用户可见项目与实际项目对象脱钩。
- 已签发 token 和后续路由、审计、限流之间出现不一致。

修复建议:

- 重命名前先做重名校验。
- 把项目名视为外部可变展示字段，内部使用稳定 ID 关联。
- 若继续用项目名做主键，则必须实现 rename cascade。

### 3. Medium: 公网 Cloudflare 规则与 README 的使用方式不一致

相关文档:

- [README.md](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/README.md#L191)
- [README.md](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/README.md#L195)

问题描述:

- README 展示的是普通 `curl` 的 `/v1/token` 和 `/v1/openai/...` 调用方式。
- 但在公网 `lumigate.autorums.com` 上，直接使用普通脚本请求时，多次收到 Cloudflare `403 error code: 1010`。
- 在补充浏览器式 `User-Agent`、`Origin`、`Referer` 后，才成功到达应用层。

风险:

- 正常的 server-to-server 客户端可能被边缘层误伤。
- 用户会以为接口不可用，但实际上是 edge 规则阻断。
- 运维侧看到的是 Cloudflare 错误，不是应用日志，排障成本高。

修复建议:

- 明确 Cloudflare 的 WAF/Bot 策略是否有意限制脚本流量。
- 若这是公开 API，不应要求客户端伪装浏览器请求头。
- README 需要和真实公网行为一致，否则文档不可执行。

### 4. Low: 代码层直接信任 `X-Forwarded-For`

相关代码:

- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L175)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L186)
- [server.js](/Volumes/SSD%20Acer%20M7000/MacMini-Data/Projects/Project/General/ai-api-proxy/server.js#L322)

问题描述:

- `normalizeIP(req)` 优先使用请求头中的 `x-forwarded-for`。
- 该值随后被用于:
  - 管理/API 速率限制
  - 项目内 IP allowlist
  - 项目每 IP RPM 限制

本次外网结果:

- 我尝试在 Cloudflare 前置环境下伪造 `X-Forwarded-For` 绕过项目 IP allowlist，没有成功。
- 说明当前 edge 大概率覆盖或清洗了该头。

仍然存在的风险:

- 一旦部署方式改变，例如应用端口直出、代理链调整、反向代理未清洗头部，这段代码就会立刻变成真实漏洞。

修复建议:

- 仅在受信代理链配置完成后使用 `req.ip`。
- 不应手工优先读取用户可控的 `X-Forwarded-For`。

## 三、外网实测记录

### 1. 公共只读端点

目标:

- `GET /health`
- `GET /providers`
- `GET /models/openai`

结果:

- 三者均可从公网访问并返回 `200`。
- 返回了预期的安全头，例如 `x-content-type-options`、`x-frame-options`、`strict-transport-security`、`content-security-policy`。
- `/providers` 暴露了当前可用 provider:
  - `openai`
  - `anthropic`
  - `gemini`
  - `deepseek`

观察:

- 当前实例会公开暴露部署模式和启用模块信息。
- 这不一定是漏洞，但确实增加了系统指纹。

### 2. 真实 LLM 请求

测试路径:

- 先创建临时 `key` 模式项目
- 用项目 key 调用 `POST /v1/token`
- 用返回的 `et_...` token 调用 `POST /v1/openai/v1/chat/completions`

请求参数:

- model: `gpt-4.1-nano`
- prompt: `Reply with exactly OK`
- `max_completion_tokens: 1`

结果:

- 返回 `200`
- 模型回复: `OK`
- usage:
  - `prompt_tokens = 11`
  - `completion_tokens = 1`
  - `total_tokens = 12`

成本估算:

- 按代码内价格表:
  - 输入单价 `$0.10 / 1M`
  - 输出单价 `$0.40 / 1M`
- 本次估算约 `0.000011 RMB`
- 明显低于你要求的 `0.3 RMB`

### 3. 异常与攻击面测试

已验证:

- 编码路径穿越:
  - 请求 `/v1/openai/v1/%2e%2e/%2e%2e/etc/passwd`
  - 返回 `403`
  - 错误为 `Requested API path is not allowed for this provider`
- 非法 JSON:
  - 返回 `400`
  - 未出现堆栈或内部错误泄露

### 4. 外网受控压力测试

测试方法:

- 对 `/health` 发送 `20` 个并发请求
- 对认证后的 `/v1/openai/v1/models` 发送 `20` 个并发请求

结果:

- `/health`
  - `200`: `16`
  - 失败: `4`
  - `p50`: `210.5 ms`
  - `p95`: `261.5 ms`
- `/v1/openai/v1/models`
  - `200`: `11`
  - 失败: `9`
  - `p50`: `1029.4 ms`
  - `p95`: `2161.8 ms`

结论:

- 这更像公网 edge/tunnel 层在小规模并发下就出现不稳定，而不是单纯应用逻辑错误。
- 单次请求可成功，但并发稳定性一般。

## 四、未发现的问题

本轮没有复现成功的点:

- 通过伪造 `X-Forwarded-For` 绕过公网项目 IP allowlist
- 通过公网路径穿越拿到非预期文件
- 通过坏 JSON 触发 `500`

这些点当前在 `lumigate.autorums.com` 前的 Cloudflare 与应用层组合防护下表现正常。

## 五、建议修复顺序

建议按以下顺序处理:

1. 立即修复 `/v1/token` 对 HMAC 项目的绕过问题。
2. 修复项目 rename 的唯一性检查与级联一致性。
3. 复核 Cloudflare WAF/Bot 规则，确保 README 中的 API 调用方式真实可用。
4. 重构 IP 获取逻辑，去掉对用户侧 `X-Forwarded-For` 的直接信任。
5. 补一套自动化回归测试，至少覆盖:
   - HMAC 项目不能用原始 key 换 token
   - rename 后 users/keys/tokens 行为一致
   - 公网/代理链下 IP 识别行为稳定

## 六、测试后清理

本轮在公网创建的临时项目已删除:

- `review-live-hmac-1773391043`
- `review-live-ip-1773391043`
- `review-live-llm-1773391043`

未保留额外线上垃圾数据。
