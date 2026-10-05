import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ARTIFACT_SHELF_FIELD,
  SHELF_CAPACITY_FIELD,
  SHELF_CODE_FIELD,
  SHELF_COUNT_FIELD,
  SHELF_FULL_STATUS,
  isShelfFull,
  pickShelfForArtifact,
  shelfCapacity,
  shelfUsed,
} from '@/data/storage-plan'
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

  // 跨模块联动：遗物办理入库的同时占用一个架位，两边在一次提交里改完。
  if (key === 'artifact' && action === '办理入库') {
    return accessionArtifact(rows[index], { pending: '已入库' !== lastStatus })
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '本地数据写回失败，已整批放弃' }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 遗物入藏：按架位编号升序选第一个未满且未封存的架位，
 * 架位「当前件数」+1，到容量后架位状态置「已满」；遗物与架位一次事务提交。
 * 结果与启动时架位初始化用同一套容量规则，库房台账与遗物入藏记录对得上。
 */
function accessionArtifact(artifact: EntryRow, opts: { pending: boolean }): ActionResult {
  const artifactRows = listRows('artifact')
  const shelfRows = listRows('storage')
  const target = pickShelfForArtifact(shelfRows)
  if (!target) {
    return { ok: false, message: '没有可入藏的架位：架位全部已满或已封存，请先在库房管理中整理出库' }
  }
  const shelfIndex = shelfRows.findIndex(
    (row) => String(row[SHELF_CODE_FIELD]) === String(target[SHELF_CODE_FIELD]),
  )
  const code = String(target[SHELF_CODE_FIELD])
  const used = shelfUsed(target)
  const capacity = shelfCapacity(target)
  const updatedShelf: EntryRow = {
    ...target,
    [SHELF_COUNT_FIELD]: used + 1,
  }
  if (used + 1 >= capacity) {
    updatedShelf.status = SHELF_FULL_STATUS
  }
  const updatedArtifact: EntryRow = {
    ...artifact,
    status: '已入库',
    pending: opts.pending,
    abnormal: false,
    [ARTIFACT_SHELF_FIELD]: code,
  }
  const nextArtifacts = artifactRows.map((row) =>
    Number(row.id) === Number(artifact.id) ? updatedArtifact : row,
  )
  const nextShelves = [...shelfRows]
  nextShelves[shelfIndex] = updatedShelf
  try {
    commitRows({ artifact: nextArtifacts, storage: nextShelves })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '入藏写回失败，架位与遗物均未改动' }
  }
  const capacityNote = used + 1 >= capacity ? '，该架位已满' : `，架位剩余容量 ${capacity - used - 1}`
  return {
    ok: true,
    message: `出土遗物已办理入库，入藏架位「${code}」，当前件数 ${used + 1}/${capacity}${capacityNote}`,
  }
}

/** 库房管理工作台指标：满架 / 可用按容量计算，与入藏占用同一规则。 */
export function storageStats(): { total: number; full: number; available: number } {
  const rows = listRows('storage')
  return {
    total: rows.length,
    full: rows.filter((row) => {
      if (String(row.status) === SHELF_FULL_STATUS) {
        return true
      }
      return isShelfFull(row)
    }).length,
    available: rows.filter((row) => !isShelfFull(row)).length,
  }
}

/** 出土遗物工作台指标：已入库数与库房台账口径一致（含入藏架位记录）。 */
export function artifactStats(): { total: number; stored: number; pendingWash: number } {
  const rows = listRows('artifact')
  return {
    total: rows.length,
    stored: rows.filter((row) => String(row.status) === '已入库').length,
    pendingWash: rows.filter((row) => String(row.status) === '已采集').length,
  }
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
