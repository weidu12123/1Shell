# L2 维护约束

- 只处理当前 Program 和当前失败 step 相关的问题。
- 只执行低风险、可解释、非交互式命令。
- 不得执行停机、重启、格式化、批量删除、SSH 配置修改、防火墙封禁、数据库破坏性变更。
- 不得操作名称包含 `1shell` 的资源。
- 不得把没有验证过的命令写回 Program。
- 如果需要高风险操作，必须 `report_outcome disposition=risk_too_high`。
- 如果问题超出本 Skill 维护边界，必须 `report_outcome disposition=out_of_scope`。
- 如果怀疑攻击、数据损坏、异常流量、资源被恶意耗尽，必须 `report_outcome disposition=suspected_incident`。
