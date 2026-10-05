<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      <span v-if="bootLine" :class="['boot-line', bootClass]">{{ bootLine }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { initReport, isDegraded } from '@/data/local-store'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])

const bootLine = computed(() => {
  const report = initReport()
  if (isDegraded()) {
    return '本地数据初始化异常：当前为内存退化模式，刷新后改动会丢失，详细复现步骤见 Console 的 [本地数据初始化] 日志'
  }
  if (!report) {
    return ''
  }
  if (report.mode === 'migrated') {
    return `本地数据已完成兼容初始化（迁移 ${report.changes.length} 处，告警 ${report.warnings.length} 条），详情见 Console 的 [本地数据初始化] 日志`
  }
  if (report.mode === 'fresh') {
    return `本地数据已按统一架位基线首次播种（${report.env}），架位 ${report.shelfCount} 个、已入库遗物 ${report.storedArtifactCount} 件`
  }
  return ''
})
const bootClass = computed(() => (isDegraded() ? 'boot-error' : 'boot-ok'))

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

onMounted(refresh)
</script>
