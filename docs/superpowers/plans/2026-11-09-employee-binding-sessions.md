# 员工绑定与会话可见性 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把员工角色与默认权限从「按 preset 名字猜」换成显式绑定表，让评审卡绑定到具体评审员工，并让任务 ↔ 会话 ↔ 员工的关系在卡片上看得见、点得开。

**Architecture:** 绑定表存成台账顶层字段（不进 `settings`，因为 `settings/update` 是整对象替换语义，会让设置弹窗一保存就清空绑定）；解析函数放 `shared/`，客户端与宿主共用同一个权限优先级；执行开场正文抽成共享纯函数，预览与启动共用同一份文本。

**Tech Stack:** TypeScript + React 18、Node 22、vitest + jsdom、Cordis 插件运行时。

**Spec:** `docs/superpowers/specs/2026-11-09-employee-binding-design.md`

## Global Constraints

- preset 仍是员工配置的唯一来源；绑定表只表达角色与默认权限。
- 权限优先级固定：任务显式 > 员工绑定 > 看板默认。
- 评审卡执行权限恒为 `read-only`，与绑定无关。
- 角色只有 `maker` / `reviewer`；验收权仍只属于人。
- 会话不新增存储：列表从 `task.executions[].sessionId` 派生，按会话聚合。
- 可编辑的开场正文只有「用户正文」；框架行由插件注入，不可编辑，发送后也不回写任务的 `prompt` 字段。
- i18n 三份同步；不新增运行时依赖。
- 测试 `node node_modules/vitest/vitest.mjs run`，类型检查 `node node_modules/typescript/bin/tsc --noEmit`。

## Review Focus

- 设置弹窗保存（整对象替换 `settings`）：绑定表必须不被清空——这是把表放在台账顶层的原因。
- preset 被删除后目录仍能渲染：失效绑定显示「预设不可用」并能解除，不抛异常。
- 两台页面并发改绑定：写接口整表替换，最后写入者胜出，但不能产生重复键（`(projectId, presetId)` 唯一）。
- 同一会话续跑多轮：列表只出现一条，轮次正确；跨任务共用会话时不串台。
- 编辑开场正文后发送：本轮用编辑文本，任务 `prompt` 不变，下一轮回到原文本。

---

### Task 1: 共享绑定模型与解析函数

**Files:**
- Modify: `src/shared/protocol.ts`（`TaskLedger` 加字段、新增类型与函数）
- Test: `tests/employee-binding.spec.ts`

**Interfaces:**
- Produces:
  - `type EmployeeRole = 'maker' | 'reviewer'`
  - `interface EmployeeBinding { presetId: string; projectId?: string; role: EmployeeRole; permission?: PermissionMode; enabled: boolean; defaultReviewer?: boolean }`
  - `TaskLedger.employees?: EmployeeBinding[]`、`TaskLedger.employeesMigratedAt?: string`
  - `asEmployeeBindings(raw: unknown): EmployeeBinding[]`
  - `employeeBindingFor(ledger: TaskLedger, presetId: string | undefined, projectId?: string): EmployeeBinding | undefined`
  - `permissionForCreate(ledger: TaskLedger, presetId: string | undefined, explicit?: string): PermissionMode`
  - `defaultReviewerBinding(ledger: TaskLedger): EmployeeBinding | undefined`
  - `EMPLOYEE_MAX_BINDINGS = 200`

- [ ] **Step 1: Write the failing test**

```ts
// tests/employee-binding.spec.ts
import { describe, expect, it } from 'vitest'
import { asEmployeeBindings, defaultReviewerBinding, employeeBindingFor, emptyLedger, permissionForCreate } from '../src/shared/protocol.ts'

const ledger = (employees: unknown[]) => ({ ...emptyLedger(), employees: asEmployeeBindings(employees) })

describe('asEmployeeBindings', () => {
  it('rejects an unknown role', () => {
    expect(() => asEmployeeBindings([{ presetId: 'x', role: 'boss', enabled: true }])).toThrow()
  })
  it('rejects more than 200 rows', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ presetId: `p${i}`, role: 'maker', enabled: true }))
    expect(() => asEmployeeBindings(rows)).toThrow()
  })
  it('keeps one default reviewer and drops the rest', () => {
    const out = asEmployeeBindings([
      { presetId: 'a', role: 'reviewer', enabled: true, defaultReviewer: true },
      { presetId: 'b', role: 'reviewer', enabled: true, defaultReviewer: true },
    ])
    expect(out.filter(b => b.defaultReviewer === true)).toHaveLength(1)
  })
  it('dedupes by (projectId, presetId), last wins', () => {
    const out = asEmployeeBindings([
      { presetId: 'a', role: 'maker', enabled: true },
      { presetId: 'a', role: 'reviewer', enabled: true },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('reviewer')
  })
})

describe('permission priority', () => {
  it('explicit beats binding beats board default', () => {
    const l = ledger([{ presetId: 'std', role: 'maker', enabled: true, permission: 'read-only' }])
    expect(permissionForCreate(l, 'std', 'danger-full-access')).toBe('danger-full-access')
    expect(permissionForCreate(l, 'std', undefined)).toBe('read-only')
    expect(permissionForCreate(l, 'unbound', undefined)).toBe('workspace-write')
  })
  it('a reviewer without a permission gets the board default, not read-only', () => {
    const l = ledger([{ presetId: 'rev', role: 'reviewer', enabled: true }])
    expect(permissionForCreate(l, 'rev', undefined)).toBe('workspace-write')
  })
  it('ignores disabled bindings', () => {
    const l = ledger([{ presetId: 'std', role: 'maker', enabled: false, permission: 'read-only' }])
    expect(employeeBindingFor(l, 'std')).toBeUndefined()
  })
})

describe('defaultReviewerBinding', () => {
  it('prefers the starred reviewer', () => {
    const l = ledger([
      { presetId: 'a', role: 'reviewer', enabled: true },
      { presetId: 'b', role: 'reviewer', enabled: true, defaultReviewer: true },
    ])
    expect(defaultReviewerBinding(l)?.presetId).toBe('b')
  })
  it('falls back to the first enabled reviewer, and to undefined when none', () => {
    expect(defaultReviewerBinding(ledger([{ presetId: 'a', role: 'reviewer', enabled: true }]))?.presetId).toBe('a')
    expect(defaultReviewerBinding(ledger([]))).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/employee-binding.spec.ts`
Expected: FAIL — 导出不存在。

- [ ] **Step 3: Implement in `src/shared/protocol.ts`**

类型与字段如上；校验规则：`presetId` 非空 trim 字符串，`role` ∈ `{maker, reviewer}`，`permission` 用既有 `asPermission`，`enabled` 布尔，`defaultReviewer` 布尔；按 `(projectId ?? '*', presetId)` 去重后写胜出；多条 `defaultReviewer` 只留第一条；长度上限 200 抛错。

`employeeBindingFor` 只返回 `enabled` 的绑定（先按 `projectId` 精确匹配，再回落全局）；`permissionForCreate` 按 `explicit > binding.permission > defaultPermissionOf(ledger.settings)` 返回；`defaultReviewerBinding` 按 ★ → 第一个启用 reviewer → undefined。

- [ ] **Step 4: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/employee-binding.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts tests/employee-binding.spec.ts
git commit -m "feat(protocol): employee bindings with shared permission resolution"
```

---

### Task 2: 绑定表读写接口

**Files:**
- Modify: `src/host/routes.ts`（新增 `POST /dsh-taskboard/employees`）
- Modify: `src/client/api.ts`、`src/client/controller.ts`
- Test: `tests/routes.spec.ts`（追加）

**Interfaces:**
- Consumes: `asEmployeeBindings`（Task 1）
- Produces:
  - HTTP `POST /dsh-taskboard/employees` body `{ employees: unknown[] }` → `{ ok: true, value: EmployeeBinding[] }`
  - `client.updateEmployees(employees: EmployeeBinding[]): Promise<EmployeeBinding[]>`
  - `controller.saveBindings(next: EmployeeBinding[]): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
it('replaces the binding table without touching settings', async () => {
  // 先 POST /settings/update 写入 maxConcurrent: 5
  // 再 POST /employees 写入一个 maker 绑定
  // 最后 GET /state：employees 命中，settings.maxConcurrent 仍为 5
})
it('rejects an invalid role', async () => {
  // POST /employees 发 role: 'boss' → 400 invalid_input
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/routes.spec.ts -t "binding table"`
Expected: FAIL — 路由不存在（404）。

- [ ] **Step 3: Implement the route**

在 `routes.ts` 的 POST 段新增：解析 `body.employees` → `asEmployeeBindings` → `store.mutate('employees-updated', ledger => { ledger.employees = next; return [] })`；错误走既有 `toFail`。注意 `store.mutate` 已 bump `revision`，客户端 SSE 会自动刷新。

- [ ] **Step 4: Add the client plumbing**

`api.ts` 加 `updateEmployees`；`controller.saveBindings` 调用后返回是否成功（失败时沿用现有 error 提示机制）。

- [ ] **Step 5: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/routes.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/host/routes.ts src/client/api.ts src/client/controller.ts tests/routes.spec.ts
git commit -m "feat(host): employee binding table endpoint"
```

---

### Task 3: 建卡与改卡的权限解析

**Files:**
- Modify: `src/host/tools.ts:628`
- Modify: `src/host/routes.ts:775`（建卡）与 update 分支（`PATCH /tasks/:id`）
- Test: `tests/tools.spec.ts`（追加）、`tests/routes.spec.ts`（追加）

**Interfaces:**
- Consumes: `permissionForCreate(ledger, presetId, explicit)`（Task 1）

- [ ] **Step 1: Write the failing test**

```ts
// tools.spec.ts
it('create inherits the binding permission when permission is omitted', async () => {
  // 台账先写入 presetId: 'std' → permission: 'read-only' 的绑定
  // taskboard_create 传 presetId: 'std'，不传 permission → 生成的任务 permission === 'read-only'
})
it('explicit permission still wins', async () => {
  // 同上但传 permission: 'danger-full-access' → 结果 danger-full-access
})
```

```ts
// routes.spec.ts
it('changing the preset recomputes an untouched permission', async () => {
  // 任务 permission = 看板默认 'workspace-write'，改 preset 为一条 permission: 'read-only' 的绑定
  // → 返回的任务 permission === 'read-only'
})
it('changing the preset keeps an explicitly chosen permission', async () => {
  // 任务 permission = 'danger-full-access'（既非旧绑定也非看板默认），改 preset → 仍是 danger-full-access
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/tools.spec.ts -t "binding permission"`
Expected: FAIL — 仍取看板默认（`workspace-write`）。

- [ ] **Step 3: Replace the create call sites**

`args.permission === undefined ? permissionForCreate(store.snapshot(), presetId, undefined) : asPermission(args.permission)`；`routes.ts` 的建卡分支同样改。`presetId` 在两处都已在作用域内。

- [ ] **Step 4: Implement the preset-change recompute in the update route**

仅当请求里带了 `presetId` 且与旧值不同、且请求未显式带 `permission` 时：令 `old` 为旧 preset 的绑定权限（没有则看板默认），若 `task.permission ?? 看板默认` 等于 `old`，则用 `permissionForCreate(ledger, nextPresetId)` 覆盖；否则保留。规则写在 spec §6 规则 8。

- [ ] **Step 5: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/tools.spec.ts tests/routes.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/host/tools.ts src/host/routes.ts tests/tools.spec.ts tests/routes.spec.ts
git commit -m "feat(host): task permission resolves through employee bindings on create and preset change"
```

---

### Task 4: 一次性把旧正则结果迁移成 reviewer 绑定

**Files:**
- Modify: `src/host/routes.ts`（`GET /model-catalog` 成功后触发）
- Create: `src/host/employee-migration.ts`
- Test: `tests/employee-migration.spec.ts`

**Interfaces:**
- Produces: `migrateEmployeeBindings(ledger: TaskLedger, presets: CatalogPresetItem[], now: () => string): TaskLedger | undefined`
- 规则：`ledger.employees === undefined && ledger.employeesMigratedAt === undefined` 才执行；命中 `/review|reviewer|audit|审查|评审|验收|审核/i`（对 `${id} ${name}`）的 preset 写成 `{ role: 'reviewer', enabled: true }`；写 `employeesMigratedAt`。

- [ ] **Step 1: Write the failing test**

```ts
it('migrates regex matches once', () => {
  const first = migrateEmployeeBindings(emptyLedger(), [{ id: 'reviewer', name: 'Reviewer' }, { id: 'std', name: 'Standard' }], () => '2026-11-09T00:00:00.000Z')
  expect(first?.employees).toEqual([{ presetId: 'reviewer', role: 'reviewer', enabled: true }])
  expect(first?.employeesMigratedAt).toBe('2026-11-09T00:00:00.000Z')
})
it('does nothing when already migrated', () => {
  const l = { ...emptyLedger(), employees: [], employeesMigratedAt: 'x' }
  expect(migrateEmployeeBindings(l, [{ id: 'reviewer', name: 'R' }], () => 'y')).toBeUndefined()
})
it('does nothing when the catalog is empty', () => {
  expect(migrateEmployeeBindings(emptyLedger(), [], () => 'y')).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/employee-migration.spec.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: Implement the pure function and wire it**

纯函数返回新台账或 `undefined`；`routes.ts` 在 `model-catalog` 成功拿到 presets 后 `store.mutate('employees-migrated', ledger => { const next = migrateEmployeeBindings(ledger, presets, now); if (next === undefined) return undefined; ledger.employees = next.employees; ledger.employeesMigratedAt = next.employeesMigratedAt; return [] })`。catalog 取不到（`catch` 分支）时不要写标记。

- [ ] **Step 4: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/employee-migration.spec.ts tests/routes.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/host/employee-migration.ts src/host/routes.ts tests/employee-migration.spec.ts
git commit -m "feat(host): one-shot migration from preset-name inference to reviewer bindings"
```

---

### Task 5: 开场正文共享化 + 预览与启动接口

**Files:**
- Modify: `src/shared/protocol.ts`（`openingBody(task)`）
- Modify: `src/host/execution.ts:1465`（删除 `userBody`，改用共享函数；`RunOptions` 加 `openingBody?: string`）
- Modify: `src/host/routes.ts`（新增 `GET /tasks/:id/opening-body`；run 分支读取 `openingBody`）
- Modify: `src/client/api.ts`、`src/client/controller.ts`
- Test: `tests/opening-body.spec.ts`

**Interfaces:**
- Produces:
  - `openingBody(task: TaskRecord): string`（= `effectivePrompt(task)` 渲染，替换 `{{lastExecution}}` 与 `{{lastComments}}`）
  - `RunOptions.openingBody?: string`（缺省用共享函数生成）
  - HTTP `GET /dsh-taskboard/tasks/:id/opening-body` → `{ ok: true, value: { text: string } }`

- [ ] **Step 1: Write the failing test**

```ts
it('renders title, description and prompt with substitutions', () => {
  const task = makeTask({ title: 'T', description: 'D', prompt: 'P {{lastComments}}' })
  expect(openingBody(task)).toContain('T\n\nD\n\nP')
  expect(openingBody(task)).not.toContain('{{lastComments}}')
})
it('does not include the plugin framing', () => {
  expect(openingBody(makeTask({ title: 'T' }))).not.toContain('【任务看板】')
})
it('running with an opening body override leaves the task prompt untouched', async () => {
  // store 里一张 prompt 为 'P' 的任务；run(id, 'user', { openingBody: '手改的' })
  // 断言：发给 agent 的用户消息是 '手改的'，且 store.get(id).prompt === 'P'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/opening-body.spec.ts`
Expected: FAIL — `openingBody` 未导出。

- [ ] **Step 3: Move the function**

把 `execution.ts` 的 `userBody` 原样搬到 `shared/protocol.ts` 并导出；`execution.ts` 第 883 行改调 `options.openingBody ?? openingBody(task)`。

- [ ] **Step 4: Add the preview route and the run override**

`GET /tasks/:id/opening-body` 返回 `{ text: openingBody(task) }`；run 分支把 `body.openingBody`（字符串，长度 > 0）透传进 `RunOptions`。

- [ ] **Step 5: Client plumbing**

`api.ts` 加 `openingBody(taskId)`；`controller.openingBodyFor(taskId)` 返回文本（失败返回 `undefined`，UI 退回本地空文本并提示）。

- [ ] **Step 6: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/opening-body.spec.ts tests/execution.spec.ts`
Expected: PASS（框架行断言不变）。

- [ ] **Step 7: Commit**

```bash
git add src/shared/protocol.ts src/host/execution.ts src/host/routes.ts src/client/api.ts src/client/controller.ts tests/opening-body.spec.ts
git commit -m "feat(execution): shared opening body with preview and override"
```

---

### Task 6: 员工目录四态与就地编辑

**Files:**
- Modify: `src/client/board/EmployeesModal.tsx`
- Modify: `src/client/i18n/zh.ts`、`en.ts`、`ru.ts`
- Test: `tests/employees-ui.spec.tsx`（改写）

**Interfaces:**
- Consumes: `controller.saveBindings`（Task 2）、`defaultReviewerBinding`（Task 1）、`persist`（既有 exec 统计）
- Produces: 目录卡片 `data-state` ∈ `bound | disabled | unassigned | stale`

- [ ] **Step 1: Write the failing test**

```tsx
it('renders the four states', () => { /* 绑定启用 / 停用 / 未分配 / 失效 各一张，断 data-state */ })
it('dispatch uses the binding permission, not the preset name', async () => {
  // 绑定：presetId 'code-auditor-v2' → maker, permission 'workspace-write'
  // 点「使用这位员工建卡」→ newFromTemplate 收到 permission 'workspace-write'
})
it('disables use on a disabled employee', () => { /* button[disabled] */ })
it('assigns a role through the dropdown', () => { /* 选 role → saveBindings 收到新行 */ })
it('offers review instead of create for a reviewer employee', () => {
  // maker 员工：「使用这位员工建卡」；reviewer 员工：「用它发起评审」
})
it('disables the review action when nothing is in flight', () => {
  // 台账里没有 in_progress / in_review 卡 → 按钮 disabled + 提示 employees.noSourceTask
})
it('shows the binding scope hint in the footer', () => { /* employees.scopeHint 可见 */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/employees-ui.spec.tsx`
Expected: FAIL — 仍按正则渲染两态。

- [ ] **Step 3: Rewrite the modal**

- 删除 `REVIEW_PATTERN` / `isReviewer`。
- 用 `state.ledger.employees` 与 preset catalog 求交，得到四态；失效态来自「绑定存在但 catalog 里没有」。
- 角色 chip 点击切换；权限下拉写回 `saveBindings`；`★` 互斥；停用时「使用」`disabled`。
- 每条绑定加「会话」行：从 `state.ledger.tasks` 的所有 `executions` 里筛 `presetId` 匹配、取最近一条的 `sessionId`。
- 角色为 `reviewer` 的卡片按钮改为「用它发起评审」：点击弹出一个源任务选择器（`in_progress` / `in_review` 的卡，按项目过滤），选中后 `newFromTemplate({ presetId, permission: 'read-only', reviewOf })`；没有候选时按钮 `disabled` 并显示 `employees.noSourceTask`。
- 页脚常驻 `employees.scopeHint`。
- `dispatch` 用 `permissionForCreate(state.ledger, preset.id)` 取权限。

- [ ] **Step 4: Add the i18n keys**

`employees.unassigned`、`employees.stale`、`employees.assign`、`employees.setDefaultReviewer`、`employees.disabled`、`employees.migratedHint`、`employees.reviewAction`、`employees.noSourceTask`、`employees.scopeHint`，三语同步。

- [ ] **Step 5: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/employees-ui.spec.tsx tests/i18n.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/client/board/EmployeesModal.tsx src/client/i18n tests/employees-ui.spec.tsx
git commit -m "feat(employees): explicit role and permission editing on the employee catalog"
```

---

### Task 7: 建卡表单联动 + 详情页「执行员工」

**Files:**
- Modify: `src/client/board/TaskFormModal.tsx`（约 251 行的权限初值、preset 选择处、立即执行旁说明）
- Modify: `src/client/board/TaskDetail.tsx`（新增执行员工下拉）
- Modify: `src/client/i18n/*.ts`
- Test: `tests/employee-binding-form.spec.tsx`、`tests/detail-employee.spec.tsx`

**Interfaces:**
- Consumes: `permissionForCreate`、`employeeBindingFor`（Task 1）、`controller.update`（既有）

- [ ] **Step 1: Write the failing test**

```tsx
// employee-binding-form.spec.tsx
it('prefills role and permission from the binding', () => { /* preset=std → 权限初值来自绑定 */ })
it('shows the resolved source and an override note', () => {
  // 保持「跟随」→ 出现「来自员工绑定」；改成 read-only → 出现「仅影响本卡」
})
it('offers new versus reuse for the execution session', () => { /* 执行方式两个选项 */ })
it('explains what 立即执行 skips', () => { /* form.runNowHint 可见 */ })

// detail-employee.spec.tsx
it('changes the executing employee from the detail pane', () => {
  // 选另一个 preset → controller.update 收到 presetId；权限按规则重算（由宿主保证）
})
it('marks an unbound preset in the picker', () => { /* 「未分配」标记 */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/employee-binding-form.spec.tsx tests/detail-employee.spec.tsx`
Expected: FAIL — 无角色 chip、无来源行、无执行员工下拉。

- [ ] **Step 3: Implement**

- preset 选择变化时重算权限初值与角色 chip。
- 权限下拉保持 `''`（跟随）时展示「实际生效 + 来源」；选具体值时展示覆盖提示。
- 新增「执行方式」下拉：新建会话（默认）/ 复用最近执行会话（列出 `reuseSessionId` 候选，复用现有后端字段）。
- 「⚡ 立即执行」旁渲染 `form.runNowHint`（说明它跳过正文预览）。
- 详情页新增「执行员工」下拉：选项 = 绑定表 ∪ preset catalog（未绑定的标 `detail.employee.unassigned`）；选中调 `controller.update(task.id, task.version, { presetId })`。
- 卡片上加员工 chip（maker / reviewer 两色）。
- 新增 i18n：`form.permission.source`、`form.permission.override`、`form.execution.newSession`、`form.execution.reuseSession`、`form.runNowHint`、`detail.employee.label`、`detail.employee.unassigned`。

- [ ] **Step 4: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/employee-binding-form.spec.tsx tests/detail-employee.spec.tsx tests/i18n.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/client/board/TaskFormModal.tsx src/client/board/TaskDetail.tsx src/client/i18n tests/employee-binding-form.spec.tsx tests/detail-employee.spec.tsx
git commit -m "feat(board): create form and detail pane derive role and permission from bindings"
```

---

### Task 8: 会话 chip、会话列表与「开会话」

**Files:**
- Create: `src/client/board/SessionMenu.tsx`
- Modify: `src/client/board/TaskCard.tsx`（会话槽位）
- Modify: `src/client/controller.ts`（派生 + 弹层状态）
- Modify: `src/client/i18n/*.ts`
- Test: `tests/session-menu.spec.tsx`

**Interfaces:**
- Produces:
  - `sessionsOf(task: TaskRecord): Array<{ sessionId: string; presetId?: string; lastAt: number; rounds: number; outcome: string }>`（放 `src/shared/protocol.ts`，供卡片与详情共用）
  - `SessionMenu({ controller, task })`：无会话渲染 `＋ 开会话`，有会话渲染最近会话 chip
- Consumes: `controller.openingBodyFor`、run 接口（Task 5）

- [ ] **Step 1: Write the failing test**

```tsx
it('aggregates executions by session and counts rounds', () => {
  const task = makeTask({ executions: [exec('s1', 1), exec('s1', 2), exec('s2', 3)] })
  expect(sessionsOf(task)).toHaveLength(2)
  expect(sessionsOf(task).find(s => s.sessionId === 's1')?.rounds).toBe(2)
})
it('shows the open-session slot when there is none', () => { /* '＋ 开会话' 可见 */ })
it('composes the opening body and sends it', () => {
  // 点开会话 → textarea 值 === client.openingBody 返回值 → 点发送 → run 收到 { openingBody: 编辑后文本 }
})
it('copies without starting anything', () => { /* 只复制 → run 未被调用 */ })
it('explains what sending does in the empty compose state', () => { /* compose.emptyHint 可见 */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/session-menu.spec.tsx`
Expected: FAIL — 组件与 `sessionsOf` 不存在。

- [ ] **Step 3: Implement `sessionsOf`**

按 `sessionId` 分组，`rounds` = 组内执行记录数，`lastAt` = 最大 `startedAt`，`outcome` 取组内最新一条；无 `sessionId` 的执行记录跳过。排序：`lastAt` 降序。

- [ ] **Step 4: Implement `SessionMenu`**

- 有会话：chip 显示最近会话 id，点击弹出列表（每行 id / preset / 状态 / 时间 / 轮次 + 跳转），底部「在详情里看完整执行记录」。
- 无会话：虚线 `＋ 开会话`，点击弹层：顶部三枚 chip（preset / 权限 / 分支）、一行框架行说明、可编辑 textarea（初值来自 `controller.openingBodyFor`）、底部「只复制」「发送并创建会话」。
- 发送：`controller.run(task.id, { openingBody })`；成功关闭弹层，状态由宿主 SSE 推回（卡片进执行中、出现 chip）。
- 外点/Esc 关闭；列表与编辑层互斥。

- [ ] **Step 5: Wire into `TaskCard`**

在 `kmeta` 行渲染 `<SessionMenu />`；不改变卡片既有的单击/双击处理。

- [ ] **Step 6: Add i18n keys**

`card.sessions.open`、`detail.sessions.title`、`detail.sessions.footer`、`compose.title`、`compose.framingNote`、`compose.send`、`compose.copy`、`compose.sent`、`compose.emptyHint`，三语同步。

- [ ] **Step 7: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/session-menu.spec.tsx tests/client.spec.ts`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/client/board/SessionMenu.tsx src/client/board/TaskCard.tsx src/client/controller.ts src/shared/protocol.ts src/client/i18n tests/session-menu.spec.tsx
git commit -m "feat(board): session chip, session list and open-session compose flow"
```

---

### Task 9: 评审卡绑定评审员工

**Files:**
- Modify: `src/client/board/TaskDetail.tsx:852-868`
- Modify: `src/client/i18n/*.ts`
- Test: `tests/human-review-ui.spec.tsx`（追加）

**Interfaces:**
- Consumes: `defaultReviewerBinding`（Task 1）

- [ ] **Step 1: Write the failing test**

```tsx
it('passes the reviewer preset when a reviewer binding exists', () => {
  // ★ reviewer 绑定存在 → 「发起评审」→ newFromTemplate 收到 presetId 与 permission 'read-only'
})
it('omits the preset when there is no reviewer binding', () => {
  // 无 reviewer 绑定 → presetId undefined，permission 仍是 'read-only'
})
it('marks review cards so they stand out in a shared column', () => {
  // 渲染带 reviewOf 的卡 → data-role="review"；普通卡没有
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/human-review-ui.spec.tsx`
Expected: FAIL — 不带 `presetId`。

- [ ] **Step 3: Implement**

`const reviewer = defaultReviewerBinding(state.ledger)`；`newFromTemplate({ …, permission: 'read-only', ...(reviewer !== undefined ? { presetId: reviewer.presetId } : {}), reviewOf: task.id })`。评审卡详情在 `reviewOf` chip 旁显示 Reviewer 员工名（`detail.review.employee`，三语）。

评审卡视觉区分：`TaskCard` 在 `task.reviewOf !== undefined` 时加 `data-role="review"`，样式为 3px 紫色左边条；不新增列、不新增存储。

- [ ] **Step 4: Run tests**

Run: `node node_modules/vitest/vitest.mjs run tests/human-review-ui.spec.tsx tests/i18n.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/client/board/TaskDetail.tsx src/client/i18n tests/human-review-ui.spec.tsx
git commit -m "feat(review): review cards are created for the default reviewer"
```

---

### Task 10: 文档与全量回归

**Files:**
- Modify: `FORK.md`（P3 段落改写：不再按名字推断；P4 段落补 reviewer 绑定）、`README.md`、`README_en.md`、`changelog.md`

- [ ] **Step 1: Update the docs**

`FORK.md` 的「已知限制」里删除「员工角色目前用预设名称推断只读/可写，未做显式绑定」，改为新的绑定说明与迁移行为；README 功能特性补「员工绑定」「会话列表 / 开会话」。

- [ ] **Step 2: Type check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Full suite**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add FORK.md README.md README_en.md changelog.md
git commit -m "docs: employee bindings, reviewer cards and session visibility"
```
