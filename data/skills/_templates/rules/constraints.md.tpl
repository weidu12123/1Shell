# <!-- FILL: Skill 名 --> 约束

<!-- 规则写法原则：
  ✅ 写"AI 不能做什么"、"必须先做什么"、"遇到 X 必须 Y"
  ❌ 不要写步骤（那是 workflows/），不要写背景知识（那是 references/）
  ✅ 每条规则脱离项目上下文也能读懂（泛化规则）
  ✅ 满足 2/3 录入标准才写：可重复 + 代价高 + 代码不可见 -->

---

## 破坏性操作前必须确认

<!-- FILL: 列出本 Skill 涉及的破坏性操作，例如：
  删除 X、覆盖 Y、停止 Z 等，必须先 ask_user type=confirm danger=true。
  用户取消后用 render_result level=warn 告知并立即停止，不得继续。 -->

## <!-- FILL: 领域特定约束 1 -->

<!-- FILL: 例如：nginx 操作必须先 nginx -t，通过后才能 reload -->

## <!-- FILL: 领域特定约束 2（可选，不够 2/3 标准就删） -->

<!-- FILL: ... -->

## Task Closure（每次执行结束前必做）

操作完成后 30 秒自检，按顺序回答：
1. **Did it work?** — 用户目标是否达成？执行 verify 命令确认，不要假设
2. **Any side effects?** — 是否影响了其他服务/配置？
3. **Red Flags check** — 以下任意一项为真则停下来向用户说明：
   - 命令返回非 0 但我跳过了
   - 我不确定这个操作是否可撤销
   - 输出结果和预期不一致

自检通过后才调用 render_result 告知用户最终结果。