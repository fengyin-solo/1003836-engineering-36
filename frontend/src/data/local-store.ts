import { bootstrapData, DataInitError, type BootstrapReport } from './bootstrap'
import { SEED_ROWS } from './seed'
import { SCHEMA_VERSION } from './storage-plan'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 顶层信封带 __schemaVersion：没有版本号的旧库（v1 扁平结构）启动时一次性迁移，
// 迁移按架位编号回填容量与件数、只补缺不覆盖；初始化每台浏览器只提交一次。
const STORAGE_KEY = 'field-archaeology-digital:entries'
const CORRUPT_BACKUP_PREFIX = `${STORAGE_KEY}:corrupt:`

type PersistedEnvelope = {
  __schemaVersion: number
  rows: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: Record<string, EntryRow[]> | null = null
let lastReport: BootstrapReport | null = null
// 退化模式：原文损坏或存储不可写时，本会话改动只在内存，绝不覆盖现场原文。
let degraded = false
let degradedReason = ''

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function envLabel(): string {
  const env = import.meta.env
  const mode = String(env?.MODE ?? '')
  if (mode === 'preview') {
    return '构建预览(vite preview)'
  }
  return env?.DEV ? '本地开发(vite dev)' : '生产构建'
}

function buildContext() {
  return {
    env: envLabel(),
    origin:
      typeof window !== 'undefined' && window.location ? window.location.origin : '非浏览器环境',
    storageKey: STORAGE_KEY,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  }
}

function persist(rows: Record<string, EntryRow[]>): void {
  if (!hasStorage()) {
    return
  }
  const envelope: PersistedEnvelope = { __schemaVersion: SCHEMA_VERSION, rows }
  // 一次 setItem 提交整份信封：要么整批成功，要么抛异常，不会留下半批数据。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
}

function printReport(report: BootstrapReport): void {
  if (typeof console === 'undefined') {
    return
  }
  const tag = `[本地数据初始化] ${report.env} · ${report.mode}`
  if (report.mode === 'failed') {
    console.error(tag, report)
  } else if (report.warnings.length > 0 || report.changes.length > 0) {
    console.warn(tag, report)
  } else {
    console.info(tag, report)
  }
}

/**
 * 启动初始化（幂等，本会话只真正执行一次）：
 * 返回内存数据与本次初始化报告；损坏 / 写入失败时进入退化模式，不覆盖浏览器原文。
 */
export function ensureInitialized(): {
  data: Record<string, EntryRow[]>
  report: BootstrapReport
} {
  if (cache !== null && lastReport !== null) {
    return { data: cache, report: lastReport }
  }

  const storageReady = hasStorage()
  const raw = storageReady ? window.localStorage.getItem(STORAGE_KEY) : null

  let outcome
  try {
    outcome = bootstrapData(storageReady ? raw : null, buildContext())
  } catch (error) {
    if (!(error instanceof DataInitError)) {
      throw error
    }
    const report = error.report
    if (storageReady && raw !== null) {
      const backupKey = `${CORRUPT_BACKUP_PREFIX}${Date.now()}`
      try {
        window.localStorage.setItem(backupKey, raw)
        report.steps.push(
          `6. 损坏原文（${raw.length} 字符）已原样备份到键 ${backupKey}，可随时取回复盘`,
        )
      } catch {
        report.steps.push('6. 损坏原文备份失败（localStorage 可能已满），请用第 3 步手工导出原文')
      }
    }
    degraded = true
    degradedReason = error.message
    cache = clone(SEED_ROWS)
    lastReport = report
    printReport(report)
    return { data: cache, report }
  }

  const report = outcome.report
  if (report.mode === 'fresh' || report.mode === 'migrated') {
    try {
      persist(outcome.data)
    } catch (writeError) {
      // setItem 整体失败时浏览器内旧值原样保留（整批回退）；内存可用但标记为退化模式。
      degraded = true
      degradedReason = writeError instanceof Error ? writeError.message : String(writeError)
      report.mode = 'failed'
      report.warnings.push(
        `初始化结果写回浏览器存储失败（${degradedReason}）：现场旧数据未改动，本会话改动只保留在内存`,
      )
      report.steps = [
        ...report.steps,
        `7. 写回失败排查：${degradedReason}；常见原因为隐私模式/配额已满，可清掉无关键后刷新重试`,
      ]
      cache = outcome.data
      lastReport = report
      printReport(report)
      return { data: cache, report }
    }
  }

  cache = outcome.data
  lastReport = report
  printReport(report)
  return { data: cache, report }
}

export function allRows(): Record<string, EntryRow[]> {
  return ensureInitialized().data
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

/** 跨模块事务：遗物入藏要同时改 artifact 与 storage，合并成一次写入，避免只成功一半。 */
export function commitRows(updates: Record<string, EntryRow[]>): void {
  const { data } = ensureInitialized()
  const next = { ...data, ...updates }
  const previous = cache
  cache = next
  if (degraded) {
    console.warn(
      `[本地数据] 退化模式（${degradedReason}）：本次修改只保留在内存，未写入浏览器存储`,
    )
    return
  }
  try {
    persist(next)
  } catch (error) {
    // 写回失败：磁盘旧值本来就没动，内存也回滚到提交前，两边都不留半成品。
    cache = previous
    degraded = true
    degradedReason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `本地数据写回失败，已整批放弃并回滚内存改动，浏览器内旧值未动：${degradedReason}。` +
        `可在 Console 用 localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) 导出当前现场`,
    )
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function initReport(): BootstrapReport | null {
  return lastReport
}

export function isDegraded(): boolean {
  return degraded
}
