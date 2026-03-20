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
{"ts":"2026-03-19T13:13:22+08:00","action":"add","type":"learning","id":"LRN-20260319-001","summary":"需求切换时先收敛边界再动代码，避免在未完成重构中插入新任务导致中断"}
{"ts":"2026-03-19T13:18:00+08:00","action":"add","type":"learning","id":"LRN-20260319-002","summary":"默认持续推进；只有关键分叉才提问，并附推荐选项"}
{"ts":"2026-03-19T14:02:00+08:00","action":"add","type":"learning","id":"LRN-20260319-003","summary":"上线验证必须同时核对工作区、容器内文件和运行日志，避免把镜像构建问题误判为缓存问题"}
{"ts":"2026-03-19T15:44:00+08:00","action":"add","type":"learning","id":"LRN-20260319-004","summary":"大文件需验证后段是否被清洗层截断；上传成功不代表模型拿到了完整可用上下文"}
{"ts":"2026-03-20T03:21:00+08:00","action":"add","type":"learning","id":"LRN-20260320-001","summary":"镜像更新后仅 restart 不会加载新代码；必须 force-recreate 并在容器内校验关键标记"}
```
{"ts":"2026-03-20T20:20:00+08:00","action":"add","type":"learning","id":"LRN-20260320-002","summary":"排错先查Loki/运行日志，再给结论；禁止先猜代码路径"}
