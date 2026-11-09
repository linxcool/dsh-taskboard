# 员工绑定：把「员工卡」从预设推断改成显式绑定

- 日期：2026-11-09
- 状态：待评审（v2，已按交互稿确认结果修订）
- 范围：P3（员工卡）改造 + P4（评审卡）联动 + 任务/会话可见性
- 交互稿：[docs/mockups/employee-binding.html](../mockups/employee-binding.html)（四个场景，可点击）
- 前置阅读：[FORK.md](../../../FORK.md)

## 1. 背景

本仓库的目标是把看板改造成**以 GitHub Issue 为单位的 AI 团队工作台**（[FORK.md](../../../FORK.md) 第 5 行）。P1 导入、P2 Project 写回、P3 员工卡、P4 评审门禁已落地，但 P3 留了两个结构性缺口：

`EmployeesModal` 用正则判断谁是评审员工：

```ts
const REVIEW_PATTERN = /review|reviewer|audit|审查|评审|验收|审核/i
const isReviewer = (preset) => REVIEW_PATTERN.test(`${preset.id} ${preset.name ?? ''}`)
```

1. **角色是猜的**。叫 `code-auditor-v2` 的预设会被当成只读评审，而实际想做实现的人没有任何办法声明它不是。
2. **评审卡没有约定评审人**。`TaskDetail` 发起评审时只传 `permission: 'read-only'`，不传 `presetId`，评审卡用部署默认 preset 跑——「谁评审」是随机的。

第三个缺口在交互确认时才暴露：**任务、会话、员工三者的关系在看板上不可见**。卡片只显示持有者，看不出这张卡跑过几个会话、每个会话是谁、哪一轮还在进行。

本设计把角色与默认权限换成显式数据，并把会话关系摆到界面上。preset 仍是唯一配置来源，看板只持有一张绑定表。

## 2. 目标与非目标

**目标**

- 员工角色与默认权限由显式绑定决定，不再从名字推断。
- 建卡（GUI 与 agent 工具）从同一张表取默认值，行为一致。
- 评审卡绑定到具体的评审员工。
- 任务的执行会话可一眼看全：卡片上有会话 chip，点开是这张卡的全部会话。
- 旧正则推断结果以一次性迁移保留。

**非目标**

- 不引入 `ctx.agentTeams` / teammate 作为员工正本（理由见第 3 节）。
- 不做按项目的团队界面（数据键预留，UI 只维护全局）。
- 不改评审门禁逻辑、不允许 `reviewOf` 编辑、不给 agent 工具加创建评审卡的能力。
- 不改 DSH preset 定义，不往 preset 的 `name` / `description` 里塞角色。
- 看板列与 GitHub Project Status 对齐是**另一份 spec**（`2026-11-09-github-status-columns-design.md`）。

## 3. 能力边界：为什么复用预设、不用 teammate

| DSH 能力 | 结论 | 理由 |
| --- | --- | --- |
| `agentPresets` | **复用**：员工配置源 | 已是 P3 的唯一来源，`AgentPreset` 提供稳定 `id` |
| `agentTeams` / teammate | **不采用为正本** | 共享 cwd、不提供 worktree；roster 属于单个 Lead 会话、单进程；owner 不自动释放、不可嵌套。看板需要跨会话、跨项目的台账 |
| `subagents` / `workflow` | 可选执行通道，本次不动 | 看板执行走独立会话 |
| 权限预设 / 沙箱 | 语义重叠，长期应委托 | 本次仍用看板三档权限，只改默认值来源 |
| `auto-review` | **无关** | 逐工具调用的安全审查，不是代码评审 |

判据：**teammate 属于「会话内协作」，看板属于「跨会话台账」**。员工是台账上的角色，不是会话里的临时成员。

## 4. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 员工 = preset + 显式绑定 | preset 是唯一配置源，绑定只表达「这个看板里它是什么角色」 |
| D2 | 绑定表键 `(projectId ?? '*', presetId)`，当前 UI 只维护全局 | 将来按项目组队不需要迁移数据 |
| D3 | 角色只有 `maker` / `reviewer` | 验收永远属于人；「规划」没有消费者 |
| D4 | 权限优先级：任务显式 > 绑定 > 看板默认 | 与「看板设置只影响新任务」同构 |
| D5 | 角色与权限**直接摊在员工卡上**改 | 交互确认结论：不另开设置页表格，也不进二级详情 |
| D6 | 「未分配」只给**一个下拉**选角色，选中后才出现权限 | 未分配不参与建卡预填，必须先显式分配 |
| D7 | 评审角色没显式配权限时，建卡走**看板默认** | 交互确认结论：不引入「评审角色隐含只读」这条隐式规则 |
| D8 | 评审卡的只读是硬约束，不受绑定影响 | 只读是 P4 语义，不是默认值 |
| D9 | 建卡表单保留「实际生效 + 来源」一行 | 交互确认结论：必要信息，避免“我明明设了却没用上” |
| D10 | 会话列表挂在**卡片上的会话 chip**，不抢单击/双击 | 单击=选中+详情、双击=直达最近会话是既有习惯 |
| D11 | 会话列表**按会话聚合**，同会话多轮合并并标轮次 | 续跑复用同一会话；按执行记录列会重复 |
| D12 | 旧正则结果一次性迁移成 reviewer 绑定 | 不静默推断，也不让老用户角色凭空消失 |
| D13 | 失效绑定保留并标「不可用」 | 与外部同步「查不到标不可用」一致 |

## 5. 数据模型

绑定表存进台账 `settings`，随 JSON 导出/导入一起搬，不新增数据文件。

```ts
type EmployeeRole = 'maker' | 'reviewer'

interface EmployeeBinding {
  presetId: string              // DSH preset 的稳定 id，不是展示名
  projectId?: string            // 预留维度，缺省 = 全局
  role: EmployeeRole
  permission?: PermissionMode   // 缺省走看板默认
  enabled: boolean
  defaultReviewer?: boolean     // 评审卡默认评审人，整表最多一条为 true
}
```

`BoardSettings` 新增（`src/shared/protocol.ts` 约 323 行）：

```ts
employees?: EmployeeBinding[]
employeesMigratedAt?: string   // 一次性迁移标记
```

**校验规则**（`asBoardSettings`，约 380 行附近）：

- `employees` 必须是数组，长度 ≤ 200，否则整次设置写入失败。
- 每条：`presetId` 非空字符串（trim）；`role` ∈ `{maker, reviewer}`；`permission` 若存在必须是三种之一；`enabled` 必须是布尔。
- 按 `(projectId ?? '*', presetId)` 去重，后出现的胜出。
- 多条 `defaultReviewer: true` 保留第一条，其余置 `false`（fail-soft，与 `branchNamePrefix` 一致）。
- `employeesMigratedAt` 必须是字符串。

**会话不新增存储**：会话列表由任务已有的执行记录派生（`execution.sessionId` + 轮次），按 `sessionId` 聚合、取最近时间排序。执行记录是既有数据，本次不迁移。

**员工的“最近会话”**：取该 preset 执行过的任务里最近的一条执行记录；没有则显示「还没有执行过」。这只读派生，不写回绑定表。

## 6. 语义规则

1. **未绑定 ≠ 不存在**。preset 在目录里但表里没有 → 「未分配」，不参与建卡预填，不会被当成 maker。
2. **停用**。绑定保留但不参与预填；目录里置灰，「使用这位员工建卡」不可点。
3. **失效**。`presetId` 不在当前 catalog → 标「预设不可用」，可解除，不静默删除。
4. **绑定只给默认值**。绑定里的 `permission` 只在建卡时填初值，卡片上可改，不影响其他卡。
5. **评审卡回落**。没有启用的 reviewer 绑定时，评审卡不传 `presetId`（用部署默认），不阻塞创建。
6. **迁移只跑一次**。host 侧首次 `GET /model-catalog` 成功后执行：若 `employees` 与 `employeesMigratedAt` 都缺失，把当前命中旧正则的 preset 写成 `role: 'reviewer'`、`enabled: true` 的绑定，再写时间戳；catalog 不可用则跳过且不写标记，下次重试。
7. **评审门禁不变**。`openReviews` 判定、`review cards still open` 的 400、详情页完成置灰，一行不动。

## 7. 界面

对应交互稿场景 ①②③。

### 7.1 员工目录（`EmployeesModal.tsx`）

四态渲染：

| 状态 | 显示 | 操作 |
| --- | --- | --- |
| 已绑定·启用 | 角色 chip + 权限下拉 + 会话行 + 启用开关 | 改角色、改权限、设默认评审、停用、使用 |
| 已绑定·停用 | 置灰 +「已停用」 | 重新启用、解除绑定（「使用」禁用） |
| 未分配 | 「未分配」+ 角色下拉 | 分配为执行 / 评审 |
| 失效 | 「预设不可用」 | 解除绑定（不可删除） |

- 角色 chip 点击即在 `maker` / `reviewer` 间切换；`★` 标记默认评审员工，互斥。
- 会话行显示该员工最近一次执行会话，点击跳转；没有会话时显示「还没有执行过」。
- `dispatch` 保持现形状，只换数据来源：

```ts
controller.newFromTemplate({
  presetId: preset.id,
  permission: binding?.permission ?? defaultPermissionOf(settings),
  urgency: 'normal',
})
```

### 7.2 建卡表单（`TaskFormModal.tsx` 约 251 行）

- 选中 preset 后自动带出角色 chip 与权限初值，用户可改。
- 权限保持「跟随」时，下方显示「实际生效 + 来源」；选中具体值时显示「这张卡与绑定不一致，仅影响本卡」。
- 新增「执行方式」：新建会话（默认）/ 复用最近执行会话。

### 7.3 发起评审（`TaskDetail.tsx` 约 857 行）

```ts
controller.newFromTemplate({
  title, description, prompt,
  urgency: task.urgency,
  permission: 'read-only',              // 固定，不受绑定影响
  presetId: reviewerBinding?.presetId,  // 新增
  reviewOf: task.id,
})
```

评审卡详情显示 Reviewer 员工 chip；无绑定时不显示。

### 7.4 会话可见性（新增）

- **卡片**：显示最近一次执行会话的 `🤖 3f2a ↗` chip；点它弹出列表，而不是直接跳转。
- **列表内容**：每行 `会话 ID · preset · 状态 · 时间 · 轮次`，点击跳转；底部「在详情里看完整执行记录」。
- **详情面板**：执行记录保持现状（倒序、会话跳转、Diff、报告），列表的“完整版”。
- **员工卡**：最近执行会话（7.1 的会话行）。
- 单击卡片仍是选中 + 详情，双击仍是直达最近会话，本次不改。

### 7.5 文案

`zh.ts` / `en.ts` / `ru.ts` 三份同步。已有 `employees.roleMaker`、`employees.roleReviewer`；新增：
`employees.unassigned`、`employees.stale`、`employees.assign`、`employees.setDefaultReviewer`、`employees.disabled`、`employees.migratedHint`、`detail.review.employee`、`detail.sessions.title`、`detail.sessions.footer`、`form.execution.newSession`、`form.execution.reuseSession`。

## 8. 宿主侧规则

| 位置 | 现状 | 改造后 |
| --- | --- | --- |
| `src/host/tools.ts` 约 628 行 | `permission` 缺省 → 看板默认 | 缺省且给了 `presetId` → 绑定权限；再缺省 → 看板默认 |
| `src/host/routes.ts` 约 775 行 | 同上 | 同上 |
| `src/shared/protocol.ts` 约 450 行 | `defaultPermissionOf` | 新增 `employeeBindingFor()` 与 `permissionForCreate()`，表单与工具共用 |
| `/settings` 路由 | `asBoardSettings` | 自动接受新字段 |

解析函数放 `src/shared/protocol.ts`，客户端与宿主共用同一实现——这是“人建卡与 agent 建卡不分叉”的保证。

## 9. 迁移与回滚

- 迁移只写 `settings`，不碰任务数据；写入 `employeesMigratedAt` 后不再推算。
- 回滚：删除 `employees` 与 `employeesMigratedAt` 即回到“无绑定”状态（旧正则代码已删除，回滚到旧行为需回退提交）。
- 导入旧备份（无 `employees` 字段）会重新触发一次迁移。

## 10. 测试计划

| # | 断言 |
| --- | --- |
| T1 | 四态渲染：已绑定启用 / 停用 / 未分配 / 失效 |
| T2 | 角色切换与 ★ 互斥；停用时「使用」不可点 |
| T3 | 优先级三条：任务显式覆盖、绑定生效、都未配置回落看板默认 |
| T4 | 评审角色未配权限 → 取得看板默认（不是只读） |
| T5 | `taskboard_create` 与表单同 preset 得到相同权限 |
| T6 | 迁移只跑一次；catalog 不可用时下次重试 |
| T7 | 失效绑定保留，不被静默删除 |
| T8 | 评审卡：有 reviewer 绑定带 `presetId`，无绑定不带且不阻塞 |
| T9 | 评审卡权限恒为 `read-only`，即使绑定写了 `workspace-write` |
| T10 | 多条 `defaultReviewer` 只保留第一条 |
| T11 | 设置校验：非法 role / permission / 超 200 条被拒 |
| T12 | 会话列表按 `sessionId` 聚合；同会话 3 轮显示为 1 条并标轮次 |
| T13 | 无会话的任务不显示会话 chip；空列表不弹空白 popover |

回归：`npm test` 全量通过；未配置绑定时原有看板行为不变。

## 11. 风险

| 风险 | 缓解 |
| --- | --- |
| 迁移把不该是 reviewer 的 preset 标成 reviewer | 目录里可改可解除；迁移提示说明来源 |
| preset 改名/删除导致绑定失效聚集 | 标「预设不可用」，用户可见可处置 |
| 绑定成为第三套权限语义 | 只作为建卡初值，实际权限仍落在任务 `permission` |
| 会话聚合口径与执行记录不一致 | 聚合函数放 `shared/`，列表与详情共用 |

## 12. 验收标准

1. 代码里不再有按 preset 名字推断角色的逻辑。
2. 同一 preset、同一张卡，GUI 与 `taskboard_create` 的默认权限相同。
3. 评审角色未配权限时，建卡得到看板默认；评审卡仍是只读。
4. 有 reviewer 绑定时，评审卡跑该 preset，卡片上能看到评审人。
5. 卡片上能点开会话列表，同会话多轮合并显示。
6. 迁移在真实台账上只跑一次，重启后不再变化。

## 13. 后续（不在本 spec）

- 按项目的员工名单界面（数据键已预留）。
- 派发语义：绑定决定谁能执行哪类卡。
- 与 DSH 权限/沙箱预设置换，去掉看板自有权限字段。
- `reviewOf` 可编辑；agent 工具创建评审卡。
