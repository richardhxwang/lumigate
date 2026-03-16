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
