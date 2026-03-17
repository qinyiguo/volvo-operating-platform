# Volvo DMS Dashboard

Volvo 經銷商管理系統（DMS）內部儀表板，用於追蹤三個據點（AMA、AMC、AMD）的服務營運數據。

## 功能總覽

| 頁面 | 說明 |
|------|------|
| **業績指標與預估** `/performance.html` | 四大營收達成率、集團合計、預估設定 |
| **各廠明細** `/stats.html` | 維修收入、技師工資、零件銷售、精品配件、SA 矩陣、每日進廠 |
| **資料查詢** `/query.html` | 四大資料表全文搜尋、排序、CSV 匯出 |
| **設定** `/settings.html` | Excel 上傳、指標設定、目標設定、工作天數、密碼管理 |

---

## 技術架構

```
前端     HTML + Vanilla JS（無框架）
後端     Node.js + Express
資料庫   PostgreSQL
部署     Zeabur（GitHub 自動部署）
容器     Docker（node:20-alpine）
```

---

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
│   ├── revenue.js            # /api/revenue-targets/*、/api/revenue-estimates/*
│   ├── performance.js        # /api/performance-metrics/*、/api/performance-targets/*
│   ├── stats.js              # /api/stats/*（所有統計 API）
│   └── auth.js               # /api/auth/settings/*（密碼驗證）
│
└── public/
    ├── index.html            # 重導向至 performance.html
    ├── performance.html      # 業績指標與預估
    ├── stats.html            # 各廠明細
    ├── query.html            # 資料查詢
    └── settings.html         # 設定管理
```

---

## 資料庫資料表

| 資料表 | 來源 | 說明 |
|--------|------|------|
| `repair_income` | 維修收入分類明細.xlsx | 工單收入、帳類、SA |
| `tech_performance` | 技師績效報表.xlsx | 技師工資、工時、工資代碼 |
| `parts_sales` | 零件銷售明細.xlsx | 零件銷售、種類、銷售人員 |
| `business_query` | 業務查詢.xlsx | 進廠工單、車輛資訊 |
| `parts_catalog` | 零配件比對.xlsx | 零件型錄（精品/配件判斷依據）|
| `sa_sales_config` | 手動設定 | SA 指標銷售追蹤設定 |
| `tech_wage_configs` | 手動設定 | 工資代碼追蹤設定 |
| `performance_metrics` | 手動設定 | 業績指標定義 |
| `performance_targets` | 手動設定 / Excel 匯入 | 各指標月目標與去年實績 |
| `revenue_targets` | 手動設定 / Excel 匯入 | 四大營收月目標與去年實績 |
| `revenue_estimates` | 手動設定 | 本月各營收預估值 |
| `working_days_config` | 手動設定 | 各據點每月實際營業日 |
| `income_config` | 手動設定 | 外賣收入對應的 category 值 |
| `app_settings` | 系統 | 管理員密碼等系統設定 |
| `upload_history` | 系統 | Excel 上傳紀錄 |

---

## Excel 上傳規則

檔名必須包含**據點代碼**和**期間**，系統自動辨識類型：

```
維修收入分類明細_AMA_202501.xlsx   → repair_income
技師績效報表_AMC_202501.xlsx       → tech_performance
零件銷售明細_AMD_202501.xlsx       → parts_sales
業務查詢_AMA_202501.xlsx           → business_query
零配件比對.xlsx                    → parts_catalog（無需據點/期間）
```

**上傳前會先刪除同據點同期間的舊資料**，再重新寫入。

---

## 主要 API

### 上傳

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/upload` | 上傳 Excel（最多 8 個，50MB 限制）|

### 統計

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/stats/repair` | 維修收入彙總 |
| GET | `/api/stats/income-summary` | 收入分類明細（含外賣）|
| GET | `/api/stats/income-breakdown` | 有費/無費收入分解 |
| GET | `/api/stats/tech` | 技師工資排名 |
| GET | `/api/stats/parts` | 零件銷售彙總 |
| GET | `/api/stats/boutique-accessories` | 精品配件銷售矩陣 |
| GET | `/api/stats/sa-sales-matrix` | SA 指標銷售矩陣 |
| GET | `/api/stats/tech-wage-matrix` | 工資代碼統計矩陣 |
| GET | `/api/stats/performance` | 業績指標達成率 |
| GET | `/api/stats/trend` | 月份趨勢 |
| GET | `/api/stats/daily` | 每日進廠台數 |

所有統計 API 支援 `?period=202501&branch=AMA` 查詢參數。

### 資料查詢

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/query/repair_income` | 維修收入明細（無筆數上限）|
| GET | `/api/query/tech_performance` | 技師績效明細 |
| GET | `/api/query/parts_sales` | 零件銷售明細 |
| GET | `/api/query/business_query` | 業務查詢明細 |
| GET | `/api/periods` | 取得所有有效期間清單 |

---

## 本地開發

### 需求

- Node.js 20+
- PostgreSQL 14+

### 啟動步驟

```bash
# 1. 安裝相依套件
npm install

# 2. 建立環境變數檔
cp .env.example .env
# 編輯 .env，填入資料庫連線字串

# 3. 啟動（會自動建表）
npm start
```

### 環境變數

```env
POSTGRES_CONNECTION_STRING=postgresql://user:password@localhost:5432/volvo_dms
PORT=3001
```

---

## 部署（Zeabur）

1. 推送到 GitHub `main` branch → Zeabur 自動觸發部署
2. 部署完成後，如有**資料表結構異動**，需重新上傳 Excel 讓資料寫入新表格
3. 不需要手動執行 SQL，`initDatabase()` 在每次啟動時自動處理建表與欄位補充

> **注意**：資料表結構異動（新增欄位）使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，不會影響現有資料。

---

## SA 銷售矩陣邏輯

篩選條件的組合方式：

- **同類型多個值** → OR（例如：零件類別碼 93 OR 94）
- **不同類型之間** → AND（例如：零件類別碼 93 AND 功能碼 1832）
- **人員分類**：`sales_person`（銷售人員）、`pickup_person`（技師施工）、`both`（同時出現在兩個分頁）

統計方式：`amount`（銷售金額）、`quantity`（銷售件數）、`count`（筆數）

---

## 已知維護重點

| 項目 | 位置 | 說明 |
|------|------|------|
| Excel 欄位對應 | `lib/parsers.js` | 各報表的中文欄位 alias 對應表 |
| 據點辨識 | `lib/utils.js → detectBranch()` | 從檔名取 AMA/AMC/AMD |
| 期間辨識 | `lib/utils.js → detectPeriod()` | 從檔名取 6 位數期間 |
| 建表 SQL | `db/init.js` | 新增資料表在此加 `CREATE TABLE IF NOT EXISTS` |
| 技師姓名正規化 | `routes/stats.js → canonicalExpr` | 處理斜線/空格/多人施工等情況 |
