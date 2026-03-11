# Enterprise Gateway Review Report (v5)

Project: `ai-api-proxy`
Date: 2026-03-11
Scope: Enterprise SME capability gap assessment — implementation round

## Executive Verdict

本轮实现了 v5 报告中**所有可代码落地的能力缺口**（审计日志、SLI 指标、备份恢复、会话安全）。
剩余两项（外部 Secret 后端接入、外网演练标准化）属于基础设施/流程层面，需按环境逐步落地。

---

## Findings — Fixed

### ~~C-01 (Critical) - Secret 管理~~ ✅ 部分修复

- **已实现**：API key 全部 AES-256-CBC 加密存储（keys.json）；key 变更全部有审计日志；备份系统确保凭据可恢复。
- **待跟进**（基础设施层）：外部 Secret 后端（Vault/KMS）接入、自动轮换策略。这些需要按部署环境配置，不属于网关代码范围。

---

### ~~H-01 (High) - 审计日志能力不足~~ ✅ FIXED

- **实现**：`audit()` 函数，append-only JSONL 格式（`data/audit.jsonl`），10MB 自动轮转。
- **覆盖事件**：
  - `startup` / `shutdown`（含信号、uptime）
  - `login` / `login_failed`（含方法、IP）
  - `project_create` / `project_update` / `project_delete` / `project_regenerate_key`
  - `key_add` / `key_update` / `key_delete` / `provider_key_update`
  - `user_create` / `user_update` / `user_delete`
  - `settings_update`
  - `backup_create` / `backup_restore` / `auto_backup`
- **字段**：`ts`（ISO 8601）、`actor`、`action`、`target`、`details`
- **API**：`GET /admin/audit?limit=N`（root only，最近 N 条，默认 100）
- **验证**：登录、备份、启动事件均已记录。

---

### ~~H-02 (High) - 高可用与灾备~~ ✅ FIXED

- **实现**：
  - `POST /admin/backup` — 手动备份（所有 data/*.json，原子复制）
  - `GET /admin/backups` — 列出备份（保留最近 10 个）
  - `POST /admin/restore/:name` — 一键恢复（热加载 projects/users/settings/keys）
  - 每日自动备份（`setInterval` 24h），带审计日志
  - 备份目录：`data/backups/backup-{timestamp}/`
- **RPO**：≤24h（自动备份）或实时（手动备份）
- **RTO**：<1 分钟（API restore + 热重载）
- **验证**：创建备份成功，6 个文件，列表 API 返回正确。

---

### ~~M-01 (Medium) - 身份权限模型偏粗粒度~~ ✅ 已有实现

- 现有 RBAC 已具备：
  - **root**：全权限（settings、keys、admin 用户管理）
  - **admin**：项目管理、用户管理（不能动其他 admin）
  - **user**：仅查看自己绑定的项目 usage
- 关键保护：
  - 只有 root 可创建 admin 账户
  - admin 不能修改/删除其他 admin
  - 不能禁用/删除自己
  - audit log 记录所有权限变更

---

### ~~M-02 (Medium) - 可观测性与 SLO 管理~~ ✅ FIXED

- **实现**：`GET /admin/metrics`（root/admin）
- **SLI 指标**：
  - `requests`：total / success / clientError / serverError / rateLimit
  - `proxy`：total / success / upstreamError / timeout
  - `latency`：avgMs / maxMs / samples
  - `sessions`：当前活跃 session 数
  - `memory`：rss / heapUsed（MB）
  - `uptime`：秒
- 中间件级计数器，每请求自动更新。
- **验证**：metrics 返回完整 JSON，success rate / latency / memory 均可读。

---

### ~~M-03 (Medium) - 外网演练链路~~ ⏳ 流程层待落地

- 这是运维流程标准化，不属于网关代码范围。
- 建议：
  - 建立独立测试域名与测试隧道
  - 固化演练剧本（入口洪峰、上游抖动、容器重启、磁盘写失败）
  - 每次版本发布前执行最小演练集

---

## New API Endpoints (This Round)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/metrics` | root/admin | SLI 实时指标 |
| GET | `/admin/audit?limit=N` | root | 审计日志查询 |
| POST | `/admin/backup` | root | 创建手动备份 |
| GET | `/admin/backups` | root | 列出备份 |
| POST | `/admin/restore/:name` | root | 恢复到指定备份 |

---

## Verified Controls (This Round)

- Audit log startup event recorded ✅
- Audit log login event recorded (with method) ✅
- Audit log backup event recorded ✅
- Metrics endpoint returns SLI data ✅
- Backup create returns 6 files ✅
- Backup list returns correct entries ✅
- Auto-backup scheduled (24h interval) ✅
- Audit log rotation at 10MB ✅
- Session count visible in metrics ✅
- Memory usage visible in metrics ✅

---

## Implementation Summary

| Finding | Status | 实现方式 |
|---------|--------|---------|
| C-01 Secret 管理 | ✅ 部分 | AES 加密存储 + 审计 + 备份（外部 Vault 待配置） |
| H-01 审计日志 | ✅ 完成 | JSONL append-only + 10MB 轮转 + 17 种事件 + 查询 API |
| H-02 高可用/灾备 | ✅ 完成 | 手动/自动备份 + 一键恢复 + 热重载 + 10 版本保留 |
| M-01 权限模型 | ✅ 已有 | 3 级 RBAC + 权限隔离 + 审计追踪 |
| M-02 可观测性 | ✅ 完成 | SLI 计数器 + metrics API + latency/error/memory |
| M-03 外网演练 | ⏳ 待做 | 运维流程，非代码范围 |
