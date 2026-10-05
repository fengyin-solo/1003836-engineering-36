import type { EntryRow } from './types'

// 库房架位容量方案：dev / 构建预览 / 已有浏览器存储共用同一份基线，
// 保证三个环境初始化出来的架位编号、容量完全一致，不再各生成一套空架位。

export const SCHEMA_VERSION = 2

/** 入藏遗物挂接架位用的字段（页面表格不展示，只参与跨模块对账）。 */
export const ARTIFACT_SHELF_FIELD = '入藏架位'
/** 架位编号字段名。 */
export const SHELF_CODE_FIELD = '架位编号'
export const SHELF_CAPACITY_FIELD = '容纳件数'
export const SHELF_COUNT_FIELD = '当前件数'

/** 入库后表示架位已满的状态；除「临时封存」外的架位都还能继续存放。 */
export const SHELF_FULL_STATUS = '已满'
export const SHELF_LOCKED_STATUS = '临时封存'

export type ShelfPlan = {
  /** 架位编号，回填与去重都以它为准。 */
  code: string
  /** 容量（容纳件数）。 */
  capacity: number
  /** 全新播种时架位上的初始件数，必须与初始入库遗物数对得上。 */
  seededCount: number
  /** 架位放满时的状态。 */
  fullStatus: string
  /** 全新播种 / 旧库补齐缺失架位时使用的状态。 */
  status: string
}

// 基线架位：STOR-0002 容量 2 且放满，用来验证「已满架位不再入藏」；
// seededCount 之和必须等于 seed.ts 里挂了「入藏架位」且状态为已入库的遗物数。
export const SHELF_PLANS: ShelfPlan[] = [
  { code: 'STOR-0001', capacity: 30, seededCount: 0, fullStatus: SHELF_FULL_STATUS, status: '正常使用' },
  { code: 'STOR-0002', capacity: 2, seededCount: 2, fullStatus: SHELF_FULL_STATUS, status: SHELF_FULL_STATUS },
  { code: 'STOR-0003', capacity: 40, seededCount: 0, fullStatus: SHELF_FULL_STATUS, status: '待整理' },
]

const SHELF_PLAN_BY_CODE: Map<string, ShelfPlan> = new Map(
  SHELF_PLANS.map((plan) => [plan.code, plan]),
)

export function shelfPlanOf(code: string): ShelfPlan | undefined {
  return SHELF_PLAN_BY_CODE.get(String(code ?? ''))
}

/** 未登记在基线里的架位（用户自建）补容量时用的默认值。 */
export const DEFAULT_SHELF_CAPACITY = 20

/** 把单元格转成件数：历史数据里可能是占位字符串，解析不了按 0 处理，不抛异常。 */
export function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

/** 是否为可参与计算的数字（数字或纯数字字符串）。 */
export function isNumericCell(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number.isFinite(Number(value))
  }
  return false
}

export function shelfCapacity(row: EntryRow): number {
  return toCount(row[SHELF_CAPACITY_FIELD])
}

export function shelfUsed(row: EntryRow): number {
  return toCount(row[SHELF_COUNT_FIELD])
}

/** 已满（件数到容量）或被封存的架位不能再入藏。 */
export function isShelfFull(row: EntryRow): boolean {
  if (String(row.status) === SHELF_LOCKED_STATUS) {
    return true
  }
  return shelfUsed(row) >= shelfCapacity(row)
}

/** 入藏目标架位选择顺序：按架位编号升序，取第一个放得下的。 */
export function pickShelfForArtifact(rows: EntryRow[]): EntryRow | undefined {
  return [...rows]
    .sort((a, b) => String(a[SHELF_CODE_FIELD]).localeCompare(String(b[SHELF_CODE_FIELD])))
    .find((row) => !isShelfFull(row))
}
