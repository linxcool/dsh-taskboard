# 二次开发说明（GitHub Issue 工作台）

本仓库是 [`cloader/dsh-taskboard`](https://github.com/cloader/dsh-taskboard) 的二次开发分支。

目标：把看板逐步改造成**以 GitHub Issue 为单位的 AI 团队工作台** —— Issue 导入为任务卡、Project Status 双向同步、员工（Agent 预设）角色卡、评审卡完成门禁。

- 上游版本：`0.9.11`（分支 `dev`）
- 本分支：`feat/github-provider`，基于上游 `49e9a51`
- 兼容性：已在 DSH `0.2.1-rc.3` 的 host 构建上做单测/构建验证；真实环境联调见下文
- 上游合并策略：新增能力以独立文件/可选字段为主，便于后续 rebase；未改变原有看板行为

---

## 新增能力

### P1 · GitHub Issue 只读导入

- 新增外部任务源 `github`（`src/host/github.ts`），走现有「外部任务同步」界面：
  - 认证：Personal Access Token（`Issues: Read`，只读导入无需写权限）
  - 范围 ID：`owner/repo`
  - 分页拉取 issues，跳过 PR；label → 紧急度（`urgentLabels` / `relaxedLabels`）；assignee → 处理人；`open/closed` 状态与链接保留
  - 已关闭 issue 默认只在看板已跟踪时更新，避免历史 issue 刷屏
  - `since` 可限定最早更新日期
- 不写回 GitHub；导入为单向。

### P2 · Project Status 回写（opt-in）

- 新增 `src/host/github-writeback.ts`，监听所有已提交的状态变更（GUI 移卡、agent 工具、执行结算）。
- 连接设置（GitHub 外部源）：

  | 字段 | 说明 |
  | --- | --- |
  | `writebackMode` | `off`（默认）/ `status` / `comment` / `both` |
  | `projectOwner` | Project 所有者（用户或组织） |
  | `projectNumber` | Project 编号（如 `1`） |
  | `statusField` | 单选项字段名（默认 `Status`） |
  | `statusMap` | `列=选项` 逗号分隔，默认 `backlog=待澄清,todo=就绪,in_progress=执行中,in_review=待你验收,done=完成,canceled=取消` |

- 行为：GraphQL 读取 Issue 所在 Project item → 与目标 Status 比对（相同则跳过）→ `updateProjectV2ItemFieldValue`；可选在 Issue 发表评论。
- 失败不会阻塞移卡，只在任务卡上追加一条 host 评论说明原因。
- 需要 `Issues: Read and write` + `Projects: Read and write` 的 token（或 classic `repo` + `project`）。

### P3 · 员工卡（Agent 预设目录）

- 看板工具栏「👥 员工」打开员工目录：读取 DSH 的 Agent preset，把每张预设显示为员工卡。
- 选择员工 → 用该 preset 打开建卡表单；名称/id 含 `review/reviewer/审查/评审/验收/审核` 的预设默认只读权限，其余默认可写，表单内仍可修改。
- 不复制 preset 配置、不新增员工数据模型；preset 仍是唯一配置来源。

### P4 · 评审卡完成门禁

- 任务详情「🧪 发起评审」：创建只读评审卡，自动带上 `reviewOf`、Reviewer prompt 与只读权限。
- 任务卡新增可选字段 `reviewOf`（评审卡指向被评审任务）。
- 门禁：存在未关闭（非 done/canceled/archived）评审卡时，被评审任务**不能**移到 done；详情页完成按钮置灰，路由侧硬拒。
- 代理（agent）本来就不能 done；门禁对用户与 API 同时生效。

### P5 · 看板列对齐 GitHub Status

- 主列从 5 个改为 6 个（待澄清 / 就绪 / 执行中 / 待你验收 / 完成 / 取消），与 Project 的 Status 选项一一对应；取消从「其他任务」页移入主列并默认折叠。
- 列头文案优先取连接的 `statusMap` 选项名（不同 Project 的选项名不同），未配置连接时用内置文案。
- 内部状态值、`canTransition` 与 P2 的写回映射全部不变，**没有数据迁移**；浏览器里旧的折叠状态会自动迁移成折叠列表。
- 已完成（done）不能直接拖进取消列（转换表不允许），需先退回待办；详情页的取消入口保留。

---

## 验收清单

| 阶段 | 验收项 | 预期 |
| --- | --- | --- |
| P1 | 配置 GitHub token + `owner/repo` → 测试连接 | 通过；可列出仓库 |
| P1 | 同步 | Issue 进入待办/待规划；PR 不出现；重复同步幂等 |
| P2 | `writebackMode=status`，把卡从「进行中」移到「待你验收」 | Issue 所在 Project 的 Status 同步变化；重复移动不重复写 |
| P2 | `writebackMode=both` | 同时出现 Issue 评论 |
| P2 | 失败（无权限/字段不存在） | 移卡仍成功；卡上出现「GitHub 回写失败」host 评论 |
| P3 | 打开「员工」 | 列出预设；选 Reviewer 预设建卡默认只读 |
| P4 | 源卡发起评审 → 尝试完成源卡 | 完成禁用/被拒；评审卡完成后放行 |
| P5 | 未配置 GitHub 连接打开看板 | 六列，列名为内置文案；取消列默认折叠 |
| P5 | 配置连接后刷新 | 列头变成连接的 `statusMap` 选项名 |
| 回归 | 原有看板功能 | 未配置 GitHub 时行为与本地上游一致；738 测试通过 |

本地验证命令（无需 DSH 重启）：

```sh
pnpm install
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/tsdown/dist/run.mjs -c tsdown.config.ts
```

### 联调状态（2026-11-06，已重启 DSH 后）

- **P1 只读联调已通过**：provider 对 `linxcool/hdefense` 实际拉取 52 条 open issue（PR 已过滤）；运行的插件路由 `POST /dsh-taskboard/external/test` 返回 200，`/external/projects` 返回 64 个仓库；Project #1 的 Status 选项与默认映射完全一致。
- **P2 真实写入已通过**：对 `hdefense#49` 执行 `in_progress → in_review`，Project Status 由「待澄清」变为「待你验收」，Issue 新增 1 条评论；重复执行不重复写入；测试后已还原为「待澄清」。评论链接：<https://github.com/linxcool/hdefense/issues/49#issuecomment-6678064037>。
- **P4 路由级实测已通过**：在真实看板创建实现卡 + 关联评审卡，评审未完成时 done 返回 400 `review cards still open`；完成评审卡后 done 返回 200；测试卡已 purge，看板恢复 0 任务。
- **UI**：重启后侧栏确认出现「任务看板」；员工目录与「发起评审」按钮由组件测试覆盖，等待用户目视确认。
- **主机级集成测试**：`tests/github-workflow.spec.ts` 覆盖「外部同步导入 → 看板移卡 → Project Status + Issue 评论」，网络全部 mock。
- **未做**：GUI 内保存 GitHub 连接（需要用户自己的 PAT）；P3/P4 按钮的目视点击确认。

---

## 安装与回滚

安装（开发态 link）：

```sh
dsh plugin --profile desktop add link:D:/Projects/sourcecode/TraeProjects/dsh-taskboard
```

- host 侧改动需重启 DSH；client 侧重新构建后刷新页面。
- profile 备份位置示例：`C:\Users\ctwl\.dsh\backups\profile-desktop-<时间戳>`。

回滚：

```sh
dsh plugin --profile desktop remove dsh-taskboard
```

必要时从 profile 备份恢复 `package.json` / `cordis.patch.yml` 并重启。已导入的卡片是本地台账数据，可在看板中删除或通过导入替换恢复。

---

## 已知限制

- GitHub 同步是**单向导入**；Project Status 回写是可选旁路，不反向拉取 Project 状态变化。
- Project 字段必须是**单选**类型；不支持 iteration/其他字段类型。
- 看板列固定 6 个；Project 里未被 `statusMap` 覆盖的 Status 选项（本项目是「技术检查」「待合并」「阻塞」）不参与回写，也不会出现在看板上（「阻塞」在看板里是卡片标记而非列）。
- 评审关系只在创建时指定，编辑不可修改；agent 工具暂不支持创建评审卡。
- 员工角色目前用预设名称推断只读/可写，未做显式绑定。
- 上游兼容性字段仅登记 `0.2.0-rc.2` 与本机 `0.2.1-rc.3`；DSH 升级后需重新构建验证。
- `dsh-taskboard` 的 worktree 隔离是协作约定而非安全沙箱。
