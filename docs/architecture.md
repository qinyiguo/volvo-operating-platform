# 技術架構

```
前端     HTML + Vanilla JS（無框架）
後端     Node.js + Express
資料庫   PostgreSQL
部署     Zeabur（GitHub 自動部署）
容器     Docker（node:20-alpine）
```

## 套件依賴

| 套件 | 用途 |
|------|------|
| `express` | Web 框架 |
| `pg` | PostgreSQL 連線 |
| `xlsx` | Excel 解析 |
| `multer` | 檔案上傳 |
| `cors` | 跨域設定 |
| `dotenv` | 環境變數 |

## 專案結構

```
volvo-upload-test/
├── index.js                  # 入口：Express 初始化 + 路由掛載
├── Dockerfile
├── package.json
│
├── db/
│   ├── pool.js               # PostgreSQL 連線池
│   └── init.js               # 啟動時自動建表（CREATE TABLE IF NOT EXISTS）
│
├── lib/
│   ├── utils.js              # 通用工具：pick / num / parseDate / detectBranch 等
│   ├── parsers.js            # Excel 資料列解析：各報表欄位對應
│   └── batchInsert.js        # 批次 INSERT 工具
│
├── routes/
│   ├── upload.js             # POST /api/upload（Excel 上傳）
│   ├── saConfig.js           # /api/sa-config/*（指標銷售設定）
│   ├── query.js              # /api/query/*、/api/counts、working-days、income-config
│   ├── techWage.js           # /api/tech-wage-config/*、/api/stats/tech-wage-matrix
│   ├── revenue.js            # /api/revenue-targets/*、/api/revenue-estimates/*（含週次提交）
│   ├── performance.js        # /api/performance-metrics/*、/api/performance-targets/*
│   ├── stats.js              # /api/stats/*（所有統計 API）
│   ├── auth.js               # /api/auth/settings/*（密碼驗證）
│   ├── bonus.js              # /api/bonus/*（獎金表相關）
│   ├── techHours.js          # /api/stats/tech-hours、tech-capacity-config、tech-turnover、tech-bay-config
│   ├── personTargets.js      # /api/person-targets/*
│   ├── wip.js                # /api/wip/status/*（WIP 工單狀態標記）
│   └── vctl.js               # /api/vctl/metrics/*、/api/stats/vctl（VCTL 商務政策指標）
│
└── public/
    ├── index.html            # 重導向至 performance.html
    ├── performance.html      # 業績指標與預估
    ├── stats.html            # 各廠明細
    ├── query.html            # 資料查詢
    ├── bonus.html            # 獎金表
    ├── settings.html         # 設定管理
    └── theme.css             # 深色／淺色主題共用樣式
```
