# L1 失败维护流程

1. 先看失败 step 的 `run`、`verify`、stdout/stderr 和作者提示。
2. 判断问题是否属于低风险维护：命令不兼容、依赖缺失、输出格式变化、路径错误、服务短暂未就绪。
3. 最多执行必要的诊断命令，避免无目的探索。
4. 如果找到修正命令，先用 `execute_command` 验证。
5. 验证通过后可用 `write_program_step` 写回。
6. 调用 `report_outcome`：
   - 已修复：`resolved`
   - 尝试后仍失败但不构成危机：`unresolved`
   - 越界或高风险：按 escalation 流程选择对应 disposition。
