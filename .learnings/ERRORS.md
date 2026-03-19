## [ERR-20260318-001] docker compose up --build blocked by unrelated image pull

**Priority**: high
**Status**: pending
**Area**: infra

### 摘要
执行 `docker compose up -d --build lumigate` 时，被 `pocketbase/pocketbase` 镜像拉取失败阻断，导致目标服务没有完成更新。

### 错误信息
```
Image pocketbase/pocketbase:latest Pulling
Image pocketbase/pocketbase:latest Error pull access denied for pocketbase/pocketbase, repository does not exist or may require 'docker login'
Error response from daemon: pull access denied for pocketbase/pocketbase, repository does not exist or may require 'docker login'
```

### 上下文
- 执行命令：`docker compose up -d --build lumigate`
- 目标：仅更新 `lumigate` 服务代码
- 实际：compose 解析/拉取了无关服务镜像并失败

### 建议修复
1. 更新 compose 配置中的失效镜像（`pocketbase/pocketbase`）
2. 仅更新单服务时优先使用：
   - `docker compose config` 先校验
   - `docker compose build <service>`
   - `docker compose up -d --no-deps <service>`
3. 避免在未校验 compose 的情况下使用全量 `up --build`

### 元数据
- Reproducible: yes
- See Also: LRN-20260318-004

---

## [ERR-20260318-002] docker no space left on device blocks rebuild/recreate

**Priority**: critical
**Status**: pending
**Area**: infra

### 摘要
执行单服务构建/重建时，Docker 层存储空间耗尽，导致镜像无法解压，更新流程中断。

### 错误信息
```
failed to extract layer ... /usr/bin/node: no space left on device
```

### 上下文
- 命令：`docker compose build lumigate` / `docker compose up -d --no-deps --force-recreate lumigate`
- 影响：新配置（包括日志策略）无法通过重建完整生效

### 建议修复
1. 变更发布前先执行磁盘健康检查（如 `docker system df`）
2. 空间不足时先清理无用镜像/构建缓存后再重建
3. 将“磁盘容量检查”纳入标准发布前置步骤

### 元数据
- Reproducible: yes
- See Also: LRN-20260318-005

---
