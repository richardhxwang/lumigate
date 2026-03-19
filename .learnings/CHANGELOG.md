# Changelog

<!-- SCHEMA: {"ts":"ISO-8601","action":"add|promote|extract|resolve","type":"learning|error|feature","id":"entry ID","summary":"≤100字","target":"晋升目标(可选)"} -->

```jsonl
{"ts":"2026-03-16T18:30:00+08:00","action":"add","type":"learning","id":"LRN-20260316-001","summary":"生成文件空白但报告成功——需要实际验证文件内容再报完成"}
{"ts":"2026-03-16T18:30:00+08:00","action":"add","type":"learning","id":"LRN-20260316-002","summary":"被多次提醒自己检查/improve——建立强制验证流程"}
{"ts":"2026-03-18T00:50:00+08:00","action":"add","type":"learning","id":"LRN-20260318-001","summary":"PocketBase 消息长度限制要在前后端所有消息写入路径统一截断"}
{"ts":"2026-03-18T01:10:00+08:00","action":"add","type":"learning","id":"LRN-20260318-002","summary":"尽量避免硬编码，优先抽成变量或配置并保留默认值"}
{"ts":"2026-03-18T02:05:00+08:00","action":"add","type":"learning","id":"LRN-20260318-003","summary":"LumiChat 相关数据结构应作为 LC 顶级业务域管理，与 FN 和 LG 同级"}
{"ts":"2026-03-18T12:20:00+08:00","action":"add","type":"error","id":"ERR-20260318-001","summary":"单服务更新被 compose 中无关镜像拉取失败阻断"}
{"ts":"2026-03-18T12:21:00+08:00","action":"add","type":"learning","id":"LRN-20260318-004","summary":"单服务更新前先 compose config，再 build+up --no-deps，避免全量 up --build 风险"}
{"ts":"2026-03-18T13:12:00+08:00","action":"add","type":"error","id":"ERR-20260318-002","summary":"Docker 层存储空间不足导致单服务构建/重建失败"}
{"ts":"2026-03-18T13:13:00+08:00","action":"add","type":"learning","id":"LRN-20260318-005","summary":"先看日志再判断；无日志即系统设计缺陷，必须全链路可观测并有轮转"}
```
