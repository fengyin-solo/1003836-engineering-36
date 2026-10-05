// ESM resolve 钩子（仅测试用）：
// - '@/...' 映射到 tsc 转译后的 src 目录（TS_TEST_SRC）；
// - 相对路径无扩展名时补 .js / /index.js；
// - TS_TEST_ITER 变化后对 src 下模块重新求值，隔离各测试场景的 store 单例。
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcDir = process.env.TS_TEST_SRC

function tryFile(base) {
  for (const candidate of [`${base}.js`, `${base}/index.js`]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  const iter = process.env.TS_TEST_ITER ?? '0'
  if (specifier.startsWith('@/')) {
    const hit = tryFile(`${srcDir}/${specifier.slice(2)}`)
    if (hit) {
      return { url: `${pathToFileURL(hit).href}?v=${iter}`, shortCircuit: true }
    }
    throw new Error(`测试 loader 无法解析 ${specifier}`)
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const parent = fileURLToPath(context.parentURL.split('?')[0])
    const base = new URL(specifier, pathToFileURL(parent).href)
    const path = fileURLToPath(base)
    if (!existsSync(path)) {
      const hit = tryFile(path)
      if (hit) {
        return { url: `${pathToFileURL(hit).href}?v=${iter}`, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}
