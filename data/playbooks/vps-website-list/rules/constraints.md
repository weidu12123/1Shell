# 安全约束

## 只读操作
本 Playbook 仅读取 nginx/OpenResty 配置文件，不做任何修改。

## 删除操作由 Skill 处理
点击行的"删除"按钮会触发 vps-website-delete Skill，该 Skill 会在执行破坏性操作前要求用户二次确认。

## 不得操作 1shell 相关资源
禁止扫描或展示名称含 "1shell" 的站点配置。
