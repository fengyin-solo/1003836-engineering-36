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
- 想回到初始数据：清掉浏览器里 `field-archaeology-digital:entries` 这一项，或调用 `resetModule(模块)`。

## 本地数据的兼容初始化（架位容量）

库房架位带「容纳件数 / 当前件数」两个数值字段，启动时由 `src/data/bootstrap.ts`
做一次性兼容初始化，再由 `src/data/local-store.ts` 原子提交：

- 存储顶层是带 `__schemaVersion` 的信封。**首次打开**（本地开发 `vite dev` 与构建预览
  `vite preview` 端口、源不同，各自独立）整批播种 `src/data/storage-plan.ts` 里的同一份
  架位基线，两环境结果完全一致，不再各生成一套空架位。
- **已有浏览器存储**（旧版无版本号的扁平结构）启动时迁移，且只回填、不覆盖：
  存量架位按「架位编号」回填容量；「当前件数」由该架位上已入库（含新增「入藏架位」字段）
  的遗物数反算；已是数字（或数字字符串）的值一律视为用户改过而保留；基线缺失的架位按编号
  去重后整批补齐。台账与入藏记录对不上时只在报告里告警，不自动覆盖。
- 跨模块一致：出土遗物执行「办理入库」时，按架位编号选第一个未满且未封存的架位，
  遗物写入「入藏架位」、架位「当前件数」+1、到容量自动置「已满」；两侧在一次事务提交里完成，
  写回失败则磁盘旧值与内存改动一并回滚。库房/遗物页面顶部统计卡与工作台用同一套容量口径。
- 初始化每个浏览器只提交一次：再次打开命中当前版本直接放行，绝不追加重复架位。
  初始化失败（原文损坏、配额写满等）整批回退、保留损坏原文到
  `field-archaeology-digital:entries:corrupt:<时间戳>`，进入只读内存的退化模式，
  并在 Console 的 `[本地数据初始化]` 报告里给出环境、origin、存储键、失败原因与现场复现步骤。

验证：

```bash
cd frontend
npm run verify:bootstrap   # tsc 转译数据层后在 Node 跑全部兼容/迁移/回滚场景
npm run typecheck          # 含 .vue 模板的完整类型检查
```
