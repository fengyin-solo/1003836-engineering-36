<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">田野考古发掘数字化管理系统</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <div v-if="bootstrapError" class="bootstrap-banner" role="alert">
        <div class="bootstrap-head">
          <strong>库房架位初始化失败，已整批回退，未改动任何本地记录</strong>
          <button class="btn" type="button" @click="retryBootstrap">重试初始化</button>
        </div>
        <p class="bootstrap-line">
          错误码 {{ bootstrapError.code }}：{{ bootstrapError.message }}
        </p>
        <p class="bootstrap-line muted">
          版本 {{ bootstrapError.version }} · 环境 {{ bootstrapError.mode }} ·
          数据键 {{ bootstrapError.storageKey }} · 标记键 {{ bootstrapError.bootstrapKey }} ·
          时间 {{ bootstrapError.timestamp }}
        </p>
        <p class="bootstrap-line muted">
          追加架位：{{ bootstrapError.appendingCodes.join('、') || '无' }} ｜
          回填架位：{{ bootstrapError.managedCodes.join('、') || '无' }} ｜
          保留架位：{{ bootstrapError.preserveCodes.join('、') || '无' }}
        </p>
        <ul class="bootstrap-steps">
          <li v-for="step in bootstrapError.reproduce" :key="step">{{ step }}</li>
        </ul>
      </div>
      <header class="app-head">
        <span class="head-desc">面向考古发掘现场探方管理、地层记录、遗迹测绘、遗物登记、浮选采样与测年送检全流程的田野考古数字化管理平台。</span>
        <span class="head-user">当前值班：{{ store.operator }} · {{ store.shiftLabel }}</span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import {
  clearBootstrapError,
  lastBootstrapError,
  runBootstrap,
  type BootstrapDiagnostics,
} from '@/data/bootstrap'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const bootstrapError = ref<BootstrapDiagnostics | null>(lastBootstrapError())

function retryBootstrap() {
  clearBootstrapError()
  try {
    runBootstrap()
    bootstrapError.value = null
  } catch {
    bootstrapError.value = lastBootstrapError()
  }
}

const navItems = [{ label: "运营概览", path: "/" }, { label: "探方管理", path: "/trench" }, { label: "地层记录", path: "/stratum" }, { label: "遗迹单位", path: "/feature" }, { label: "出土遗物", path: "/artifact" }, { label: "浮选采样", path: "/flotation" }, { label: "测年送检", path: "/dating" }, { label: "影像记录", path: "/photography" }, { label: "实测绘图", path: "/drawing" }, { label: "发掘日记", path: "/diary" }, { label: "考古调查", path: "/survey" }, { label: "人骨鉴定", path: "/human_bone" }, { label: "动物骨骼", path: "/animal_bone" }, { label: "陶器整理", path: "/pottery" }, { label: "现场保护", path: "/conservation" }, { label: "三维坐标", path: "/coordinate" }, { label: "库房管理", path: "/storage" }, { label: "耗材管理", path: "/material" }, { label: "工地接待", path: "/visit" }]
</script>

<style scoped>
.bootstrap-banner {
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid #b42318;
  border-radius: 8px;
  background: #fef3f2;
  color: #7a271a;
  font-size: 13px;
}
.bootstrap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.bootstrap-line {
  margin: 4px 0;
}
.bootstrap-line.muted {
  color: #915a4f;
  word-break: break-all;
}
.bootstrap-steps {
  margin: 6px 0 0;
  padding-left: 18px;
}
.bootstrap-steps li {
  margin: 2px 0;
}
</style>
