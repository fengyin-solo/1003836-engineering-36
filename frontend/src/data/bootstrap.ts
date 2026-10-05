import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import {
  ARTIFACT_SHELF_FIELD,
  DEFAULT_SHELF_CAPACITY,
  SCHEMA_VERSION,
  SHELF_CAPACITY_FIELD,
  SHELF_CODE_FIELD,
  SHELF_COUNT_FIELD,
  SHELF_LOCKED_STATUS,
  SHELF_PLANS,
  isNumericCell,
  shelfPlanOf,
  toCount,
} from './storage-plan'

// 一次性兼容初始化引擎（纯逻辑，不碰 localStorage）：
// - fresh：本机从没打开过（dev / 预览各自的源都算），整批播种统一基线；
// - migrated：历史浏览器存储（v1 扁平结构或旧版本号），只回填不覆盖；
// - current / ahead：已经是当前版本或更新版本，不动任何用户数据。
// 所有改动先在内存克隆上完成，最后由 local-store 一次性提交；中途任一步失败都整批放弃。

export type InitMode = 'fresh' | 'migrated' | 'current' | 'ahead' | 'failed'

export type InitChange = {
  scope: 'storage' | 'artifact'
  target: string
  field?: string
  from: unknown
  to: unknown
  reason: string
}

export type BootstrapReport = {
  mode: InitMode
  schemaVersion: number
  fromVersion: number | null
  env: string
  origin: string
  storageKey: string
  userAgent: string
  createdAt: string
  changes: InitChange[]
  warnings: string[]
  shelfCount: number
  storedArtifactCount: number
  /** 现场排查 / 复现步骤，直接照着在出问题的浏览器里操作即可。 */
  steps: string[]
}

export class DataInitError extends Error {
  report: BootstrapReport
  constructor(report: BootstrapReport, detail: string) {
    super(`本地数据初始化失败（${report.mode}）：${detail}`)
    this.name = 'DataInitError'
    this.report = report
  }
}

type StoredShape = { __schemaVersion?: number; rows?: Record<string, EntryRow[]> }

export type BootstrapContext = {
  env: string
  origin: string
  storageKey: string
  userAgent: string
}

export type BootstrapOutcome = {
  data: Record<string, EntryRow[]>
  report: BootstrapReport
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function baseReport(
  mode: InitMode,
  fromVersion: number | null,
  ctx: BootstrapContext,
  createdAt: string,
): BootstrapReport {
  return {
    mode,
    schemaVersion: SCHEMA_VERSION,
    fromVersion,
    env: ctx.env,
    origin: ctx.origin,
    storageKey: ctx.storageKey,
    userAgent: ctx.userAgent,
    createdAt,
    changes: [],
    warnings: [],
    shelfCount: 0,
    storedArtifactCount: 0,
    steps: [],
  }
}

function entryLabel(row: EntryRow, fallback: string): string {
  const code = row[SHELF_CODE_FIELD] ?? row['器物编号'] ?? row.id
  return String(code ?? fallback)
}

/** 统计已挂到真实存在架位上的入库遗物数；指向不存在架位的只告警，不替用户改。 */
function buildLinkedMap(
  artifacts: EntryRow[],
  codeSet: Set<string>,
  warnings: string[],
): Map<string, number> {
  const linked = new Map<string, number>()
  for (const art of artifacts) {
    const rawLink = art[ARTIFACT_SHELF_FIELD]
    if (rawLink === undefined || rawLink === null || String(rawLink).trim() === '') {
      continue
    }
    const code = String(rawLink)
    if (!codeSet.has(code)) {
      warnings.push(`遗物「${entryLabel(art, String(art.id))}」的入藏架位 ${code} 不存在，未改动该遗物记录，请人工核对`)
      continue
    }
    linked.set(code, (linked.get(code) ?? 0) + 1)
  }
  return linked
}

/** 按架位编号升序找第一个还放得下、且未封存的架位。 */
function findAvailableShelf(storage: EntryRow[], linked: Map<string, number>): EntryRow | undefined {
  return [...storage]
    .sort((a, b) => String(a[SHELF_CODE_FIELD]).localeCompare(String(b[SHELF_CODE_FIELD])))
    .find((row) => {
      if (String(row.status) === SHELF_LOCKED_STATUS) {
        return false
      }
      const code = String(row[SHELF_CODE_FIELD])
      const used = linked.get(code) ?? 0
      return used < toCount(row[SHELF_CAPACITY_FIELD])
    })
}

/** 件数与容量核对：数字不一致或超容只告警，绝不回写用户已经改过的数字。 */
function auditShelves(
  storage: EntryRow[],
  linked: Map<string, number>,
  warnings: string[],
): void {
  for (const row of storage) {
    const code = String(row[SHELF_CODE_FIELD] ?? row.id)
    const used = toCount(row[SHELF_COUNT_FIELD])
    const capacity = toCount(row[SHELF_CAPACITY_FIELD])
    const linkedCount = linked.get(code) ?? 0
    if (linkedCount !== used) {
      warnings.push(
        `架位 ${code} 台账当前件数为 ${used}，按遗物入藏记录应为 ${linkedCount}，数字不一致且疑似人工修改过，未自动覆盖`,
      )
    }
    if (used > capacity) {
      warnings.push(`架位 ${code} 当前件数 ${used} 超过容纳件数 ${capacity}，请人工核对`)
    }
  }
}

type MigrateResult = {
  data: Record<string, EntryRow[]>
  changes: InitChange[]
  warnings: string[]
}

/**
 * 历史存储迁移，顺序固定，全部落在克隆上：
 * 1. 存量架位按架位编号回填「容纳件数」（仅历史非数字值，数字值一律保留）；
 * 2. 已入库但没有架位的遗物，按编号顺序补挂到第一个放得下的架位（跨模块对账的来源）；
 * 3. 存量架位按架位编号回填「当前件数」（仅历史非数字值，用入藏遗物数反算）；
 * 4. 基线里缺失的架位整批补齐（去重靠架位编号，重复打开不会追加）；
 * 5. 全量核对，台账与入藏记录对不上只告警、不覆盖。
 */
function migrate(parsed: Record<string, unknown>): MigrateResult {
  const changes: InitChange[] = []
  const warnings: string[] = []

  const data: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(SEED_ROWS)) {
    const legacy = (parsed[key] as EntryRow[] | undefined) ?? []
    data[key] = Array.isArray(legacy) ? clone(legacy) : clone(SEED_ROWS[key])
    if (!Array.isArray(legacy)) {
      warnings.push(`模块 ${key} 的历史数据不是数组，已回退为示例数据`)
    }
  }

  const storage = data.storage
  const artifacts = data.artifact
  const codeSet = new Set(storage.map((row) => String(row[SHELF_CODE_FIELD] ?? '')))

  // 步骤 1：回填容量。
  for (const row of storage) {
    if (isNumericCell(row[SHELF_CAPACITY_FIELD])) {
      continue
    }
    const code = String(row[SHELF_CODE_FIELD] ?? row.id)
    const plan = shelfPlanOf(code)
    const next = plan ? plan.capacity : DEFAULT_SHELF_CAPACITY
    changes.push({
      scope: 'storage',
      target: code,
      field: SHELF_CAPACITY_FIELD,
      from: row[SHELF_CAPACITY_FIELD],
      to: next,
      reason: '存量架位按架位编号回填容纳件数（历史值非数字，数字值不覆盖）',
    })
    row[SHELF_CAPACITY_FIELD] = next
  }

  // 步骤 2：先统计已有挂接，再给未挂接的入库遗物补架位。
  const linked = buildLinkedMap(artifacts, codeSet, warnings)
  for (const art of artifacts) {
    if (String(art.status) !== '已入库') {
      continue
    }
    const rawLink = art[ARTIFACT_SHELF_FIELD]
    if (rawLink !== undefined && rawLink !== null && String(rawLink).trim() !== '') {
      continue
    }
    const target = findAvailableShelf(storage, linked)
    const label = entryLabel(art, String(art.id))
    if (!target) {
      warnings.push(`遗物「${label}」已入库但所有架位均已满或封存，未能补挂架位，请人工安排库位`)
      continue
    }
    const code = String(target[SHELF_CODE_FIELD])
    art[ARTIFACT_SHELF_FIELD] = code
    linked.set(code, (linked.get(code) ?? 0) + 1)
    changes.push({
      scope: 'artifact',
      target: label,
      field: ARTIFACT_SHELF_FIELD,
      from: '',
      to: code,
      reason: '历史入库遗物缺少架位，按架位编号顺序补挂到第一个放得下的架位，与库房初始化保持一致',
    })
  }

  // 步骤 3：回填当前件数（非数字值才回填，按入藏遗物数反算）。
  for (const row of storage) {
    if (isNumericCell(row[SHELF_COUNT_FIELD])) {
      continue
    }
    const code = String(row[SHELF_CODE_FIELD] ?? row.id)
    const next = linked.get(code) ?? 0
    changes.push({
      scope: 'storage',
      target: code,
      field: SHELF_COUNT_FIELD,
      from: row[SHELF_COUNT_FIELD],
      to: next,
      reason: '存量架位按架位编号回填当前件数，数值由该架位上的入藏遗物数反算（数字值不覆盖）',
    })
    row[SHELF_COUNT_FIELD] = next
  }

  // 步骤 4：补齐基线缺失架位。
  for (const plan of SHELF_PLANS) {
    if (codeSet.has(plan.code)) {
      continue
    }
    const template = SEED_ROWS.storage.find((row) => String(row[SHELF_CODE_FIELD]) === plan.code)
    if (!template) {
      throw new Error(`容量基线缺少架位 ${plan.code} 的示例模板，无法补齐`)
    }
    const added = clone(template)
    storage.push(added)
    codeSet.add(plan.code)
    changes.push({
      scope: 'storage',
      target: plan.code,
      from: '缺失',
      to: `容量 ${plan.capacity} / 当前 ${plan.seededCount}`,
      reason: '基线架位在历史存储中缺失，按统一基线整批补齐（按架位编号去重，重复初始化不会再追加）',
    })
  }

  // 步骤 5：核对。
  auditShelves(storage, linked, warnings)

  return { data, changes, warnings }
}

/** 全新播种：数据本就按基线写好，只做核对并输出告警。 */
function freshSeed(): { data: Record<string, EntryRow[]>; warnings: string[] } {
  const data = clone(SEED_ROWS)
  const warnings: string[] = []
  const codeSet = new Set(
    data.storage.map((row) => String(row[SHELF_CODE_FIELD] ?? '')),
  )
  const linked = buildLinkedMap(data.artifact, codeSet, warnings)
  auditShelves(data.storage, linked, warnings)
  return { data, warnings }
}

function replaySteps(ctx: BootstrapContext, mode: InitMode, detail?: string): string[] {
  const lines = [
    `1. 在出问题的环境复现：${ctx.env}，页面地址 ${ctx.origin}（dev 与构建预览端口/源不同，存储各自独立）`,
    `2. 打开 DevTools -> Console，查看 [本地数据初始化] 日志；存储键：${ctx.storageKey}`,
    `3. Console 执行 localStorage.getItem(${JSON.stringify(ctx.storageKey)}) 可导出当前现场数据`,
  ]
  if (mode === 'failed') {
    lines.push(`4. 失败原因：${detail ?? '解析或写入异常'}`)
    lines.push('5. 损坏原文已在备份键中保留（见 Console 报错），确认后可清现场重新初始化：')
    lines.push(`   localStorage.removeItem(${JSON.stringify(ctx.storageKey)}); location.reload()`)
  } else {
    lines.push('4. 想回到初始数据：localStorage.removeItem(上键) 后刷新，或在模块页执行 resetModule')
  }
  return lines
}

/**
 * 初始化入口。raw 为 null 表示从未播种；字符串为历史原文，解析失败抛 DataInitError，
 * 由调用方保留现场、整批回退（不写入任何半成品）。
 */
export function bootstrapData(
  raw: string | null,
  ctx: BootstrapContext,
  now: () => string = () => new Date().toISOString(),
): BootstrapOutcome {
  const createdAt = now()

  if (raw === null) {
    const { data, warnings } = freshSeed()
    const codeSet = new Set(data.storage.map((row) => String(row[SHELF_CODE_FIELD] ?? '')))
    const report = baseReport('fresh', null, ctx, createdAt)
    report.warnings = warnings
    report.shelfCount = data.storage.length
    report.storedArtifactCount = data.artifact.filter(
      (row) => String(row.status) === '已入库' && codeSet.has(String(row[ARTIFACT_SHELF_FIELD])),
    ).length
    report.steps = replaySteps(ctx, 'fresh')
    return { data, report }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const report = baseReport('failed', null, ctx, createdAt)
    report.steps = replaySteps(
      ctx,
      'failed',
      `存储内容不是合法 JSON（${error instanceof Error ? error.message : String(error)}；长度 ${raw.length}，开头 200 字符：${raw.slice(0, 200)}）`,
    )
    throw new DataInitError(report, '历史存储 JSON 解析失败，已保留原文并整批回退')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const report = baseReport('failed', null, ctx, createdAt)
    report.steps = replaySteps(ctx, 'failed', '存储内容结构不是对象')
    throw new DataInitError(report, '历史存储结构异常，已保留原文并整批回退')
  }

  const stored = parsed as StoredShape
  const hasVersion = typeof stored.__schemaVersion === 'number'
  const fromVersion = hasVersion ? (stored.__schemaVersion as number) : 1

  if (hasVersion && fromVersion > SCHEMA_VERSION) {
    const report = baseReport('ahead', fromVersion, ctx, createdAt)
    const rows = stored.rows ?? {}
    const data: Record<string, EntryRow[]> = {}
    for (const key of Object.keys(SEED_ROWS)) {
      data[key] = Array.isArray(rows[key]) ? clone(rows[key]) : clone(SEED_ROWS[key])
    }
    report.shelfCount = data.storage.length
    report.steps = replaySteps(ctx, 'ahead')
    return { data, report }
  }

  if (hasVersion && fromVersion === SCHEMA_VERSION && stored.rows && typeof stored.rows === 'object') {
    const report = baseReport('current', fromVersion, ctx, createdAt)
    const data: Record<string, EntryRow[]> = {}
    for (const key of Object.keys(SEED_ROWS)) {
      const legacy = (stored.rows as Record<string, EntryRow[]>)[key]
      data[key] = Array.isArray(legacy) ? clone(legacy) : clone(SEED_ROWS[key])
    }
    const codeSet = new Set(data.storage.map((row) => String(row[SHELF_CODE_FIELD] ?? '')))
    report.shelfCount = data.storage.length
    report.storedArtifactCount = data.artifact.filter(
      (row) => String(row.status) === '已入库' && codeSet.has(String(row[ARTIFACT_SHELF_FIELD])),
    ).length
    report.steps = replaySteps(ctx, 'current')
    return { data, report }
  }

  // 旧版扁平结构（v1：各模块直接挂在顶层）或旧版本号包装结构：统一迁移。
  const legacyPayload = hasVersion ? (stored.rows ?? {}) : (parsed as Record<string, unknown>)
  let result: MigrateResult
  try {
    result = migrate(legacyPayload as Record<string, unknown>)
  } catch (error) {
    const report = baseReport('failed', fromVersion, ctx, createdAt)
    report.steps = replaySteps(
      ctx,
      'failed',
      `迁移批处理中断：${error instanceof Error ? error.message : String(error)}`,
    )
    throw new DataInitError(report, '迁移过程中断，未写入任何数据')
  }

  const codeSet = new Set(
    result.data.storage.map((row) => String(row[SHELF_CODE_FIELD] ?? '')),
  )
  const report = baseReport('migrated', fromVersion, ctx, createdAt)
  report.changes = result.changes
  report.warnings = result.warnings
  report.shelfCount = result.data.storage.length
  report.storedArtifactCount = result.data.artifact.filter(
    (row) => String(row.status) === '已入库' && codeSet.has(String(row[ARTIFACT_SHELF_FIELD])),
  ).length
  report.steps = replaySteps(ctx, 'migrated')
  return { data: result.data, report }
}
