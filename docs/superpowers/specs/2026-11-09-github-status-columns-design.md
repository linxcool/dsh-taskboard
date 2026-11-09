# 看板列对齐 GitHub Project Status

- 日期：2026-11-09
- 状态：待评审
- 范围：看板列集合、列名来源、取消列、折叠与拖放语义
- 交互稿：[docs/mockups/employee-binding.html](../mockups/employee-binding.html) 场景 ④
- 相关：[FORK.md](../../../FORK.md)（P2 Project Status 回写）

## 1. 背景与目标

看板与 GitHub Project 看板对不上，差的不是映射关系，而是**词汇和列数**：

| | 看板（现状） | GitHub Project #1 Status |
| --- | --- | --- |
| 名称 | 待规划 / 待办 / 进行中 / 待验收 / 已完成 | 待澄清 / 就绪 / 执行中 / 待你验收 / 完成 |
| 数量 | 5 列；取消与归档收在「其他任务」页 | 6 个选项（含「取消」） |

现有代码里这 6 个状态本来就能一一对上（`statusMap` 默认值就是 `backlog=待澄清, todo=就绪, in_progress=执行中, in_review=待你验收, done=完成, canceled=取消`），只是**内部状态名与展示名**、**列是否出现**这两件事没对齐。

目标：让看板的列在名称与数量上都与 GitHub Project 的 Status 选项一致，同时不改内部状态值、不动 P2 回写映射、不迁移已有数据。

## 2. 现状（代码事实）

- `TaskStatus` 有 7 个值：`backlog | todo | in_progress | in_review | done | canceled | archived`。
- `MAIN_STATUSES` 5 个（`src/shared/protocol.ts:35`），只有 `TaskBoard.tsx:387` 使用它渲染主列。
- `SECONDARY_STATUSES = ['canceled', 'archived']`，在「其他任务」页渲染；`SecondaryTab` 另外固定列出回收站。
- 列名来自 i18n：`status.column.backlog = 待规划` … `status.column.canceled = 已取消`。
- 列折叠是三个布尔：`state.backlogCollapsed` / `todoCollapsed` / `doneCollapsed`，判断处是 `TaskBoard.tsx:420` 的三元链。
- 拖放已经过 `canTransition()` 闸门（`TaskBoard.tsx:413`），非法转换弹提示而不是静默失败。

## 3. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 主列变成 6 个，`canceled` 从「其他任务」移入主列 | 用户确认：名称与数量都要对齐 Project 的 6 个 Status 选项 |
| D2 | 内部状态值、`statusMap`、写回逻辑全部不动 | 只改展示与列集合，数据零迁移 |
| D3 | 取消列**默认折叠**，点列头展开 | 6 列会挤；折叠是与「已完成列折叠」同一套已有交互，不新造控件 |
| D4 | 列折叠状态从三个布尔泛化成按列的集合 | 现在是无处安放的三元链，再加一列就会变成四元链 |
| D5 | 列名默认取与默认映射一致的 6 个名字；**配了 GitHub 连接时以连接的 `statusMap` 为准** | 不同项目的 Status 选项名不同，硬编码换项目就对不上 |
| D6 | 拖到取消列 = 取消任务；菜单入口**保留** | 拖放是快捷方式，菜单入口保证键盘可达与可发现性 |
| D7 | 已完成（done）**不能**直接拖进取消列 | 转换表本来就不允许（`done → canceled` 不存在），先退回待办再取消 |

## 4. 列集合与协议变更

```ts
export const MAIN_STATUSES: readonly TaskStatus[] = [
  'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled',
]

export const SECONDARY_STATUSES: readonly TaskStatus[] = ['archived']
```

- `ALL_STATUSES` 不变（仍是 7 个），`canTransition` 不变。
- 「其他任务」页变成**归档 + 回收站**；取消不再出现在那里。
- `SecondaryTab` 里取消那一行删除，占位统计与空态判断同步调整。

## 5. 列名来源

优先级：**连接的 `statusMap` 反向映射 > i18n 默认文案**。

1. 无 GitHub 连接（或 `writebackMode = off`）：用 i18n 默认文案。本次把默认文案改成与默认映射一致的 6 个名字：

   | 状态 | zh | en | ru |
   | --- | --- | --- | --- |
   | backlog | 待澄清 | Needs clarification | Требует уточнения |
   | todo | 就绪 | Ready | Готово |
   | in_progress | 执行中 | In progress | В работе |
   | in_review | 待你验收 | Awaiting your review | Ждёт вашей проверки |
   | done | 完成 | Done | Завершено |
   | canceled | 取消 | Canceled | Отменено |

2. 有连接：解析 `statusMap`（`列=选项` 逗号分隔），对每个主列取该列对应的选项名作为列头；某个列在映射里缺失时回落到 i18n。
3. 映射里的选项名在 Project 中不存在时不特殊处理 —— 回写阶段本来就会失败并留 host 评论（P2 既有行为）。

映射解析复用 `src/host/github-writeback.ts` 里的 `parseStatusMap`，把它提到 `shared/`，客户端与宿主共用。

## 6. 交互

| 行为 | 定义 |
| --- | --- |
| 折叠 | 每列可折叠；`canceled` 默认折叠，其余默认展开；状态按浏览器持久化（与现有 `doneCollapsed` 同一份 view state） |
| 拖到取消列 | 走 `canTransition`；允许的转换执行 `move`，不允许的（含 done）弹既有 `board.drag.forbidden` 提示 |
| 菜单入口 | 详情页/卡片菜单里的「取消任务」保留，行为不变 |
| 其他任务页 | 只剩归档与回收站，计数与空态同步 |
| 窄屏 | 6 列时保留横向滚动，不压缩卡片宽度；折叠列固定 64px |
| 取消列上限 | 不设显示上限（先观察实际量）；需要时再复用已完成列的 `completedDisplayLimit` 机制 |

## 7. 迁移与兼容

- **无数据迁移**：任务状态值不变，台账 JSON 格式不变。
- **视图状态迁移**：旧 localStorage 里是 `backlogCollapsed` / `todoCollapsed` / `doneCollapsed` 三个布尔，新结构是 `collapsedColumns: TaskStatus[]`；读取时把旧布尔转换进集合，`canceledCollapsed` 默认 `true`。写回时只写新结构。
- **导出/导入**：导出 CSV 的状态列文案跟随列名来源；JSON 台账不含视图状态，不受影响。
- **写回映射**：不变。取消列回写仍是 `canceled=取消`（默认映射），P2 已验证过的路径不受影响。

## 8. 测试计划

| # | 断言 |
| --- | --- |
| T1 | 主列 6 个，顺序为 backlog → todo → in_progress → in_review → done → canceled |
| T2 | 「其他任务」页不再出现取消行，归档与回收站仍在 |
| T3 | 取消列默认折叠；展开后卡片可见；折叠状态持久化 |
| T4 | 旧视图状态（三个布尔）能迁移进 `collapsedColumns` |
| T5 | 从 in_progress 拖到取消列 → 状态变 canceled 并触发 `move` |
| T6 | 从 done 拖到取消列 → 被拒绝并提示，不调用 `move` |
| T7 | 菜单「取消任务」仍可用 |
| T8 | 无连接时列名为 i18n 默认 6 个 |
| T9 | 有连接且 `statusMap` 指向不同名字时，列头跟随映射 |
| T10 | 映射缺某一列时该列回落 i18n |
| T11 | 三语 i18n 键齐全（现有 i18n 测试会卡缺键） |

回归：主看板筛选、排序、分组折叠、SSE 刷新、已完成列上限在 6 列下仍正常。

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| 6 列在 1280 宽度下过窄 | 横向滚动 + 取消列默认折叠；不压卡片 |
| 取消任务变容易误触（拖动） | 保留菜单入口；拖放仍受状态机限制；不新增“拖拽即取消无确认”的批量操作 |
| 列名跟随映射后，用户改映射会“列名突然变了” | 属预期：映射即词汇表；设置页保存后立即生效 |
| 其它依赖“5 列”的测试 | T1 起全部改成按 `MAIN_STATUSES` 断言，不写死数字 |

## 10. 验收标准

1. 看板主列 6 个，名称与当前连接的项目 Status 选项一致（未连接时为默认 6 名）。
2. 取消列默认折叠，可展开、可拖入、可从菜单取消。
3. 「其他任务」只剩归档与回收站。
4. 已有台账导入后无需任何迁移步骤；P2 回写行为不变。
5. 旧浏览器视图状态不丢：原先折叠的列仍然折叠。

## 11. Out of scope

- 列由 Project Status **动态生成**（数量随项目变化）。
- 归档（archived）成为列。
- 看板支持多个 Project 的不同 Status 词汇表（当前只有一份活动连接）。
- 改动 P2 的写回映射语义。
