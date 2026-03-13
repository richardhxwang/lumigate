# LumiGate 防御链路全景报告

日期：2026-03-13
版本：v3（含 v9 review 修复）
范围：代码静态分析 + 外网黑盒验证
目标：`https://lumigate.autorums.com`（本地：`http://localhost:9471`）

---

## 一、防御层级总览

| 层级 | 位置 | 核心机制 | 拦截/限制什么 |
|------|------|---------|-------------|
| **L0** Cloudflare Edge | 网关外层 | DDoS / WAF / Bot 拦截 / TLS | 大规模攻击、扫描器、非 HTTPS 流量 |
| **L1** Nginx | 反向代理层 | Body 限制、安全 Header | 超大请求、点击劫持、MIME 嗅探 |
| **L2** Express 全局 | 应用入口 | 全局 RPM、登录 brute-force 防护 | IP 级暴力刷量、慢速扫描 |
| **L3** 项目鉴权 | 路由入口 | Key / HMAC / Token 三模式 | 未授权访问、签名伪造、重放攻击 |
| **L4** 项目级防护 | 业务逻辑 | 9 道独立检查链 | 滥用、超额消费、模型越权、异常流量 |
| **L5** Provider Key | 上游管理 | 多 key 轮换 + 冷却 + 自动下线 | 上游 key 滥用、失效扩散 |

---

## 二、逐层详解

### L0：Cloudflare Edge（代码外层）

不在 `server.js` 管辖范围内，由 Cloudflare 配置控制。

- **DDoS 防护**：L3/L4/L7 全层防护，自动吸收流量洪峰
- **WAF**：拦截常见注入、扫描器特征（OWASP Core Rule Set）
- **Bot 拦截**：默认规则 1010 会阻断非浏览器式 UA + 无 Origin/Referer 的请求（外网测试需注意）
- **TLS 终止**：所有流量强制 HTTPS，HTTP 自动重定向
- **CF-Connecting-IP 注入**：Cloudflare 在每个请求注入真实客户端 IP，客户端无法伪造此 Header。server.js L175 的 `normalizeIP()` 优先读取此字段，不再信任客户端可控的 `X-Forwarded-For`

```
客户端 → Cloudflare（注入 CF-Connecting-IP）→ Nginx → Express
```

---

### L1：Nginx 反向代理

- **请求体限制**：`client_max_body_size 10m`（10MB），超过直接 413，不到达 Express
- **安全 Header**（响应注入）：
  - `X-Frame-Options: SAMEORIGIN`（防点击劫持）
  - `X-Content-Type-Options: nosniff`（防 MIME 嗅探）
  - `X-XSS-Protection: 1; mode=block`
  - `Strict-Transport-Security`（HSTS）
  - `Content-Security-Policy`
- **x-powered-by 移除**：Express 默认指纹被禁用，不暴露框架版本
- **上游健康回退**：`proxy_next_upstream error timeout http_502 http_503`

---

### L2：Express 全局中间件

**`apiLimiter`**（`server.js:1050`）：
```
全局限速：100 RPM / IP，窗口 1 分钟
超限 → 429 Too Many Requests
适用于所有 /v1/* 端点
```

**`loginLimiter`**（`server.js:1063`）：
```
Admin 登录限速：12 次 / 15 分钟 / IP
超限 → 429（防止 admin secret brute-force）
```

**Body 解析保护**：
```
超过 10MB → 413 Payload Too Large（Express + Nginx 双重限制）
非法 JSON → 400 Bad Request（不传递到路由）
```

**X-Request-ID 追踪**：每个请求注入 UUID v4 trace ID（或 echo 客户端传入的值），全链路可追溯。

---

### L3：项目鉴权（三种 authMode）

所有 `/v1/:provider` 和 `/v1/token` 请求必须通过此层。

#### authMode: `key`（直接 Project Key）

```
请求头：X-Project-Key: pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

验证逻辑（server.js:2799）：
  proj = projects.find(p => p.enabled && safeEqual(p.key, projectKey))
  safeEqual() — 固定时间比较，防止 timing attack
```

**注意**：HMAC 项目（`authMode: hmac`）即使拿到了 `pk_xxx`，在 `/v1/token` 和 `/v1/:provider` 都会被 403 拒绝（`server.js:2774`，`server.js:2809`）。

#### authMode: `hmac`（签名，Key 不传输）

```
请求头：
  X-Project-Id: project-name
  X-Signature: HMAC-SHA256(key, timestamp + nonce + body)
  X-Timestamp: 1710000000（Unix 秒）
  X-Nonce: <UUID v4>

验证逻辑（server.js:357）：
  ① |now - timestamp| ≤ 300s（HMAC_WINDOW_SEC，防过期 replay）
  ② nonce 不在 usedNonces Map 中（防重放，5 分钟窗口内去重）
  ③ HMAC-SHA256(proj.key, ts+nonce+body) === X-Signature
```

**关键**：原始 `pk_xxx` 永不出现在请求中。即使中间人截获所有流量，也无法还原 key。即使拦截到一次合法请求，nonce 已被消耗，重放会立即返回 401。

#### authMode: `token`（Ephemeral Token）

```
请求头：Authorization: Bearer et_<64 hex chars>

验证逻辑（server.js:2774）：
  tokenInfo = ephemeralTokens.get(token)
  ① token 存在于内存 Map
  ② Date.now() <= tokenInfo.expiresAt（默认 1h TTL，可配 15min~24h）
  ③ tokenInfo.project.enabled === true
```

Token 由 `POST /v1/token` 签发：
- key 模式项目：直接 key 换 token
- hmac 模式项目：必须 HMAC 签名换 token（原始 key 仍不传输）
- 最多 10,000 个活跃 token / 项目（`MAX_EPHEMERAL_PER_PROJECT = 10000`，`server.js:383`）

---

### L4：项目级防护（9 道检查，顺序执行）

鉴权通过后，每个请求依次经过以下检查，任意一项失败立即返回对应错误码：

| # | 检查项 | 配置字段 | 失败响应 | 代码位置 |
|---|--------|---------|---------|---------|
| 1 | 项目启用状态 | `enabled` | 401 / 403 | server.js:2781 |
| 2 | IP 白名单 | `allowedIPs`（CIDR 支持，最多 50 条） | 403 | server.js:325 |
| 3 | 项目总 RPM | `maxRpm`（上限 10,000） | 429 | server.js:204 |
| 4 | 单 IP RPM | `maxRpmPerIp`（上限 1,000） | 429 | server.js:192 |
| 5 | 单 Token RPM | `maxRpmPerToken` | 429 | server.js:218 |
| 6 | 单分钟成本上限 | `maxCostPerMin`（USD） | 429 | server.js:234 |
| 7 | 预算上限 | `maxBudgetUsd` + `budgetPeriod` | 429 + Webhook alert | server.js:3088 |
| 8 | Model 白名单 | `allowedModels`（字符串数组） | 403 | server.js:3080 |
| 9 | 异常流量检测 | `anomalyAutoSuspend` | 项目自动 suspend + 403 + Webhook | server.js:311 |

**异常检测算法**（L4 第 9 项，`server.js:294`）：
```
维护每个项目的分钟级请求计数（projectMinuteHistory）
触发条件：当前分钟请求数 > max(50, 最近 10 分钟均值 × 5)
触发后：proj.enabled = false，写入 suspendReason，发送 Webhook alert
恢复：管理员手动 re-enable，历史计数清零（server.js:1548）
```

---

### L5：Provider Key 管理（multikey）

**`selectApiKey()`**（`server.js:679`）：
```
优先级：项目专属 key → 全局 key
过滤条件：k.enabled === true 且不在冷却期
```

**冷却机制**（`server.js:250`）：
```
上游返回 429 → key 冷却 60 秒（KEY_COOLDOWN_429_MS）
上游返回 401 → key 冷却 10 分钟（KEY_COOLDOWN_401_MS）
连续 3 次 401 → key.enabled = false（自动下线）+ Webhook alert
```

**Failover**：当前 key 冷却时自动切换到下一个可用 key，对用户透明。所有 key 均在冷却时返回 503。

---

### L6：信息暴露控制（v9 review 修复）

**修复前**：`/health` 和 `/providers` 公开返回系统指纹（运行模式、模块列表、provider key 数量）。

**修复后**（`server.js:1183`）：

| 端点 | 公开（无 auth） | 管理员（有 auth） |
|------|--------------|-----------------|
| `GET /health` | `{ status, uptime }` | + `mode`, `modules`, `providers` |
| `GET /providers` | `{ name, baseUrl, available }` | + `keyCount`, `enabledCount` |

判断逻辑：`isAdminRequest(req)` — 检查 cookie `admin_token` 或 `x-admin-token` Header，与 `adminAuth` 中间件逻辑一致。

---

## 三、攻击场景模拟与防御结果

| 攻击场景 | 攻击者能做什么 | LumiGate 限制 | 最坏结果 |
|---------|-------------|------------|---------|
| **pk_xxx 泄漏** | 直接调用 AI 接口 | RPM + Budget + Model 白名单 + Anomaly | 日消耗 ≤ Budget 上限，触发 suspend 后归零 |
| **HMAC key 泄漏** | 无法直接调接口，须伪造 HMAC 签名 | 签名验证 + nonce 去重 + 时间窗 | 若能签名：等同 pk_xxx 泄漏场景，受同等限制 |
| **et_xxx Token 泄漏** | 在 TTL 内调接口 | per-token RPM + TTL 过期 + 不能换新 token | 最多 15min（可配）× per-token RPM 次数 |
| **暴力刷量** | 高频发包耗尽预算或资源 | Anomaly 5x 均值自动 suspend + RPM | 项目被自动 suspend，恢复需人工干预 |
| **预算耗尽攻击** | 消耗 Budget 至上限 | `maxBudgetUsd` 精确计算 token 成本 | 预算耗尽后所有请求 429，次日 / 次月自动 reset |
| **路径穿越 / SSRF** | `/v1/openai/v1/../../etc/passwd` | 路径白名单 allowlist 验证 | 403，不到达上游 |
| **信息探测** | `GET /health`、`GET /providers` | 公开响应仅 `status + uptime`，无系统指纹 | 知道服务在线，不知道模式/模块/key 数量 |
| **HMAC Replay** | 截获合法请求后重放 | nonce 已在 `usedNonces` Map 中 | 401 Duplicate nonce (replay detected) |
| **Admin Brute-force** | 暴力猜 ADMIN_SECRET | loginLimiter：12 次 / 15 分钟 / IP | 12 次后 429，平均每小时 48 次，极难爆破 |
| **上游 API Key 泄漏** | — | key 由 LumiGate 统一管理，用户不接触 | 攻击面在 LumiGate 侧，客户端无感知 |
| **横向攻击（跨项目）** | 用 A 项目 key 访问 B 项目资源 | key 与项目绑定，无跨项目路由 | 401，A 的 key 对 B 完全无效 |

---

## 四、已修复的安全问题（本次 review 修复清单）

| 严重度 | 问题 | 修复内容 | 代码位置 |
|--------|------|---------|---------|
| **Critical** | HMAC 项目可用原始 key 换 token（绕过签名要求） | `/v1/token` 对 `authMode=hmac` 的项目拒绝直接 key | server.js:2774 |
| **High** | 项目 rename 无唯一性校验 + 无级联更新 | rename 前查重；级联更新 users / ephemeralTokens / keys / rate buckets / anomaly history | server.js:1420 |
| **Low** | `normalizeIP` 直接信任客户端 `X-Forwarded-For` | 改为优先读 `CF-Connecting-IP`，回退 `req.ip` | server.js:175 |
| **Medium** | `/health` 和 `/providers` 公开暴露系统指纹 | 公开端点最小化响应；敏感字段仅 admin auth 后可见 | server.js:1183 |

---

## 五、推荐配置（按使用场景）

### 场景 A：移动端 App（FurNote / Whenever 类）

```json
{
  "authMode": "hmac",
  "tokenTtlMinutes": 60,
  "maxRpm": 120,
  "maxRpmPerIp": 20,
  "maxRpmPerToken": 10,
  "maxCostPerMin": 0.05,
  "maxBudgetUsd": 5.0,
  "budgetPeriod": "daily",
  "allowedModels": ["gpt-4.1-nano", "claude-haiku-4-5", "gemini-3.1-flash-lite-preview"],
  "anomalyAutoSuspend": true
}
```

说明：
- HMAC 模式：原始 key 永不出现在网络请求中
- 60 分钟 TTL：token 泄漏最大有效期 1h，可调短至 15min
- per-token RPM 10：单个 token 泄漏后每分钟最多 10 次
- 日预算 $5：最坏情况每天损失 $5，触发 429 后自动停止
- Model 白名单：只能用指定低价模型，无法调用 GPT-4o / Claude Opus 等

### 场景 B：第三方测试方

```json
{
  "authMode": "key",
  "maxRpm": 20,
  "maxRpmPerIp": 5,
  "maxCostPerMin": 0.01,
  "maxBudgetUsd": 1.0,
  "budgetPeriod": "daily",
  "allowedModels": ["gpt-4.1-nano"],
  "anomalyAutoSuspend": true
}
```

给测试方的内容：见 **六、第三方测试套件** 章节。

### 场景 C：服务端对服务端（后端直连）

```json
{
  "authMode": "key",
  "maxRpm": 600,
  "allowedIPs": ["1.2.3.4/32"],
  "allowedModels": ["gpt-4.1-mini", "claude-haiku-4-5"],
  "anomalyAutoSuspend": false
}
```

说明：
- IP 白名单锁定后端服务器 IP，key 即使泄漏也无法从其他 IP 使用
- anomalyAutoSuspend 关闭：服务端批量任务不会被误判 suspend

---

## 六、尚存的风险与建议

| 优先级 | 风险 | 说明 | 建议 |
|--------|------|------|------|
| Medium | Cloudflare Bot 规则误伤合法 S2S 客户端 | 普通 curl / SDK 请求在公网被 CF 1010 拦截，需浏览器式 Header | 在 CF WAF 中为已知 IP/Token 添加 bypass 规则；或文档说明 S2S 需添加 Accept/User-Agent |
| Low | 内存 rate bucket 重启后清零 | 攻击者可利用重启时机短暂绕过限速 | 接受此风险（重启时间窗口极短）；或持久化 bucket 到 Redis |
| Low | `usedNonces` Set 在高 HMAC 压力下增长 | 5 分钟窗口内大量不同 nonce 的 replay 尝试会累积内存 | 当前每 5 分钟自动清理（server.js:354），内存影响可控；可加单项目 nonce 上限 |
| Info | `/models/:provider` 公开返回全量模型价格表 | 攻击者可了解支持的模型和定价 | 有意为之（用户选模型需要）；可考虑要求 auth |
| Info | 审计日志（audit.jsonl）无加密 | 本地文件存储，无加密 | 磁盘加密或日志外传到安全存储 |
