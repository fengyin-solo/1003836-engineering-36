import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'
// 启动初始化的台账：记录初始化版本，保证整批初始化一生只执行一次。
export const BOOTSTRAP_META_KEY = 'field-archaeology-digital:bootstrap'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export type EntriesMap = Record<string, EntryRow[]>

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

// 只做「读出来 + 解析」，不做任何播种，启动初始化用它判断存量数据的真实状态。
export function readRawEntries(): EntriesMap | null {
  const holder = storage()
  if (!holder) {
    return null
  }
  const raw = holder.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }
  return JSON.parse(raw) as EntriesMap
}

export function readBootstrapMeta(): { version: string; mode: string; doneAt: string } | null {
  const holder = storage()
  if (!holder) {
    return null
  }
  const raw = holder.getItem(BOOTSTRAP_META_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as { version: string; mode: string; doneAt: string }
  } catch {
    return null
  }
}

export function writeBootstrapMeta(meta: { version: string; mode: string; doneAt: string }): void {
  const holder = storage()
  if (holder) {
    holder.setItem(BOOTSTRAP_META_KEY, JSON.stringify(meta))
  }
}

// 整批落库：一个键、一次写入。启动初始化只允许通过这里提交，
// 任意一步校验失败都不调用它，旧存储保持原样，实现整批回退。
export function commitAll(next: EntriesMap): void {
  const holder = storage()
  if (holder) {
    holder.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

// 标记位需要单独写入：先落数据再落标记；标记写失败时由调用方负责回滚数据。
export function removeAll(): void {
  const holder = storage()
  if (holder) {
    holder.removeItem(STORAGE_KEY)
  }
  cache = null
}

// 只丢弃内存缓存，下次读取重新从 localStorage 装载；初始化失败回滚后用它，
// 绝不能碰磁盘上的用户数据。
export function resetCache(): void {
  cache = null
}

function readStorage(): EntriesMap {
  const fallback = clone(SEED_ROWS)
  const holder = storage()
  if (!holder) {
    return fallback
  }
  const raw = holder.getItem(STORAGE_KEY)
  if (!raw) {
    holder.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as EntriesMap
    return { ...fallback, ...parsed }
  } catch {
    holder.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: EntriesMap | null = null

export function allRows(): EntriesMap {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  const holder = storage()
  if (holder) {
    holder.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 跨模块动作（遗物入库要同时改遗物与架位）走批量提交：合并后一次写入，
// 不会出现遗物已入库、架位件数没加上的半成品状态。
export function saveRowsBatch(patch: Partial<EntriesMap>): EntriesMap {
  const next: EntriesMap = { ...allRows() }
  for (const [key, rows] of Object.entries(patch)) {
    if (rows) {
      next[key] = rows
    }
  }
  commitAll(next)
  return next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
