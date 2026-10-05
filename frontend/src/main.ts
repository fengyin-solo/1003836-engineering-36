import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { BootstrapError, runBootstrap } from './data/bootstrap'
import './styles/global.css'

// 启动初始化必须发生在任何数据读取之前：
// 首次播种 / 存量架位容量回填整批只做一次，失败也在这里统一兜底。
try {
  const report = runBootstrap()
  if (import.meta.env?.DEV && report.status !== 'skipped') {
    // 本地开发时把初始化结果打到控制台，方便现场核对追加与回填清单。
    console.info('[bootstrap] 库房架位初始化完成', report)
  }
} catch (error) {
  if (error instanceof BootstrapError) {
    console.error('[bootstrap] 库房架位初始化失败，已整批回退', error.diagnostics)
  } else {
    console.error('[bootstrap] 库房架位初始化失败', error)
  }
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
