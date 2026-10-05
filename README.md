# 田野考古发掘数字化管理系统

面向考古发掘现场探方管理、地层记录、遗迹测绘、遗物登记、浮选采样与测年送检全流程的田野考古数字化管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 探方管理 | `trench` | 探方 | 探方编号、所属发掘区、探方尺寸 |
| 地层记录 | `stratum` | 地层 | 地层编号、所属探方、层位序号 |
| 遗迹单位 | `feature` | 遗迹 | 遗迹编号、所属探方、遗迹类型 |
| 出土遗物 | `artifact` | 出土遗物 | 器物编号、出土探方、出土层位 |
| 浮选采样 | `flotation` | 浮选样本 | 样本编号、采样单位、采样层位 |
| 测年送检 | `dating` | 测年送检单 | 送检编号、样品类型、采样单位 |
| 影像记录 | `photography` | 影像档案 | 影像编号、拍摄对象、拍摄类型 |
| 实测绘图 | `drawing` | 实测图纸 | 图纸编号、绘图对象、绘图类型 |
| 发掘日记 | `diary` | 发掘日记 | 日记编号、日期、当日气候 |
| 考古调查 | `survey` | 调查记录 | 调查编号、调查区域、调查方法 |
| 人骨鉴定 | `human_bone` | 人骨标本 | 标本编号、出土单位、鉴定部位 |
| 动物骨骼 | `animal_bone` | 动物骨骼标本 | 标本编号、出土单位、种属判定 |
| 陶器整理 | `pottery` | 陶器标本 | 标本编号、出土单位、器形类别 |
| 现场保护 | `conservation` | 保护处理记录 | 处理编号、保护对象、病害类型 |
| 三维坐标 | `coordinate` | 测点记录 | 测点编号、所属单位、坐标系 |
| 库房管理 | `storage` | 库房架位 | 架位编号、库房名称、存放器物类别 |
| 耗材管理 | `material` | 发掘耗材 | 耗材编号、耗材名称、规格型号 |
| 工地接待 | `visit` | 来访记录 | 来访编号、来访单位、来访人数 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `field-archaeology-digital:entries` 这一项（连同
  `field-archaeology-digital:bootstrap` 初始化标记一起删），或调用 `resetModule(模块)`。

### 库房架位容量初始化

库房架位的容量规范集中在 `frontend/src/data/storage-catalog.ts`（架位编号 → 容纳件数/层数/状态），
应用启动时由 `frontend/src/data/bootstrap.ts` 执行一次性整批初始化（`main.ts` 在挂载前调用）：

- **全新环境**（本地开发、构建预览首次打开）：按容量目录播种同一批标准架位，架位件数由已入库
  遗物数经统一分配算法推导，不同环境长出的架位完全一致。
- **已有浏览器存储**（历史环境）：按架位编号回填「容纳件数 / 当前件数」，缺失架位（如新增的
  `STOR-0004` 起）整批追加；用户已改成合法数字的容量与件数原样保留，不覆盖。
- **只执行一次**：版本标记写在 `field-archaeology-digital:bootstrap`，重复打开不再追加架位。
- **失败整批回退**：容量不足、件数超过容量、JSON 损坏等情况一律不写入，数据恢复到打开前原样，
  页面顶部红条给出错误码、两个 localStorage 键名与可复现的 Console 排查步骤。
- 出土遗物「办理入库」复用同一分配算法，遗物状态与架位件数一次批量提交；没有可放的正常架位时
  整单拒绝，不会出现遗物已入库、架位件数没加上的半成品。
