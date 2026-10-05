import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { ensureInitialized } from './data/local-store'
import './styles/global.css'

// 启动时先做一次性本地数据初始化：全新环境播种统一架位基线，历史浏览器存储按架位编号回填。
// 幂等：每个浏览器只提交一次；失败会整批回退并在 Console 输出现场复现步骤。
ensureInitialized()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
