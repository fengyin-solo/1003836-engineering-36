/* eslint-disable no-console */
// 本地数据兼容初始化的验证脚本（配合 scripts/run-verify.sh）：
// - 纯逻辑场景（bootstrap 无状态）在本进程跑；
// - 涉及 local-store 单例的集成场景，各自 fork 一个子进程，
//   进程启动时固定 TS_TEST_ITER，ESM loader 据此给每个场景一份全新的模块图。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ENTRIES_KEY = 'field-archaeology-digital:entries'
const SRC = process.env.TS_TEST_SRC
const ITER = process.env.TS_TEST_ITER ?? '0'
if (!SRC) {
  console.error('缺少 TS_TEST_SRC 环境变量，请用 scripts/run-verify.sh 启动')
  process.exit(2)
}

function makeStorage({ throwOnSet = false } = {}) {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (throwOnSet) {
        throw new Error('QuotaExceededError: 模拟存储配额已满')
      }
      map.set(k, String(v))
    },
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
    _raw: (k = ENTRIES_KEY) => map.get(k) ?? null,
  }
}

async function loadModules() {
  const [service, store, bootstrap] = await Promise.all([
    import(pathToFileURL(`${SRC}/api/local-service.js`).href + `?v=${ITER}`),
    import(pathToFileURL(`${SRC}/data/local-store.js`).href + `?v=${ITER}`),
    import(pathToFileURL(`${SRC}/data/bootstrap.js`).href + `?v=${ITER}`),
  ])
  return { ...service, ...store, ...bootstrap }
}

let failures = 0
function assert(cond, name, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

function assertAll() {
  if (failures > 0) {
    process.exitCode = 1
  }
}

// ---------- 纯逻辑场景：不碰 window / store 单例 ----------
async function pureScenarios() {
  const { bootstrapData } = await loadModules()

  console.log('【1】fresh：首次打开整批播种')
  const ctx = { env: '本地开发(vite dev)', origin: 'http://127.0.0.1:5173', storageKey: ENTRIES_KEY, userAgent: 'node-test' }
  const f1 = bootstrapData(null, ctx)
  const freshEnvelope = JSON.stringify({ __schemaVersion: 2, rows: f1.data })
  assert(f1.report.mode === 'fresh', 'mode=fresh', f1.report.mode)
  assert(f1.data.storage.length === 3, '基线架位 3 个，无重复空架位', String(f1.data.storage.length))
  const s2 = f1.data.storage.find((r) => r['架位编号'] === 'STOR-0002')
  assert(s2['容纳件数'] === 2 && s2['当前件数'] === 2, 'STOR-0002 容量/件数为数字 2/2', JSON.stringify([s2['容纳件数'], s2['当前件数']]))
  assert(f1.data.artifact.filter((a) => a.status === '已入库').length === 2, '初始已入库遗物 2 件')
  assert(f1.report.storedArtifactCount === 2, '报告对账已入库 2 件', String(f1.report.storedArtifactCount))
  assert(f1.report.warnings.length === 0, 'fresh 无对账告警', JSON.stringify(f1.report.warnings))
  const f2 = bootstrapData(freshEnvelope, ctx)
  assert(f2.report.mode === 'current', '再次打开 mode=current', f2.report.mode)
  assert(f2.data.storage.length === 3, '重复打开不追加架位', String(f2.data.storage.length))

  console.log('【2】v1 历史扁平结构迁移：占位字符串回填，数字值不覆盖')
  const v1 = {
    storage: [
      { id: 1, status: '正常使用', pending: true, abnormal: false, '架位编号': 'STOR-0001', '容纳件数': '库房管理样例1', '当前件数': '库房管理样例1' },
      { id: 2, status: '已满', pending: false, abnormal: true, '架位编号': 'STOR-0002', '容纳件数': 5, '当前件数': 5 },
    ],
    artifact: [
      { id: 1, status: '已入库', '器物编号': 'ARTI-0001' },
      { id: 2, status: '已编号', '器物编号': 'ARTI-0002' },
    ],
    trench: [],
  }
  const m1 = bootstrapData(JSON.stringify(v1), ctx)
  assert(m1.report.mode === 'migrated', 'mode=migrated', m1.report.mode)
  const m0001 = m1.data.storage.find((r) => r['架位编号'] === 'STOR-0001')
  const m0002 = m1.data.storage.find((r) => r['架位编号'] === 'STOR-0002')
  assert(m0001['容纳件数'] === 30, 'STOR-0001 容量按编号回填 30', String(m0001['容纳件数']))
  assert(m0001['当前件数'] === 1, 'STOR-0001 件数按入藏遗物反算为 1', String(m0001['当前件数']))
  assert(m0002['容纳件数'] === 5 && m0002['当前件数'] === 5, '用户修改过的数字 5/5 不被覆盖')
  assert(m0002.status === '已满' && m0002.abnormal === true, '用户改过的状态/异常标记不动')
  const art1 = m1.data.artifact.find((a) => a.id === 1)
  assert(art1['入藏架位'] === 'STOR-0001', '无架位的入库遗物补挂到 STOR-0001', String(art1['入藏架位']))
  const m0003 = m1.data.storage.find((r) => r['架位编号'] === 'STOR-0003')
  assert(!!m0003 && m0003['容纳件数'] === 40, '缺失基线架位 STOR-0003 整批补齐')
  assert(m1.data.storage.length === 3, '补齐后共 3 个架位（不重复）', String(m1.data.storage.length))
  const migratedEnvelope = JSON.stringify({ __schemaVersion: 2, rows: m1.data })
  const m2 = bootstrapData(migratedEnvelope, ctx)
  assert(m2.report.mode === 'current' && m2.data.storage.length === 3, '迁移后重开不再追加')

  console.log('【3】用户已把占位值改成数字串时不覆盖')
  const v1b = { storage: [{ id: 9, status: '正常使用', pending: true, abnormal: false, '架位编号': 'STOR-X9', '容纳件数': '12', '当前件数': '7' }] }
  const m3 = bootstrapData(JSON.stringify(v1b), ctx)
  const x9 = m3.data.storage.find((r) => r['架位编号'] === 'STOR-X9')
  assert(x9['容纳件数'] === '12' && x9['当前件数'] === '7', '数字字符串原样保留（视为用户已修改）')

  console.log('【3b】旧版本号信封（__schemaVersion=1 + rows）同样走迁移，且其他模块数据保留')
  const wrapped = {
    __schemaVersion: 1,
    rows: {
      trench: [{ id: 7, status: '发掘中', pending: true, abnormal: false, '探方编号': 'TREN-USER' }],
      storage: [{ id: 1, status: '正常使用', pending: true, abnormal: false, '架位编号': 'STOR-0001', '容纳件数': '库房管理样例1', '当前件数': '库房管理样例1' }],
      artifact: [{ id: 1, status: '已入库', '器物编号': 'ARTI-0001' }],
    },
  }
  const mw = bootstrapData(JSON.stringify(wrapped), ctx)
  assert(mw.report.mode === 'migrated' && mw.report.fromVersion === 1, '包装旧版 mode=migrated / from=1', `${mw.report.mode}/${mw.report.fromVersion}`)
  assert(mw.data.trench[0]['探方编号'] === 'TREN-USER', '其他模块的用户数据原样保留')
  assert(mw.data.storage.find((r) => r['架位编号'] === 'STOR-0001')['容纳件数'] === 30, '包装结构里的架位容量同样回填')
  assert(mw.data.storage.length === 3, '包装结构同样按编号补齐缺失基线架位')

  console.log('【3c】未来版本（ahead）只读放行，不套用旧迁移')
  const ahead = { __schemaVersion: 99, rows: { storage: [{ id: 1, status: '正常使用', pending: true, abnormal: false, '架位编号': 'STOR-FUTURE', '容纳件数': 100, '当前件数': 0 }] } }
  const ma = bootstrapData(JSON.stringify(ahead), ctx)
  assert(ma.report.mode === 'ahead', 'mode=ahead', ma.report.mode)
  assert(ma.data.storage[0]['架位编号'] === 'STOR-FUTURE' && ma.data.storage.length === 1, '未来版本数据不迁移、不补齐')

  console.log('【4】损坏 JSON：抛 DataInitError，现场可复现信息齐全')
  let threw = null
  try {
    bootstrapData('{not-json', ctx)
  } catch (e) {
    threw = e
  }
  assert(!!threw && threw.name === 'DataInitError', '抛出 DataInitError')
  assert(threw.report.steps.some((s) => s.includes(ENTRIES_KEY)), '排查步骤含存储键与导出命令')
  assert(threw.report.steps.some((s) => s.includes('不是合法 JSON')), '排查步骤含失败原因与原文前缀')
  assertAll()
}

// ---------- 集成场景：每个 case 在独立子进程中运行 ----------
async function caseOnce({ mode }) {
  const mod = await loadModules()
  globalThis.navigator = { userAgent: 'node-test' }
  const ls = makeStorage()
  globalThis.window = {
    localStorage: ls,
    location: { origin: mode === 'development' ? 'http://127.0.0.1:5173' : 'http://127.0.0.1:4173' },
  }
  const r1 = mod.ensureInitialized()
  const rawAfter1 = ls._raw()
  const r2 = mod.ensureInitialized()
  assert(r2.report === r1.report, `${mode}: 同会话重复调用直接复用（不重复初始化）`)
  assert(ls._raw() === rawAfter1, `${mode}: 第二次调用不产生新写入`)
  assert(r1.data.storage.map((x) => `${x['架位编号']}:${x['容纳件数']}/${x['当前件数']}`).join(',') ===
    'STOR-0001:30/0,STOR-0002:2/2,STOR-0003:40/0', `${mode}: 架位基线一致`)
  assertAll()
}

async function caseAccession() {
  const mod = await loadModules()
  globalThis.navigator = { userAgent: 'node-test' }
  const ls = makeStorage()
  globalThis.window = { localStorage: ls, location: { origin: 'http://127.0.0.1:5173' } }
  mod.ensureInitialized()
  console.log('【6】遗物办理入库：跨模块一次提交，满架自动置满并改选下一架位')
  const res = mod.runAction('artifact', 3, '办理入库')
  assert(res.ok, '入库成功', res.message)
  const after = JSON.parse(ls._raw()).rows
  const a3 = after.artifact.find((x) => x.id === 3)
  const sh1 = after.storage.find((x) => x['架位编号'] === 'STOR-0001')
  assert(a3.status === '已入库' && a3['入藏架位'] === 'STOR-0001', '遗物挂到 STOR-0001', JSON.stringify(a3))
  assert(sh1['当前件数'] === 1, 'STOR-0001 件数变为 1', String(sh1['当前件数']))
  assert(sh1.status === '正常使用', '未满架位状态保持正常使用')
  // 封存 0003 后新增一件待入库遗物：0002 已满、0003 封存，新遗物必须避开它们落到 0001
  const rows = mod.listRows('storage')
  mod.saveRows('storage', rows.map((r) => r['架位编号'] === 'STOR-0003' ? { ...r, status: '临时封存' } : r))
  mod.saveRows('artifact', [...mod.listRows('artifact'), { id: 4, status: '已编号', pending: true, abnormal: false, '器物编号': 'ARTI-0004' }])
  const res2 = mod.runAction('artifact', 4, '办理入库')
  const env = JSON.parse(ls._raw()).rows
  const target4 = env.artifact.find((x) => x.id === 4)['入藏架位']
  assert(res2.ok && target4 === 'STOR-0001', '已满架位 STOR-0002 与封存架位 STOR-0003 都被跳过，落入 STOR-0001', `${res2.ok}/${target4}/${res2.message}`)
  assert(env.storage.find((x) => x['架位编号'] === 'STOR-0001')['当前件数'] === 2, 'STOR-0001 件数累加到 2')
  const res3 = mod.runAction('artifact', 3, '办理入库')
  assert(!res3.ok, '已入库遗物重复办理被拒绝', res3.message)
  // 0001 也封存后，所有架位都不可用 -> 整批拒绝，两边数据都不动
  mod.saveRows('storage', mod.listRows('storage').map((r) => r['架位编号'] === 'STOR-0001' ? { ...r, status: '临时封存' } : r))
  mod.saveRows('artifact', [...mod.listRows('artifact'), { id: 5, status: '已编号', pending: true, abnormal: false, '器物编号': 'ARTI-0005' }])
  const beforeEnv = ls._raw()
  const res4 = mod.runAction('artifact', 5, '办理入库')
  assert(!res4.ok && res4.message.includes('没有可入藏的架位'), '架位全满/封存时拒绝入藏', res4.message)
  assert(ls._raw() === beforeEnv, '拒绝时无任何写入')
  assertAll()
}

async function caseWriteFailBoot() {
  const mod = await loadModules()
  globalThis.navigator = { userAgent: 'node-test' }
  const ls = makeStorage({ throwOnSet: true })
  globalThis.window = { localStorage: ls, location: { origin: 'http://127.0.0.1:5173' } }
  console.log('【7】存储写回失败：整批回退，磁盘旧值不动，进入退化模式')
  const r = mod.ensureInitialized()
  assert(mod.isDegraded(), '首次播种写不进 -> 退化模式')
  assert(r.report.mode === 'failed', '报告标记 failed', r.report.mode)
  assert(ls._raw() === null, '磁盘保持空白旧值，无半批写入')
  // 退化模式下用一件新遗物验证内存操作仍可完成（seed 中 id3 未入库）
  const res = mod.runAction('artifact', 3, '办理入库')
  assert(res.ok, '退化模式下内存操作仍可完成', res.message)
  assert(ls._raw() === null, '磁盘依旧没有半批数据')
  assertAll()
}

async function caseAtomicRollback() {
  const mod = await loadModules()
  globalThis.navigator = { userAgent: 'node-test' }
  const ls = makeStorage()
  globalThis.window = { localStorage: ls, location: { origin: 'http://127.0.0.1:5173' } }
  console.log('【8】运行期跨模块写回失败：磁盘与内存都整批回滚')
  mod.ensureInitialized()
  // 启动播种在 ensureInitialized() 内部已经完成；这里替换后，运行期的下一次写入即失败。
  ls.setItem = () => {
    throw new Error('QuotaExceededError: 模拟运行期写满')
  }
  const res = mod.runAction('artifact', 3, '办理入库')
  assert(!res.ok && res.message.includes('整批'), '失败结果带回现场排查提示', res.message)
  const env = JSON.parse(ls._raw()).rows
  const a3 = env.artifact.find((x) => x.id === 3)
  assert(a3.status === '已编号' && a3['入藏架位'] === undefined, '磁盘里遗物未变')
  assert(env.storage.find((x) => x['架位编号'] === 'STOR-0001')['当前件数'] === 0, '磁盘里架位件数未变')
  assert(mod.listRows('artifact').find((x) => x.id === 3).status === '已编号', '内存中遗物也回滚')
  assertAll()
}

async function caseCorrupt() {
  const mod = await loadModules()
  globalThis.navigator = { userAgent: 'node-test' }
  const ls = makeStorage()
  ls.setItem(ENTRIES_KEY, '<<<损坏>>>')
  globalThis.window = { localStorage: ls, location: { origin: 'http://127.0.0.1:5173' } }
  console.log('【9】损坏原文初始化：原文备份保留，示例数据内存可用')
  const r = mod.ensureInitialized()
  assert(mod.isDegraded() && r.report.mode === 'failed', '进入退化 failed 模式')
  const dumps = ls._dump()
  const backupKey = Object.keys(dumps).find((k) => k.startsWith(`${ENTRIES_KEY}:corrupt:`))
  assert(!!backupKey && dumps[backupKey] === '<<<损坏>>>', '损坏原文原样备份，便于复现')
  assert(r.data.storage.length === 3, '内存仍有完整基线可继续操作')
  assertAll()
}

const CASES = {
  onceDev: () => caseOnce({ mode: 'development' }),
  oncePreview: () => caseOnce({ mode: 'preview' }),
  accession: caseAccession,
  writeFailBoot: caseWriteFailBoot,
  atomicRollback: caseAtomicRollback,
  corrupt: caseCorrupt,
}

async function main() {
  const [, , verb, name] = process.argv
  if (verb === 'case') {
    console.log(`【5-${name}】子进程场景 ${name}（ITER=${ITER}）`)
    await CASES[name]()
    return
  }

  // 父进程：先跑纯逻辑，再逐个 fork 集成场景。
  await pureScenarios()

  const children = ['onceDev', 'oncePreview', 'accession', 'writeFailBoot', 'atomicRollback', 'corrupt']
  let childFailures = 0
  children.forEach((caseName, index) => {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--loader', pathToFileURL(`${process.cwd()}/scripts/ts-alias-loader.mjs`).href,
        process.argv[1], 'case', caseName],
      {
        env: { ...process.env, TS_TEST_ITER: String(index + 10) },
        encoding: 'utf8',
      },
    )
    process.stdout.write(result.stdout)
    if (result.stderr) {
      process.stderr.write(result.stderr.split('\n').filter((line) => !line.includes('ExperimentalWarning')).join('\n'))
    }
    if (result.status !== 0) {
      childFailures += 1
      console.error(`  ✗ 子场景 ${caseName} 失败（退出码 ${result.status}）`)
    }
  })

  if (failures > 0 || childFailures > 0) {
    console.error(`\n${failures + childFailures} 组断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
