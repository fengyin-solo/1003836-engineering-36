import type { EntryRow } from './types'

// 架位容量目录：架位编号到容量规范的唯一来源。
// 首次播种、存量浏览器存储回填、遗物「办理入库」三处都用同一份定义，
// 保证本地开发、构建预览与历史环境算出来的架位和件数一致。

export const STORAGE_MODULE_KEY = 'storage'
export const ARTIFACT_MODULE_KEY = 'artifact'
export const SHELF_CODE_FIELD = '架位编号'
export const CAPACITY_FIELD = '容纳件数'
export const CURRENT_FIELD = '当前件数'
export const LAYER_FIELD = '架位层数'

export const SHELF_NORMAL = '正常使用'
export const SHELF_FULL = '已满'
export const SHELF_TIDY = '待整理'
export const SHELF_SEALED = '临时封存'

// 只有「正常使用」的架位还能继续接收遗物；已满、待整理、临时封存都不参与分配。
export const SHELF_OPEN_STATUS = SHELF_NORMAL
export const ARTIFACT_STORED_STATUS = '已入库'

// 与库房管理模块 statuses 对齐，用于推导件数到顶后的状态。
export const STORAGE_STATUSES = [SHELF_NORMAL, SHELF_FULL, SHELF_TIDY, SHELF_SEALED]

export type ShelfSpec = {
  code: string
  capacity: number
  layers: number
  baseStatus: string
  category: string
}

// 标准架位：历史环境的 STOR-0001..0003 也在其中，按架位编号回填时能一一对上。
// 容量按架位编号固定，同一份构建在任何环境首次打开都长出完全相同的架位。
export const SHELF_CATALOG: ShelfSpec[] = [
  { code: 'STOR-0001', capacity: 20, layers: 3, baseStatus: SHELF_NORMAL, category: '出土遗物' },
  { code: 'STOR-0002', capacity: 1, layers: 4, baseStatus: SHELF_NORMAL, category: '陶器标本' },
  { code: 'STOR-0003', capacity: 40, layers: 2, baseStatus: SHELF_TIDY, category: '待整理器物' },
  { code: 'STOR-0004', capacity: 50, layers: 5, baseStatus: SHELF_NORMAL, category: '出土遗物' },
  { code: 'STOR-0005', capacity: 50, layers: 5, baseStatus: SHELF_NORMAL, category: '出土遗物' },
  { code: 'STOR-0006', capacity: 30, layers: 3, baseStatus: SHELF_NORMAL, category: '动物骨骼' },
  { code: 'STOR-0007', capacity: 30, layers: 3, baseStatus: SHELF_NORMAL, category: '人骨标本' },
  { code: 'STOR-0008', capacity: 60, layers: 6, baseStatus: SHELF_NORMAL, category: '影像图纸' },
  { code: 'STOR-0009', capacity: 25, layers: 2, baseStatus: SHELF_SEALED, category: '封存器物' },
]

const SPEC_BY_CODE = new Map(SHELF_CATALOG.map((spec) => [spec.code, spec]))
const DEFAULT_CAPACITY = 50
const DEFAULT_LAYERS = 3

export function specForCode(code: string): ShelfSpec | undefined {
  return SPEC_BY_CODE.get(code)
}

export function defaultCapacity(): number {
  return DEFAULT_CAPACITY
}

export function defaultLayers(): number {
  return DEFAULT_LAYERS
}

// 编号末尾序号决定展示与分配顺序（STOR-0002 排在 STOR-0010 前面）。
export function shelfCodeOrder(code: string): number {
  const matched = /(\d+)\s*$/.exec(String(code ?? ''))
  return matched ? Number(matched[1]) : Number.POSITIVE_INFINITY
}

export function sortByShelfCode(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort(
    (a, b) => shelfCodeOrder(String(a[SHELF_CODE_FIELD])) - shelfCodeOrder(String(b[SHELF_CODE_FIELD])),
  )
}

export function toNonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
}

export function capacityOf(row: EntryRow): number {
  return toNonNegativeInt(row[CAPACITY_FIELD]) ?? DEFAULT_CAPACITY
}

export function currentCountOf(row: EntryRow): number {
  return toNonNegativeInt(row[CURRENT_FIELD]) ?? 0
}

// 可继续放遗物的架位：状态为「正常使用」且当前件数没到容量。
export function isOpenShelf(row: EntryRow): boolean {
  return String(row.status) === SHELF_OPEN_STATUS && currentCountOf(row) < capacityOf(row)
}

export function countStoredArtifacts(artifacts: EntryRow[]): number {
  return artifacts.filter((row) => String(row.status) === ARTIFACT_STORED_STATUS).length
}

// 件数到顶后状态显示「已满」，否则回到架位的基础状态。
export function statusForShelf(baseStatus: string, current: number, capacity: number): string {
  if (current >= capacity) {
    return SHELF_FULL
  }
  return baseStatus
}

export type AllocationPlan = {
  rowId: number
  code: string
  assigned: number
  before: number
  after: number
  becameFull: boolean
}

// 把指定数量的遗物按架位编号顺序灌进仍可接收的架位，返回每个架位的增量。
// 启动回填和跨模块入藏共用这一个算法，两边结果必然一致。
export function planAllocation(
  rows: EntryRow[],
  amount: number,
): { plans: AllocationPlan[]; remaining: number } {
  let remaining = amount
  const plans: AllocationPlan[] = []
  for (const row of sortByShelfCode(rows)) {
    if (remaining <= 0) {
      break
    }
    if (!isOpenShelf(row)) {
      continue
    }
    const before = currentCountOf(row)
    const space = capacityOf(row) - before
    if (space <= 0) {
      continue
    }
    const assigned = Math.min(space, remaining)
    const after = before + assigned
    remaining -= assigned
    plans.push({
      rowId: Number(row.id),
      code: String(row[SHELF_CODE_FIELD]),
      assigned,
      before,
      after,
      becameFull: after >= capacityOf(row),
    })
  }
  return { plans, remaining }
}

// 按容量目录生成标准架位，当前件数与状态完全由「已入库遗物数」推导：
// 同一份目录 + 同一批遗物，在任何环境都得到同一批架位。
export function buildSeedStorageRows(storedCount: number): EntryRow[] {
  const rows: EntryRow[] = SHELF_CATALOG.map((spec, index) => ({
    id: index + 1,
    status: spec.baseStatus,
    pending: spec.baseStatus === SHELF_NORMAL,
    abnormal: false,
    [SHELF_CODE_FIELD]: spec.code,
    库房名称: '一号库房',
    存放器物类别: spec.category,
    架位层数: spec.layers,
    [CAPACITY_FIELD]: spec.capacity,
    [CURRENT_FIELD]: 0,
    管理人: '库房管理员',
    架位状态: spec.baseStatus,
  }))
  const { plans, remaining } = planAllocation(rows, storedCount)
  if (remaining > 0) {
    // 目录自身的总容量都装不下，说明目录配置有误，属于构建期问题而不是用户数据问题。
    throw new Error(`标准架位总容量不足：还有 ${remaining} 件已入库遗物无法安排架位`)
  }
  for (const plan of plans) {
    const row = rows.find((item) => Number(item.id) === plan.rowId)
    if (!row) {
      continue
    }
    row[CURRENT_FIELD] = plan.after
    row.status = statusForShelf(String(row.status), plan.after, capacityOf(row))
    row.架位状态 = row.status
    row.pending = row.status === SHELF_NORMAL
  }
  return rows
}
