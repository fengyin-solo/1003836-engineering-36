import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  resetRows,
  saveRows,
  saveRowsBatch,
} from '@/data/local-store'
import {
  ARTIFACT_MODULE_KEY,
  ARTIFACT_STORED_STATUS,
  CURRENT_FIELD,
  SHELF_CODE_FIELD,
  SHELF_FULL,
  SHELF_OPEN_STATUS,
  STORAGE_MODULE_KEY,
  capacityOf,
  currentCountOf,
  planAllocation,
} from '@/data/storage-catalog'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated

  // 跨模块联动：遗物办理入库时，用与启动初始化完全相同的分配算法占用一个架位，
  // 架位件数与遗物状态一次批量提交；没有可放的架位就整单失败，两件事都不发生。
  let storageNote = ''
  if (key === ARTIFACT_MODULE_KEY && target === ARTIFACT_STORED_STATUS) {
    const shelves = listRows(STORAGE_MODULE_KEY).map((row) => ({ ...row }))
    const allocation = planAllocation(shelves, 1)
    if (allocation.remaining > 0) {
      return {
        ok: false,
        message: '没有可接收的正常使用架位（全部已满、待整理或封存），遗物未入库；请先在库房管理中腾出容量',
      }
    }
    const plan = allocation.plans[0]
    const shelfIndex = shelves.findIndex((row) => Number(row.id) === plan.rowId)
    if (shelfIndex < 0) {
      return { ok: false, message: '入库架位定位失败，遗物未入库' }
    }
    const shelf = shelves[shelfIndex]
    shelf[CURRENT_FIELD] = plan.after
    const derived = plan.after >= capacityOf(shelf) ? SHELF_FULL : String(shelf.status)
    shelf.status = derived
    if ('架位状态' in shelf) {
      shelf.架位状态 = derived
    }
    shelf.pending = derived === SHELF_OPEN_STATUS
    saveRowsBatch({ [ARTIFACT_MODULE_KEY]: next, [STORAGE_MODULE_KEY]: shelves })
    storageNote = `，已存入架位 ${String(shelf[SHELF_CODE_FIELD])}（${plan.after}/${capacityOf(shelf)} 件${
      plan.becameFull ? '，架位已满' : ''
    }）`
  } else {
    saveRows(key, next)
  }
  return {
    ok: true,
    message: `${meta.entity}已${action}，当前状态「${target}」${storageNote}`,
  }
}

// 库房工作台统计：直接读架位真实件数，与遗物入藏结果同源。
export function storageStats(rows: EntryRow[] = listRows(STORAGE_MODULE_KEY)) {
  const total = rows.length
  const full = rows.filter((row) => String(row.status) === SHELF_FULL).length
  const available = rows.filter(
    (row) => String(row.status) === SHELF_OPEN_STATUS && currentCountOf(row) < capacityOf(row),
  ).length
  return { total, full, available }
}

// 出土遗物工作台统计：已入库数必须等于库房架位件数合计，两处显示始终对得上。
export function artifactStats(rows: EntryRow[] = listRows(ARTIFACT_MODULE_KEY)) {
  const total = rows.length
  const stored = rows.filter((row) => String(row.status) === ARTIFACT_STORED_STATUS).length
  const pendingWash = rows.filter((row) => String(row.status) === '已采集').length
  return { total, stored, pendingWash }
}

// 供页面/自检核对：架位当前件数合计与已入库遗物数应保持一致。
export function storageCountConsistency(): { stored: number; occupied: number; consistent: boolean } {
  const stored = listRows(ARTIFACT_MODULE_KEY).filter(
    (row) => String(row.status) === ARTIFACT_STORED_STATUS,
  ).length
  const occupied = listRows(STORAGE_MODULE_KEY).reduce((sum, row) => sum + currentCountOf(row), 0)
  return { stored, occupied, consistent: stored === occupied }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
