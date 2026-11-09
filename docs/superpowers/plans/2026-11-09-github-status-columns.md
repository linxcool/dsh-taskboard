# 看板列对齐 GitHub Status 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让看板主列的名称与数量都和 GitHub Project 的 Status 选项一致（6 列，含默认折叠的取消列），且不改内部状态值、不改写回映射、不迁移数据。

**Architecture:** 协议层把 `canceled` 移进主列集合；列名由一个「标签解析函数」统一决定（连接 `statusMap` 优先，回落 i18n）；列折叠从三个专用布尔泛化成按列的集合，读取时从旧布尔迁移。宿主侧只做一次纯搬迁（`parseStatusMap` 提到 shared），行为不变。

**Tech Stack:** TypeScript + React 18（客户端）、Node 22（宿主）、vitest + jsdom（测试）、Cordis 插件运行时。

**Spec:** `docs/superpowers/specs/2026-11-09-github-status-columns-design.md`

## Global Constraints

- 内部状态值不变：`backlog | todo | in_progress | in_review | done | canceled | archived`，`canTransition` 不动。
- 主列顺序固定：`backlog → todo → in_progress → in_review → done → canceled`；`archived` 不进主列。
- 取消列**默认折叠**。
- 列名优先级：连接 `statusMap` 的选项名 > i18n 默认文案；映射缺列时逐列回落。
- i18n 三份（`zh.ts` / `en.ts` / `ru.ts`）键必须同步，现有 i18n 测试会卡缺键。
- 不新增运行时依赖；测试命令 `node node_modules/vitest/vitest.mjs run`，类型检查 `node node_modules/typescript/bin/tsc --noEmit`。
- 写回语义与 `statusMap` 含义不变：`列=选项`，未知列忽略。

## Review Focus

- 未配置 GitHub 连接的用户：列名必须回落 i18n，不能出现空标题或原始 key。
- `statusMap` 里写了不存在的列名或空值：忽略该项并回落，不能崩、不能把列变空。
- 旧 localStorage 视图状态（`backlogCollapsed` / `todoCollapsed` / `doneCollapsed`）：迁移后折叠状态不丢，未知字段不抛错。
- 台账里已有 `canceled` 任务：出现在取消列而不是「其他任务」页，两个位置的计数都对。
- 从 `done` 拖到取消列：必须被拒绝并提示，绝不能静默改状态或调用 `move`。

---

### Task 1: 把 `parseStatusMap` 提到 shared

**Files:**
- Create: `src/shared/github-status-map.ts`
- Modify: `src/host/github-writeback.ts`（删除本地 `DEFAULT_STATUS_MAP` / `parseStatusMap` 定义，改为 import）
- Test: `tests/github-status-map.spec.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_STATUS_MAP: Readonly<Record<TaskStatus, string>>`
  - `parseStatusMap(raw: string | undefined): Partial<Record<TaskStatus, string>>`
  - `githubStatusMapOf(config: { provider?: string; settings?: Record<string, string> } | undefined): Partial<Record<TaskStatus, string>> | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// tests/github-status-map.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUS_MAP, githubStatusMapOf, parseStatusMap } from '../src/shared/github-status-map.ts'

describe('parseStatusMap', () => {
  it('defaults every column when raw is empty', () => {
    expect(parseStatusMap(undefined)).toEqual(DEFAULT_STATUS_MAP)
  })
  it('overrides one column and keeps the rest', () => {
    const map = parseStatusMap('in_review=等你点头')
    expect(map.in_review).toBe('等你点头')
    expect(map.done).toBe(DEFAULT_STATUS_MAP.done)
  })
  it('ignores unknown columns and empty values', () => {
    const map = parseStatusMap('nope=x,in_review=,todo=就绪')
    expect(map).toEqual({ ...DEFAULT_STATUS_MAP, todo: '就绪' })
  })
})

describe('githubStatusMapOf', () => {
  it('is undefined without a github connection', () => {
    expect(githubStatusMapOf(undefined)).toBeUndefined()
    expect(githubStatusMapOf({ provider: 'zentao', settings: {} })).toBeUndefined()
  })
  it('is undefined when writeback is off', () => {
    expect(githubStatusMapOf({ provider: 'github', settings: { writebackMode: 'off' } })).toBeUndefined()
  })
  it('parses settings.statusMap for an enabled github connection', () => {
    expect(githubStatusMapOf({ provider: 'github', settings: { writebackMode: 'status', statusMap: 'done=收工' } })?.done).toBe('收工')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/github-status-map.spec.ts`
Expected: FAIL — 模块不存在 / 导出未定义。

- [ ] **Step 3: Create `src/shared/github-status-map.ts`**

把 `src/host/github-writeback.ts` 里的 `DEFAULT_STATUS_MAP`、`parseStatusMap` 原样搬过来（逻辑不改），新增：

```ts
export function githubStatusMapOf(
  config: { provider?: string; settings?: Record<string, string> } | undefined,
): Partial<Record<TaskStatus, string>> | undefined {
  if (config?.provider !== 'github') return undefined
  const mode = (config.settings?.writebackMode ?? 'off').toLowerCase()
  if (mode === 'off') return undefined
  return parseStatusMap(config.settings?.statusMap)
}
```

- [ ] **Step 4: Point `github-writeback.ts` at the shared module**

删除本文件里的两个本地定义，改为 `import { parseStatusMap } from '../shared/github-status-map.ts'`。`DEFAULT_STATUS_MAP` 若在其他地方被引用，同样改 import。

- [ ] **Step 5: Run the new test and the existing writeback test**

Run: `node node_modules/vitest/vitest.mjs run tests/github-status-map.spec.ts tests/github-writeback.spec.ts`
Expected: 全部 PASS（行为未变）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/github-status-map.ts src/host/github-writeback.ts tests/github-status-map.spec.ts
git commit -m "refactor(github): move status map parsing into shared"
```

---

### Task 2: 主列扩到 6 个，「其他任务」只留归档与回收站

**Files:**
- Modify: `src/shared/protocol.ts:34-47`
- Modify: `src/client/board/TaskBoard.tsx`（`SecondaryTab` 的取消行）
- Test: `tests/status-columns.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `MAIN_STATUSES` 长度为 6、末位为 `canceled`；`SECONDARY_STATUSES = ['archived']`

- [ ] **Step 1: Write the failing test**

```ts
// tests/status-columns.spec.ts
import { describe, expect, it } from 'vitest'
import { ALL_STATUSES, MAIN_STATUSES, SECONDARY_STATUSES, canTransition } from '../src/shared/protocol.ts'

describe('status sets', () => {
  it('main board has six columns ending with canceled', () => {
    expect(MAIN_STATUSES).toEqual(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])
  })
  it('secondary holds only archived', () => {
    expect(SECONDARY_STATUSES).toEqual(['archived'])
  })
  it('every status still appears exactly once across both sets', () => {
    expect([...MAIN_STATUSES, ...SECONDARY_STATUSES].sort()).toEqual([...ALL_STATUSES].sort())
  })
  it('done cannot transition to canceled', () => {
    expect(canTransition('done', 'canceled')).toBe(false)
  })
})

// 渲染层断言（jsdom）：台账里已有一张 canceled 卡片时，它出现在主看板的取消列，
// 且「其他任务」页的取消行不再存在（归档与回收站仍在）。
it('renders an existing canceled task in the canceled column', () => {
  // renderBoard({ tasks: [makeTask({ status: 'canceled' })] })
  // 期望：主看板存在 [data-status="canceled"] 列且其中含该卡；点开「其他任务」无取消行
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/status-columns.spec.ts`
Expected: FAIL — `MAIN_STATUSES` 仍是 5 个、`SECONDARY_STATUSES` 仍含 `canceled`。

- [ ] **Step 3: Change the two constants in `src/shared/protocol.ts`**

`MAIN_STATUSES` 追加 `'canceled'`；`SECONDARY_STATUSES` 改为 `['archived']`。同步更新紧邻的注释（“五列”改为“六列”）。

- [ ] **Step 4: Drop the canceled row from `SecondaryTab`**

在 `TaskBoard.tsx` 的 `SecondaryTab` 里删除 `canceled` 的分组与行定义；空态判断改为只统计 `archived` + `trashed`。文件第 827 行附近的 `rows` 数组只保留归档与回收站两项。

- [ ] **Step 5: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/status-columns.spec.ts tests/client.spec.ts`
Expected: PASS。若 `client.spec.ts` 里断言了 5 列或「其他任务含取消」，按新行为修正断言（这是刻意的行为变更，不是放宽测试）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/protocol.ts src/client/board/TaskBoard.tsx tests/status-columns.spec.ts tests/client.spec.ts
git commit -m "feat(board): six main columns with canceled moved out of the secondary tab"
```

---

### Task 3: 列折叠从三个布尔泛化成按列集合

**Files:**
- Modify: `src/client/controller.ts`（`loadView` / 状态字段 / setter）
- Modify: `src/client/board/TaskBoard.tsx:420-432`
- Test: `tests/column-collapse.spec.ts`

**Interfaces:**
- Produces:
  - `state.collapsedColumns: TaskStatus[]`
  - `controller.setColumnCollapsed(status: TaskStatus, collapsed: boolean): void`
- Consumes: `MAIN_STATUSES`（Task 2）

- [ ] **Step 1: Write the failing test**

```ts
// tests/column-collapse.spec.ts
import { describe, expect, it } from 'vitest'
import { migrateCollapsedColumns } from '../src/client/controller.ts'

describe('collapsed column migration', () => {
  it('turns legacy booleans into a list', () => {
    expect(migrateCollapsedColumns({ backlogCollapsed: true, todoCollapsed: false, doneCollapsed: true }))
      .toEqual(['backlog', 'done'])
  })
  it('defaults canceled to collapsed', () => {
    expect(migrateCollapsedColumns({})).toContain('canceled')
  })
  it('keeps an explicit list authoritative', () => {
    expect(migrateCollapsedColumns({ collapsedColumns: ['todo'] })).toEqual(['todo'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/column-collapse.spec.ts`
Expected: FAIL — `migrateCollapsedColumns` 未导出。

- [ ] **Step 3: Implement the migration helper and the new state field**

在 `controller.ts` 导出纯函数：

```ts
export function migrateCollapsedColumns(view: {
  collapsedColumns?: unknown
  backlogCollapsed?: boolean
  todoCollapsed?: boolean
  doneCollapsed?: boolean
}): TaskStatus[]
```

规则：`collapsedColumns` 是字符串数组时按其中合法的 `TaskStatus` 逐项保留（**不**附加默认值）；否则收集三个旧布尔为真的列；两种情况都在结果里补上 `canceled`，除非结果已包含它。`loadView()` 改为调用它，`state` 用 `collapsedColumns` 取代三个布尔。

- [ ] **Step 4: Replace the ternary chain in `TaskBoard.tsx`**

`const isCollapsed = state.collapsedColumns.includes(status)`；展开按钮统一调用 `controller.setColumnCollapsed(status, false)`。删除 `setBacklogCollapsed` / `setTodoCollapsed` / `setDoneCollapsed` 或改为薄包装（若别处仍在用）。

- [ ] **Step 5: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/column-collapse.spec.ts tests/client.spec.ts tests/sticky-group-head.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/client/controller.ts src/client/board/TaskBoard.tsx tests/column-collapse.spec.ts
git commit -m "refactor(board): generalize column collapse state and default the canceled column closed"
```

---

### Task 4: 列名跟随连接的 statusMap，i18n 默认改成 GitHub 词汇

**Files:**
- Modify: `src/client/board/labels.ts`（新增 `columnLabel`）
- Modify: `src/client/board/TaskBoard.tsx`（列头渲染）
- Modify: `src/client/controller.ts`（暴露 `githubStatusMap()`）
- Modify: `src/client/i18n/zh.ts`、`en.ts`、`ru.ts`（6 个 `status.column.*` + 新增 `board.column.expandCanceled`）
- Test: `tests/column-labels.spec.ts`

**Interfaces:**
- Consumes: `githubStatusMapOf`（Task 1）、`COLUMN_KEYS`（现有）
- Produces:
  - `columnLabel(t: Translate, status: TaskStatus, statusMap: Partial<Record<TaskStatus, string>> | undefined): string`
  - `controller.githubStatusMap(): Partial<Record<TaskStatus, string>> | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// tests/column-labels.spec.ts
import { describe, expect, it } from 'vitest'
import { columnLabel } from '../src/client/board/labels.ts'

const zh = (key: string) => ({ 'status.column.backlog': '待澄清', 'status.column.canceled': '取消' }[key] ?? key)

describe('columnLabel', () => {
  it('falls back to i18n without a map', () => {
    expect(columnLabel(zh, 'backlog', undefined)).toBe('待澄清')
  })
  it('prefers the connection option name', () => {
    expect(columnLabel(zh, 'backlog', { backlog: '待澄清（GitHub）' })).toBe('待澄清（GitHub）')
  })
  it('falls back per column when the map lacks it', () => {
    expect(columnLabel(zh, 'canceled', { backlog: 'x' })).toBe('取消')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/column-labels.spec.ts`
Expected: FAIL — `columnLabel` 未导出。

- [ ] **Step 3: Implement `columnLabel`**

`labels.ts`：`const mapped = statusMap?.[status]; return mapped !== undefined && mapped.length > 0 ? mapped : t(COLUMN_KEYS[status])`。

- [ ] **Step 4: Wire the map from the external connection**

`controller.githubStatusMap()` 从现有 external 配置读取（`GET /dsh-taskboard/external` 的 GitHub 连接，取 `githubStatusMapOf(config)`）；无连接或读取失败返回 `undefined`。`TaskBoard` 列头改用 `columnLabel(t, status, controller.githubStatusMap())`。

- [ ] **Step 5: Update the three i18n files**

把 `status.column.*` 六个键改为：中文 `待澄清 / 就绪 / 执行中 / 待你验收 / 完成 / 取消`；英文 `Needs clarification / Ready / In progress / Awaiting your review / Done / Canceled`；俄语 `Требует уточнения / Готово / В работе / Ждёт вашей проверки / Завершено / Отменено`。新增 `board.column.expandCanceled` 三语。

- [ ] **Step 6: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/column-labels.spec.ts tests/i18n.spec.ts`
Expected: PASS（i18n 测试会校验三语键对齐）。

- [ ] **Step 7: Commit**

```bash
git add src/client/board/labels.ts src/client/board/TaskBoard.tsx src/client/controller.ts src/client/i18n tests/column-labels.spec.ts
git commit -m "feat(board): column labels follow the connected status map with i18n fallback"
```

---

### Task 5: 拖到取消列与菜单取消

**Files:**
- Modify: `src/client/board/TaskBoard.tsx`（折叠列的拖放目标、`canTransition` 提示）
- Test: `tests/column-drag.spec.ts`

**Interfaces:**
- Consumes: `canTransition`（现有）、`controller.move(id, version, status)`

- [ ] **Step 1: Write the failing test**

用现有 jsdom 渲染手法（参考 `tests/client.spec.ts` 里 `renderBoard` 的用法）断言：

```ts
it('drops an in_progress card on the canceled column', async () => {
  // 构造 in_progress 任务 → 在被折叠的取消列上触发 drop 事件（含 DRAG_TYPE 数据）
  // 期望 controller.move 以 (id, version, 'canceled') 被调用一次
})
it('refuses a done card dropped on the canceled column', async () => {
  // 期望 move 未被调用，且出现 board.drag.forbidden 提示
})
```

- [ ] **Step 2: Run test to verify it fails / passes for the wrong reason**

Run: `node node_modules/vitest/vitest.mjs run tests/column-drag.spec.ts`
Expected: 第一条 FAIL（折叠列不是 drop 目标），第二条可能已通过（现有闸门）。

- [ ] **Step 3: Make the collapsed column a drop target**

折叠渲染分支同样挂 `onDragOver` / `onDragLeave` / `onDrop`，复用主列的 `canTransition` 闸门与提示文案；不要为折叠状态另写一套逻辑。

- [ ] **Step 4: Verify the menu entry still cancels**

在 `TaskDetail` / 卡片菜单里确认「取消任务」仍走同一条 `move` 路径；补一条断言覆盖它（可与 Step 1 同文件）。

- [ ] **Step 5: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/column-drag.spec.ts tests/client.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/client/board/TaskBoard.tsx tests/column-drag.spec.ts
git commit -m "feat(board): accept drops on the canceled column and keep the menu path"
```

---

### Task 6: 文档与全量回归

**Files:**
- Modify: `README.md`（「五列看板」等描述）、`README_en.md`、`FORK.md`（已知限制里若提到 5 列）
- Modify: `changelog.md`（新增未发布条目）

- [ ] **Step 1: Update the docs**

把「五列看板（待规划/待办/进行中/待验收/已完成）」改为六列，并说明取消列默认折叠、列名跟随 GitHub 连接的 Status 映射。

- [ ] **Step 2: Type check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Full suite**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add README.md README_en.md FORK.md changelog.md
git commit -m "docs: describe the six-column board and the status map driven labels"
```
