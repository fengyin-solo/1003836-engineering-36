import {
  BOOTSTRAP_META_KEY,
  commitAll,
  readBootstrapMeta,
  resetCache,
  storageKey,
  writeBootstrapMeta,
} from './local-store'
import { SEED_ROWS } from './seed'
import {
  SHELF_CATALOG,
  SHELF_FULL,
  SHELF_OPEN_STATUS,
  capacityOf,
  currentCountOf,
  defaultCapacity,
  defaultLayers,
  planAllocation,
  sortByShelfCode,
  specForCode,
  statusForShelf,
  toNonNegativeInt,
  type AllocationPlan,
  CAPACITY_FIELD,
  CURRENT_FIELD,
  LAYER_FIELD,
  SHELF_CODE_FIELD,
  ARTIFACT_MODULE_KEY,
  STORAGE_MODULE_KEY,
} from './storage-catalog'
import type { EntryRow } from './types'

// 库房架位容量初始化：
// 1) 全新环境（本地开发/构建预览首次打开）：按容量目录播种同一批架位；
// 2) 已有浏览器存储（历史环境）：按架位编号回填容量与当前件数，追加缺失架位，
//    用户手工改过的合法数字一律不覆盖；
// 3) 整批只执行一次（版本标记），重复打开不再追加；
// 4) 任一步失败整批回退，保留原始存储并给出可复现的排查信息。

export const BOOTSTRAP_VERSION = 'storage-capacity-v1'

export type BootstrapDiagnostics = {
  code:
    | 'STORAGE_CORRUPT'
    | 'STORED_COUNT_MISMATCH'
    | 'SHELF_CAPACITY_EXHAUSTED'
    | 'INVALID_CAPACITY_DATA'
    | 'ROLLBACK_FAILED'
  message: string
  storageKey: string
  bootstrapKey: string
  version: string
  mode: string
  storedArtifacts: number
  occupiedArtifacts: number
  openCapacity: number
  appendingCodes: string[]
  managedCodes: string[]
  preserveCodes: string[]
  timestamp: string
  reproduce: string[]
}

export class BootstrapError extends Error {
  readonly diagnostics: BootstrapDiagnostics

  constructor(diagnostics: BootstrapDiagnostics) {
    super(diagnostics.message)
    this.name = 'BootstrapError'
    this.diagnostics = diagnostics
  }
}

export type BootstrapReport = {
  status: 'skipped' | 'seeded' | 'migrated'
  mode: string
  storageRows: number
  appendedCodes: string[]
  backfilledCodes: string[]
  preserveCodes: string[]
  storedArtifacts: number
  warning?: string
}

function currentMode(): string {
  try {
    return import.meta.env?.MODE ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

type MigrationContext = {
  mode: string
  appendingCodes: string[]
  managedCodes: string[]
  preserveCodes: string[]
  storedArtifacts: number
  occupiedArtifacts: number
  openCapacity: number
}

function rowCode(row: EntryRow): string {
  return String(row[SHELF_CODE_FIELD] ?? `(无编号#${row.id})`)
}

function diagnose(
  partial: Omit<BootstrapDiagnostics, 'storageKey' | 'bootstrapKey' | 'version' | 'mode' | 'timestamp'>,
  ctx: MigrationContext,
): BootstrapDiagnostics {
  return {
    ...partial,
    storageKey: storageKey(),
    bootstrapKey: BOOTSTRAP_META_KEY,
    version: BOOTSTRAP_VERSION,
    mode: ctx.mode,
    timestamp: new Date().toISOString(),
  }
}

export type MigrationResult = {
  rows: EntryRow[]
  appendedCodes: string[]
  backfilledCodes: string[]
  preserveCodes: string[]
  warning?: string
}

// 兼容迁移的核心：分类 + 回填 + 追加 + 对账。纯函数，失败只抛错、绝不写存储。
export function migrateStorageRows(input: {
  storageRows: EntryRow[]
  artifactRows: EntryRow[]
  mode: string
}): MigrationResult {
  const { storageRows, artifactRows, mode } = input
  const ctx: MigrationContext = {
    mode,
    appendingCodes: [],
    managedCodes: [],
    preserveCodes: [],
    storedArtifacts: artifactRows.filter((row) => String(row.status) === '已入库').length,
    occupiedArtifacts: 0,
    openCapacity: 0,
  }

  const nextRows: EntryRow[] = storageRows.map((row) => ({ ...row }))
  const managed: EntryRow[] = []
  const backfilledCodes: string[] = []

  // 第一步：逐架位分类。容量/件数不是非负整数的才回填；
  // 用户已经改成合法数字的，原样保留，一个字段都不动。
  for (const row of nextRows) {
    const code = rowCode(row)
    const spec = specForCode(String(row[SHELF_CODE_FIELD] ?? ''))

    if (toNonNegativeInt(row[CAPACITY_FIELD]) === null) {
      row[CAPACITY_FIELD] = spec ? spec.capacity : defaultCapacity()
    }
    if (toNonNegativeInt(row[LAYER_FIELD]) === null) {
      row[LAYER_FIELD] = spec ? spec.layers : defaultLayers()
    }

    if (toNonNegativeInt(row[CURRENT_FIELD]) !== null) {
      // 已有合法当前件数：保留，不纳入自动分配。
      ctx.preserveCodes.push(code)
      const occupied = currentCountOf(row)
      ctx.occupiedArtifacts += occupied
      if (occupied > capacityOf(row)) {
        throw new BootstrapError(
          diagnose(
            {
              code: 'INVALID_CAPACITY_DATA',
              message: `架位 ${code} 当前件数 ${occupied} 超过容纳件数 ${capacityOf(
                row,
              )}，初始化已整批回退，未改动任何记录`,
              storedArtifacts: ctx.storedArtifacts,
              occupiedArtifacts: ctx.occupiedArtifacts,
              openCapacity: 0,
              appendingCodes: ctx.appendingCodes,
              managedCodes: ctx.managedCodes,
              preserveCodes: ctx.preserveCodes,
              reproduce: [
                `DevTools → Application → Local Storage，打开键 ${storageKey()}，找到架位 ${code} 的「${CURRENT_FIELD}」与「${CAPACITY_FIELD}」`,
                `修正为 当前件数 ≤ 容纳件数 后刷新页面重试（版本 ${BOOTSTRAP_VERSION}，环境 ${mode}）`,
              ],
            },
            ctx,
          ),
        )
      }
      continue
    }

    // 当前件数缺失或不是数字：由初始化接管，先置 0，对账时统一落件。
    ctx.managedCodes.push(code)
    backfilledCodes.push(code)
    row[CURRENT_FIELD] = 0
    managed.push(row)
  }

  // 第二步：按容量目录追加缺失架位。编号去重，重复打开不会重复追加。
  const existingCodes = new Set(nextRows.map((row) => String(row[SHELF_CODE_FIELD] ?? '')))
  let nextId = nextRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  for (const spec of SHELF_CATALOG) {
    if (existingCodes.has(spec.code)) {
      continue
    }
    nextId += 1
    const row: EntryRow = {
      id: nextId,
      status: spec.baseStatus,
      pending: spec.baseStatus === SHELF_OPEN_STATUS,
      abnormal: false,
      [SHELF_CODE_FIELD]: spec.code,
      库房名称: '一号库房',
      存放器物类别: spec.category,
      [LAYER_FIELD]: spec.layers,
      [CAPACITY_FIELD]: spec.capacity,
      [CURRENT_FIELD]: 0,
      管理人: '库房管理员',
      架位状态: spec.baseStatus,
    }
    nextRows.push(row)
    managed.push(row)
    ctx.appendingCodes.push(spec.code)
    existingCodes.add(spec.code)
  }

  // 第三步：对账。待安排件数 = 已入库遗物数 - 保留架位上已有件数，
  // 只在初始化接管的架位（回填 + 新追加）里按统一分配算法落件。
  const toPlace = ctx.storedArtifacts - ctx.occupiedArtifacts
  let warning: string | undefined
  if (toPlace < 0) {
    // 用户架位件数比遗物记录多（可能另有账本）：不覆盖用户数字，仅告警。
    warning = `架位当前件数合计 ${ctx.occupiedArtifacts} 多于已入库遗物 ${ctx.storedArtifacts} 件，已保留用户填写的件数未做改动`
  }

  ctx.openCapacity = managed
    .filter((row) => String(row.status) === SHELF_OPEN_STATUS)
    .reduce((sum, row) => sum + (capacityOf(row) - currentCountOf(row)), 0)

  const allocation = planAllocation(managed, Math.max(toPlace, 0))
  if (allocation.remaining > 0) {
    throw new BootstrapError(
      diagnose(
        {
          code: 'SHELF_CAPACITY_EXHAUSTED',
          message: `还有 ${allocation.remaining} 件已入库遗物安排不下：可回填架位剩余容量不足，初始化已整批回退`,
          storedArtifacts: ctx.storedArtifacts,
          occupiedArtifacts: ctx.occupiedArtifacts,
          openCapacity: ctx.openCapacity,
          appendingCodes: ctx.appendingCodes,
          managedCodes: ctx.managedCodes,
          preserveCodes: ctx.preserveCodes,
          reproduce: [
            `Console 执行：JSON.parse(localStorage.getItem('${storageKey()}')).storage`,
            `核对各架位「${CAPACITY_FIELD}」「${CURRENT_FIELD}」，扩容或腾出架位后刷新重试（版本 ${BOOTSTRAP_VERSION}，环境 ${mode}）`,
          ],
        },
        ctx,
      ),
    )
  }

  const managedById = new Map(managed.map((row) => [Number(row.id), row]))
  for (const plan of allocation.plans as AllocationPlan[]) {
    const row = managedById.get(plan.rowId)
    if (!row) {
      continue
    }
    row[CURRENT_FIELD] = plan.after
  }

  // 所有被初始化接管的架位（含一件都没分到的）都按最终件数统一推导状态：
  // 占位文字「已满」但件数为 0 的历史脏数据在这里一并纠正；
  // 目录外的自定义架位没有基础状态，保持用户原有状态，只在到顶时标「已满」。
  for (const row of managed) {
    const spec = specForCode(String(row[SHELF_CODE_FIELD] ?? ''))
    const baseStatus = spec ? spec.baseStatus : String(row.status)
    const derived = statusForShelf(baseStatus, currentCountOf(row), capacityOf(row))
    row.status = derived
    row.架位状态 = derived
    row.pending = derived === SHELF_OPEN_STATUS
    if (spec) {
      row.abnormal = false
    }
  }

  // 第四步：自检。回填后总数必须等于已入库遗物数（用户件数偏多的情况只走警告）。
  const finalTotal = nextRows.reduce((sum, row) => sum + currentCountOf(row), 0)
  if (toPlace >= 0 && finalTotal !== ctx.storedArtifacts) {
    throw new BootstrapError(
      diagnose(
        {
          code: 'STORED_COUNT_MISMATCH',
          message: `回填后架位件数合计 ${finalTotal} 与已入库遗物 ${ctx.storedArtifacts} 不一致，初始化已整批回退`,
          storedArtifacts: ctx.storedArtifacts,
          occupiedArtifacts: ctx.occupiedArtifacts,
          openCapacity: ctx.openCapacity,
          appendingCodes: ctx.appendingCodes,
          managedCodes: ctx.managedCodes,
          preserveCodes: ctx.preserveCodes,
          reproduce: [
            `Console 执行：JSON.parse(localStorage.getItem('${storageKey()}')).artifact.filter(r => r.status === '已入库').length`,
            `再对比 storage 各架位「${CURRENT_FIELD}」之和（版本 ${BOOTSTRAP_VERSION}，环境 ${mode}）`,
          ],
        },
        ctx,
      ),
    )
  }

  return {
    rows: sortByShelfCode(nextRows),
    appendedCodes: ctx.appendingCodes,
    backfilledCodes,
    preserveCodes: ctx.preserveCodes,
    warning,
  }
}

let lastError: BootstrapDiagnostics | null = null

export function lastBootstrapError(): BootstrapDiagnostics | null {
  return lastError
}

export function clearBootstrapError(): void {
  lastError = null
}

function rollback(rawSnapshot: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 打开前是什么就恢复成什么：原本没有键就删掉，绝不留下半批数据。
  if (rawSnapshot === null) {
    window.localStorage.removeItem(storageKey())
  } else {
    window.localStorage.setItem(storageKey(), rawSnapshot)
  }
  resetCache()
}

// 应用启动时调用一次。已初始化过则跳过；失败抛 BootstrapError，磁盘上的存储保持打开前原样。
export function runBootstrap(): BootstrapReport {
  const mode = currentMode()
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      status: 'skipped',
      mode,
      storageRows: 0,
      appendedCodes: [],
      backfilledCodes: [],
      preserveCodes: [],
      storedArtifacts: 0,
    }
  }

  const meta = readBootstrapMeta()
  if (meta && meta.version === BOOTSTRAP_VERSION) {
    return {
      status: 'skipped',
      mode,
      storageRows: 0,
      appendedCodes: [],
      backfilledCodes: [],
      preserveCodes: [],
      storedArtifacts: 0,
    }
  }

  const holder = window.localStorage
  const rawSnapshot = holder.getItem(storageKey())

  let raw: Record<string, EntryRow[]> | null = null
  if (rawSnapshot !== null) {
    try {
      raw = JSON.parse(rawSnapshot) as Record<string, EntryRow[]>
    } catch {
      const diagnostics: BootstrapDiagnostics = {
        code: 'STORAGE_CORRUPT',
        message: '浏览器里的本地数据已损坏（无法解析 JSON），初始化已跳过且未覆盖原数据',
        storageKey: storageKey(),
        bootstrapKey: BOOTSTRAP_META_KEY,
        version: BOOTSTRAP_VERSION,
        mode,
        timestamp: new Date().toISOString(),
        storedArtifacts: 0,
        occupiedArtifacts: 0,
        openCapacity: 0,
        appendingCodes: [],
        managedCodes: [],
        preserveCodes: [],
        reproduce: [
          `Console 执行 localStorage.getItem('${storageKey()}') 查看原始内容`,
          `备份后执行 localStorage.removeItem('${storageKey()}') 并刷新，即可恢复为标准示例数据`,
        ],
      }
      lastError = diagnostics
      throw new BootstrapError(diagnostics)
    }
  }

  // 纯计算阶段：不触碰 localStorage，抛错即等于整批回退（磁盘压根没变）。
  let next: Record<string, EntryRow[]>
  let report: BootstrapReport
  try {
    if (raw === null) {
      // 全新环境：直接采用容量目录生成的标准示例，dev 与构建预览长出完全相同的架位。
      next = JSON.parse(JSON.stringify(SEED_ROWS)) as Record<string, EntryRow[]>
      report = {
        status: 'seeded',
        mode,
        storageRows: next[STORAGE_MODULE_KEY]?.length ?? 0,
        appendedCodes: [],
        backfilledCodes: [],
        preserveCodes: [],
        storedArtifacts: (next[ARTIFACT_MODULE_KEY] ?? []).filter(
          (row) => String(row.status) === '已入库',
        ).length,
      }
    } else {
      // 存量环境：缺失模块用示例补齐，库房按架位编号回填容量与件数。
      next = { ...(JSON.parse(JSON.stringify(SEED_ROWS)) as Record<string, EntryRow[]>), ...raw }
      const result = migrateStorageRows({
        storageRows: next[STORAGE_MODULE_KEY] ?? [],
        artifactRows: next[ARTIFACT_MODULE_KEY] ?? [],
        mode,
      })
      next[STORAGE_MODULE_KEY] = result.rows
      report = {
        status: 'migrated',
        mode,
        storageRows: result.rows.length,
        appendedCodes: result.appendedCodes,
        backfilledCodes: result.backfilledCodes,
        preserveCodes: result.preserveCodes,
        storedArtifacts: (next[ARTIFACT_MODULE_KEY] ?? []).filter(
          (row) => String(row.status) === '已入库',
        ).length,
        warning: result.warning,
      }
    }
  } catch (error) {
    resetCache()
    if (error instanceof BootstrapError) {
      lastError = error.diagnostics
      throw error
    }
    const diagnostics: BootstrapDiagnostics = {
      code: 'STORED_COUNT_MISMATCH',
      message: `初始化遇到未预期错误，未写入任何数据：${
        error instanceof Error ? error.message : String(error)
      }`,
      storageKey: storageKey(),
      bootstrapKey: BOOTSTRAP_META_KEY,
      version: BOOTSTRAP_VERSION,
      mode,
      timestamp: new Date().toISOString(),
      storedArtifacts: 0,
      occupiedArtifacts: 0,
      openCapacity: 0,
      appendingCodes: [],
      managedCodes: [],
      preserveCodes: [],
      reproduce: [
        `Console 执行 localStorage.getItem('${storageKey()}') 确认原始数据仍在`,
        `把上述 message 与 Console 堆栈一并反馈给现场支持`,
      ],
    }
    lastError = diagnostics
    throw new BootstrapError(diagnostics)
  }

  // 提交阶段：一次写入整批数据，再写版本标记；标记写失败则回滚整批。
  try {
    commitAll(next)
  } catch (error) {
    rollback(rawSnapshot)
    const diagnostics: BootstrapDiagnostics = {
      code: 'ROLLBACK_FAILED',
      message: `初始化数据写入失败，已整批回退：${
        error instanceof Error ? error.message : String(error)
      }`,
      storageKey: storageKey(),
      bootstrapKey: BOOTSTRAP_META_KEY,
      version: BOOTSTRAP_VERSION,
      mode,
      timestamp: new Date().toISOString(),
      storedArtifacts: report.storedArtifacts,
      occupiedArtifacts: 0,
      openCapacity: 0,
      appendingCodes: report.appendedCodes,
      managedCodes: report.backfilledCodes,
      preserveCodes: report.preserveCodes,
      reproduce: [
        `Console 执行 localStorage.getItem('${storageKey()}') 确认数据已回到打开前`,
        `检查浏览器存储是否被禁用或写满（隐私模式常见），处理后刷新重试`,
      ],
    }
    lastError = diagnostics
    throw new BootstrapError(diagnostics)
  }

  try {
    writeBootstrapMeta({ version: BOOTSTRAP_VERSION, mode, doneAt: new Date().toISOString() })
  } catch (error) {
    rollback(rawSnapshot)
    const diagnostics: BootstrapDiagnostics = {
      code: 'ROLLBACK_FAILED',
      message: '初始化数据已生成，但写入版本标记失败，已整批回退原始数据',
      storageKey: storageKey(),
      bootstrapKey: BOOTSTRAP_META_KEY,
      version: BOOTSTRAP_VERSION,
      mode,
      timestamp: new Date().toISOString(),
      storedArtifacts: report.storedArtifacts,
      occupiedArtifacts: 0,
      openCapacity: 0,
      appendingCodes: report.appendedCodes,
      managedCodes: report.backfilledCodes,
      preserveCodes: report.preserveCodes,
      reproduce: [
        `Console 执行 localStorage.getItem('${BOOTSTRAP_META_KEY}') 检查标记键`,
        `底层错误：${error instanceof Error ? error.message : String(error)}`,
      ],
    }
    lastError = diagnostics
    throw new BootstrapError(diagnostics)
  }

  return report
}
