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
- **状态导入映射**：导入时读取 issue 在 Project 里的 Status 选项名，按连接的 `statusMap` **反向**映射成看板列（新建卡直接落在对应列；已有卡仍停在导入列时会跟随一次，被人工/agent 动过的卡不被覆盖）。未映射的选项（如「技术检查」「待合并」「阻塞」）回落到「导入到」列。Project 未配置或 token 缺少 `project` scope 时自动降级为纯导入，不阻塞同步。
- **子任务与史诗**：导入时读取 GitHub 的 sub-issue 关系。**根问题且有子项 = 史诗**，不建卡，只作为看板顶部的「父任务」筛选维度（显示其全部后代，任意层级）；有父级的 issue 正常建卡，卡片上可看到所属父任务。已经是卡的 issue 后来变成父任务时自动归档。
- **关闭即归档**：来源 issue 关闭后，卡片自动移到已归档，并在卡片上留一条 host 评论说明原因；**有在途执行/被认领时跳过本轮**，等结算后的下一次同步再归档。未导入的关闭 issue 仍不导入（当作历史）。默认只对 GitHub 开启（`archiveOnClose` 默认 `on`，禅道/TAPD 默认 `off`，可在连接设置里用 `archiveOnClose=on|off` 覆盖），因为禅道那套依赖看板自己持有状态。
- 不写回 GitHub；导入为单向（状态映射仅为导入时的一次读取，不持续轮询）。

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

### P3 · 员工卡（Agent 预设目录 + 显式绑定）

- 看板工具栏「👥 员工」打开员工目录：读取 DSH 的 Agent preset，把每张预设显示为员工卡。
- **角色与默认权限是显式数据，不再按名字推断**：台账顶层的 `employees` 表（`presetId → role / permission / enabled / defaultReviewer`），四态显示——已绑定启用 / 已绑定停用 / 未分配 / 预设不可用。
- 角色只有 `maker` / `reviewer`；★ 标记默认评审员工，全表唯一。角色与权限直接在卡片上改，未分配只给一个角色下拉。
- 权限优先级：**任务显式 > 员工绑定 > 看板默认**；GUI 建卡、`taskboard_create` 与「换 preset 改卡」共用同一套解析（`permissionForCreate`）。换 preset 时只有「仍等于旧绑定/看板默认」的权限才重算，用户手设的保留。
- 绑定表放在台账顶层而不是 `settings`：`settings/update` 是整对象替换，放进去会被任何一次设置保存清空。
- 迁移：首次读到 preset 目录时，把旧的「名字像 review」的推断结果一次性写成 `reviewer` 绑定并写 `employeesMigratedAt`（即使没命中也会写标记，避免改名后旧猜测复活）。
- 不复制 preset 配置；preset 仍是唯一配置来源。项目维度（`projectId`）已在数据键里预留，界面当前只维护全局行。

### P4 · 评审卡完成门禁

- 任务详情「🧪 发起评审」：创建只读评审卡，自动带上 `reviewOf`、Reviewer prompt 与只读权限。
- 评审卡的 preset 取**默认评审员工**（★，否则第一个启用的 reviewer）；没有评审员工时保持部署默认，不阻塞创建。只读是评审卡自身的规则，员工绑定不能把它提到可写。
- 员工目录里评审员工的按钮是「用它发起评审」：先选一张「执行中/待你验收」的源卡，再打开预填 `reviewOf` 的表单——评审员工不会建出普通卡。
- 任务卡新增可选字段 `reviewOf`（评审卡指向被评审任务）；看板上评审卡带 `data-role="review"` 便于在同列里区分。
- 门禁：存在未关闭（非 done/canceled/archived）评审卡时，被评审任务**不能**移到 done；详情页完成按钮置灰，路由侧硬拒。
- 代理（agent）本来就不能 done；门禁对用户与 API 同时生效。

### P7 · 跨仓库协作：规范仓库只读引用

- 看板设置「跨项目规范仓库（只读参考）」填一个存放跨项目约定/模板的仓库路径（本机是 `D:/Projects/github/aidot`）。
- 开场 framing 只**多一行指针**：让 agent 去读该仓库的 `AGENTS.md` 与 `docs/cross-repo-contracts.md`；执行目录与写边界仍是任务自己的项目（DSH 的 workspace-write 以会话 cwd 为界，不因为多一行而放宽）。
- 跨仓库的改动走**子任务卡**：父卡按阶段/里程碑、子卡各自落在对应仓库执行，父任务筛选可直接查看整棵树（P1 v2）。
- 为什么不让会话直接在规范仓库执行：aidot 只放规范与模板，没有各项目代码；在那里开会话既改不了代码（沙箱），worktree 隔离也没有意义。
- 已知边界：多仓库工作区（含伞形根）受 `MAX_MIRROR_REPOS = 8` 限制，本机 `D:/Projects/github` 下 22 个仓库，不能直接当工作区。

### P6 · 建卡即建 Issue（出站）

- 看板设置「建卡时同步创建 GitHub Issue」（默认**关**）。打开后，新建任务会同时在 GitHub 建 issue、加入 Project 并按卡片状态设置 Status。
- 仓库由**任务所属项目的连接映射**决定（mapping.workspaceId === task.workspaceId），多连接也不会歧义；没有映射就只建本地卡。
- 成功后把 external 关联回填到卡片，之后状态写回、关闭归档、父任务筛选全部自动生效。
- 失败策略：**issue 建成即成功**。Project 加入/设状态失败只在卡片留一条 host 评论，不重试（避免重复 issue）；issue 本身建失败则卡片照常保留并留言。
- 只在建卡时触发；编辑标题/描述不会改 issue（单向出站仅限创建）。

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
| P3 | 员工目录改角色/权限 → 建卡 | 表单按绑定带出权限；改 preset 时未手设的权限跟着变 |
| P3 | 旧台账首次打开看板 | 名称像 review 的预设被写成 reviewer 绑定，且只写一次 |
| P4 | 配 ★ 评审员工后发起评审 | 评审卡的 preset 是该员工，权限仍锁只读 |
| P3 | 卡片无会话 → 点「＋ 开会话」 | 弹层给出可编辑开场正文；发送后卡片进执行中并出现会话 chip |
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
dsh plugin --profile desktop add link:D:/Projects/github/dsh-taskboard
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

- GitHub 同步是**单向导入**（不含状态回读轮询）；写回是可选旁路。导入时会读一次 Project Status 映射看板列，但之后远端状态变化只影响仍停在导入列的卡，不会覆盖已处理的卡。
- 史诗（根问题且有子项）不建卡，因此它的 Project Status 只能通过筛选器读取，不会出现在列计数里；父任务筛选按 issue 编号匹配，跨仓库同号由 `repo#number` 区分。
- 自动归档会绕过 `canTransition`（同步直接写状态）；归档后卡片不可恢复编辑，只能移回（TODO 之外的状态不允许再从 archived 出发）。
- Project 字段必须是**单选**类型；不支持 iteration/其他字段类型。
- 看板列固定 6 个；Project 里未被 `statusMap` 覆盖的 Status 选项（本项目是「技术检查」「待合并」「阻塞」）不参与回写，也不会出现在看板上（「阻塞」在看板里是卡片标记而非列）。
- 评审关系只在创建时指定，编辑不可修改；agent 工具暂不支持创建评审卡。
- 员工绑定只影响**之后新建**的任务；已有卡片按各自记录的 preset 与权限执行（可在详情页「执行员工」改派）。
- 绑定表的项目维度（`projectId`）已在数据键里预留，但界面当前只维护全局行。
- 会话列表按 `sessionId` 聚合；没有会话 ID 的历史执行记录不会出现在列表里（详情页仍能看到完整执行记录）。
- 上游兼容性字段仅登记 `0.2.0-rc.2` 与本机 `0.2.1-rc.3`；DSH 升级后需重新构建验证。
- `dsh-taskboard` 的 worktree 隔离是协作约定而非安全沙箱。
