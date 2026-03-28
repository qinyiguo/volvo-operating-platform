# Volvo DMS Dashboard — 技術文件

> 內部儀表板，追蹤 AMA、AMC、AMD 三個據點（及聯合服務中心、鈑烤廠）的服務營運數據。

---

## 目錄

1. [系統概覽](#系統概覽)
2. [技術架構](#技術架構)
3. [專案結構](#專案結構)
4. [頁面功能](#頁面功能)
5. [資料庫資料表](#資料庫資料表)
6. [API 文件](#api-文件)
7. [Excel 上傳規則](#excel-上傳規則)
8. [核心業務邏輯](#核心業務邏輯)
9. [部署指南](#部署指南)
10. [本地開發](#本地開發)
11. [已知維護重點](#已知維護重點)
12. [術語對照](#術語對照)

---

## 系統概覽

| 頁面 | 路徑 | 說明 |
|------|------|------|
| 業績指標與預估 | `/performance.html` | 四大營收達成率、集團合計、業績預估（Modal 週次提交）、VCTL 商務政策指標 |
| 各廠明細 | `/stats.html` | 維修收入、單車銷售額、個人業績、零件銷售、精品配件、指標銷售、趨勢、每日進廠、WIP、技師工時、施工周轉率 |
| 資料查詢 | `/query.html` | 四大資料表全文搜尋、排序、CSV 匯出 |
| 獎金表 | `/bonus.html` | 人員名冊、獎金指標設定、獎金進度計算（密碼保護） |
| 設定 | `/settings.html` | Excel 上傳、指標設定、目標設定、工作天數、工位設定、密碼管理（密碼保護） |

---

## 技術架構

```
前端     HTML + Vanilla JS（無框架）
後端     Node.js + Express
資料庫   PostgreSQL
部署     Zeabur（GitHub 自動部署）
容器     Docker（node:20-alpine）
```

### 套件依賴

| 套件 | 用途 |
|------|------|
| `express` | Web 框架 |
| `pg` | PostgreSQL 連線 |
| `xlsx` | Excel 解析 |
| `multer` | 檔案上傳 |
| `cors` | 跨域設定 |
| `dotenv` | 環境變數 |

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

---

## 頁面功能

### `/performance.html` — 業績指標與預估

- **工作天進度條**：天數進度 vs 有費達成率，含集團大卡與三廠分卡（超前 / 符合 / 落後判斷）
- **有費 KPI 卡片**：集團合計（一般＋鈑烤＋延保）＋各廠拆分，含去年同期 YoY
- **收入明細分解表**：一般、保險、延保、票券、外賣、有費小計、無費成本
- **各指標業績進度**：依 `performance_metrics` 設定，顯示實際 vs 目標 vs 去年
- **業績預估 Modal**：每週可提交一次預估值（週次鎖定），含歷史紀錄分頁；有費欄位自動加總一般＋鈑烤＋延保
- **VCTL 商務政策指標**：自訂指標來源（零件 / 配件 / 精品 / 工資），顯示售價、成本、毛利率

### `/stats.html` — 各廠明細

| 分頁 | 功能 |
|------|------|
| 維修收入 | 有費/無費收入摘要、SA 業績排名、帳類分析 |
| 單車銷售額 | 依保養/維修/自費鈑烤/延保/保險分類的車均銷售額 |
| 個人業績 | SA 個人達成率（維修服務科 / 承保理賠科 / 客戶服務科），支援科別占比、拖曳排序、Excel 匯出 |
| 零件銷售 | 種類彙總、Top 20 零件 |
| 精品配件 | 精品/配件銷售矩陣（需零件型錄） |
| 指標銷售 | SA 銷售人員/技師施工雙視角矩陣 |
| 月份趨勢 | 各月份維修收入趨勢 |
| 每日進廠 | 日均台數、日均線切換、天數進度 |
| WIP 未結工單 | 依進廠月份/維修類型統計，支援 PDI 標記，可行內填寫工單狀態（等料/施工中/已可結帳…） |
| 技師工時 | 依人員名冊計算目標工時 vs 實際工時（工資回推），含折扣還原 |
| 施工周轉率 | 引電台次 ÷ 技師人數 ÷ 工作天，集團鈑烤周轉率；工位承接率（需設定工位數） |

### `/bonus.html` — 獎金表（密碼保護）

- **人員名單**：依廠別/部門顯示在職/留職停薪/本月離職人員，支援廠別調整
- **獎金名單**：依指標設定計算各人員達成率與應領獎金；auto 指標自動套用所有人
- **獎金指標管理**：設定 DMS 來源（維修收入 / 技師工資 / 零件銷售 / 連結業績指標 / 連結營收目標）、職稱分層獎金階梯、部門篩選、計算據點覆蓋

### `/query.html` — 資料查詢

- 四大資料表（維修收入 / 技師工資 / 零件銷售 / 業務查詢）
- 篩選、排序、關鍵字搜尋、欄位切換、分頁（50/100/200/500）
- CSV 匯出（帶 BOM，支援中文）

### `/settings.html` — 設定（密碼保護）

| 分頁 | 功能 |
|------|------|
| 上傳 Excel | 拖拉上傳，支援多檔，顯示歷史紀錄 |
| 資料庫狀態 | 各表格筆數統計 |
| 指標銷售設定 | SA 銷售矩陣篩選條件（類別碼/功能碼/零件號/付款類別） |
| 工作天數 | 月曆點選實際營業日，支援三站同步 |
| 工資代碼設定 | 追蹤特定工資代碼台數/金額/工時 |
| 營收目標 | 四大營收月目標＋去年實績，支援原生 Excel 匯入 |
| 零配精品銷售 | 業績指標定義、目標設定、Excel 批次匯入 |
| 個人業績目標 | 依廠別總目標設定 SA 個人權重，支援拖曳排序 |
| 工位設定 | 各廠引擎/鈑金/烤漆工位數（用於周轉率計算） |
| 管理員密碼 | 修改登入密碼 |

---

## 資料庫資料表

### 主要資料表（DMS 來源）

| 資料表 | 來源 | 說明 |
|--------|------|------|
| `repair_income` | 維修收入分類明細.xlsx | 工單收入、帳類、SA |
| `tech_performance` | 技師績效報表.xlsx | 技師工資、工時、工資代碼 |
| `parts_sales` | 零件銷售明細.xlsx | 零件銷售、種類、銷售人員 |
| `business_query` | 業務查詢.xlsx | 進廠工單、車輛資訊 |
| `parts_catalog` | 零配件比對.xlsx | 零件型錄（精品/配件判斷依據）|
| `staff_roster` | 員工基本資料.xlsx（獎金表上傳）| 人員名冊、部門、狀態 |

### 設定資料表

| 資料表 | 說明 |
|--------|------|
| `sa_sales_config` | SA 指標銷售篩選設定 |
| `tech_wage_configs` | 工資代碼追蹤設定 |
| `performance_metrics` | 業績指標定義 |
| `performance_targets` | 各指標月目標與去年實績 |
| `person_metric_targets` | 個人業績目標（權重/直接目標）|
| `revenue_targets` | 四大營收月目標與去年實績 |
| `revenue_estimates` | 本月各營收最新預估值（即時顯示用）|
| `revenue_estimate_history` | 週次預估提交歷史（每週每站一筆，鎖定後不可覆蓋）|
| `working_days_config` | 各據點每月實際營業日 |
| `income_config` | 外賣收入對應的 category 值 |
| `bonus_metrics` | 獎金指標定義 |
| `bonus_targets` | 獎金目標設定 |
| `wip_status_notes` | WIP 工單狀態標記（等料/施工中/已可結帳…）|
| `vctl_metrics` | VCTL 商務政策指標定義 |

### 系統資料表

| 資料表 | 說明 |
|--------|------|
| `app_settings` | 管理員密碼、技師工時產能設定、工位設定等系統參數 |
| `upload_history` | Excel 上傳紀錄 |

### 重要欄位說明

**`repair_income`**
```
period, branch, work_order, settle_date, clear_date, customer, plate_no,
account_type_code, account_type,
parts_income, accessories_income, boutique_income, engine_wage,
bodywork_income, paint_income, carwash_income, outsource_income, addon_income,
total_untaxed (未稅合計), total_taxed (含稅合計), parts_cost (未稅),
service_advisor
```
> 各別收入欄位為含稅，需 ÷1.05 取未稅值；`parts_cost` 與 `total_untaxed` 已為未稅

**`tech_performance`**
```
period, branch, tech_name_raw, tech_name_clean,
dispatch_date, work_order, work_code, task_content,
standard_hours, wage, account_type, discount, wage_category
```
> `discount` 可能為小數（0~1）或百分比（1~100），計算時須同時處理兩種格式

**`parts_sales`**
```
period, branch, category, order_no, work_order,
part_number, part_name, part_type (Paycode), category_code, function_code,
sale_qty, retail_price, sale_price_untaxed, cost_untaxed, discount_rate,
pickup_person, sales_person, plate_no
```

**`business_query`**
```
period, branch, work_order, open_time, settle_date,
plate_no, vin, status, repair_item,
service_advisor, assigned_tech, repair_tech, repair_type,
car_series, car_model, model_year, owner, is_ev,
mileage_in, mileage_out,
repair_amount, labor_fee, repair_material_fee, sales_material_fee
```

---

## API 文件

### 上傳

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/upload` | 上傳 Excel（最多 8 個，50MB 限制）|

### 統計 API（`/api/stats/*`）

所有統計 API 支援 `?period=202501&branch=AMA` 查詢參數。

| 路徑 | 說明 |
|------|------|
| `/api/stats/repair` | 維修收入彙總（by 帳類、by SA、totals）|
| `/api/stats/income-summary` | 收入分類明細（含外賣）|
| `/api/stats/income-breakdown` | 有費/無費收入分解 |
| `/api/stats/revenue-per-vehicle` | 單車銷售額（保養/維修/自費鈑烤/延保/保險）|
| `/api/stats/sa-car-count` | SA 個人進廠台數 |
| `/api/stats/sa-paid-revenue` | SA 個人各類型營收（`?rev_type=paid\|general\|bodywork\|extended`）|
| `/api/stats/parts` | 零件銷售彙總 |
| `/api/stats/boutique-accessories` | 精品配件銷售矩陣 |
| `/api/stats/sa-sales-matrix` | SA 指標銷售矩陣（`?view=sales_person\|pickup_person`）|
| `/api/stats/tech-wage-matrix` | 工資代碼統計矩陣 |
| `/api/stats/performance` | 業績指標達成率 |
| `/api/stats/trend` | 月份趨勢 |
| `/api/stats/daily` | 每日進廠台數 |
| `/api/stats/wip` | WIP 未結工單 |
| `/api/stats/tech-hours` | 技師工時目標 vs 實際 |
| `/api/stats/tech-hours-raw` | 技師折扣工時明細 |
| `/api/stats/tech-turnover` | 施工周轉率（引電＋集團鈑烤）|
| `/api/stats/person-performance` | 個人業績達成率 |
| `/api/stats/vctl` | VCTL 商務政策指標實績 |

### 資料查詢 API

| 路徑 | 說明 |
|------|------|
| `/api/query/repair_income` | 維修收入明細（無筆數上限）|
| `/api/query/tech_performance` | 技師績效明細 |
| `/api/query/parts_sales` | 零件銷售明細 |
| `/api/query/business_query` | 業務查詢明細 |
| `/api/periods` | 取得所有有效期間清單（含補全近兩年月份）|

### 設定 API

| 路徑 | 說明 |
|------|------|
| `/api/sa-config` | 指標銷售設定 CRUD |
| `/api/tech-wage-config` | 工資代碼設定 CRUD |
| `/api/performance-metrics` | 業績指標定義 CRUD |
| `/api/performance-targets` | 業績目標設定 |
| `/api/revenue-targets` | 營收目標設定 |
| `/api/revenue-estimates` | 業績預估（即時最新值）|
| `/api/revenue-estimates/week-status` | 本週週次狀態（各站是否已提交）|
| `/api/revenue-estimates/history` | 週次提交歷史 |
| `/api/revenue-estimates/weekly-submit` | 提交本週預估（週次鎖定）|
| `/api/working-days` | 工作天數設定 |
| `/api/person-targets` | 個人業績目標 |
| `/api/bonus/metrics` | 獎金指標 CRUD |
| `/api/bonus/progress` | 獎金進度計算 |
| `/api/bonus/roster` | 人員名冊查詢 |
| `/api/bonus/roster-periods` | 人員名冊期間清單 |
| `/api/bonus/departments` | 部門清單（含 factory）|
| `/api/bonus/scope-members` | 可設定目標的人員清單 |
| `/api/bonus/upload-roster` | 上傳人員資料 Excel |
| `/api/tech-capacity-config` | 技師工時產能設定 |
| `/api/tech-bay-config` | 工位數設定 |
| `/api/vctl/metrics` | VCTL 指標 CRUD |
| `/api/wip/status` | WIP 狀態查詢 |
| `/api/wip/status/:work_order/:branch` | WIP 單筆狀態更新 |
| `/api/auth/settings` | 密碼驗證 |

---

## Excel 上傳規則

**檔名需包含據點代碼和期間**，系統自動辨識類型：

```
維修收入分類明細_AMA_202501.xlsx   → repair_income
技師績效報表_AMC_202501.xlsx       → tech_performance
零件銷售明細_AMD_202501.xlsx       → parts_sales
業務查詢_AMA_202501.xlsx           → business_query
零配件比對.xlsx                    → parts_catalog（無需據點/期間）
員工基本資料.xlsx（獎金表頁面上傳）→ staff_roster
```

上傳前會先刪除同據點同期間的舊資料，再重新寫入。

### 據點識別邏輯（`detectBranch`）

```javascript
if (filename.includes('AMA')) return 'AMA';
if (filename.includes('AMC')) return 'AMC';
if (filename.includes('AMD')) return 'AMD';
```

### 期間識別邏輯（`detectPeriod`）

從檔名取第一個 6 位數字（YYYYMM）

### 人員名冊上傳（獎金表）

```
員工基本資料.xlsx → staff_roster
```

系統自動依部門代碼推算廠別：

| 部門代碼前綴 | 廠別 |
|------|------|
| 051xxx | AMA |
| 053xxx | AMC |
| 054xxx | AMD |
| 055xxx | 鈑烤廠 |
| 056xxx / 061xxx | 聯合服務中心 |
| 057xxx / 07xxx | 零件部 |
| 其他 | 售後服務處 |

> ⚠️ 注意：`staff_roster.factory='聯合服務中心'` 存放引電美容技師；`factory='鈑烤廠'` 存放鈑金烤漆技師。命名與直覺相反，勿依字面判斷。

---

## 核心業務邏輯

### 四大營收定義

| 營收類型 | 來源 | 計算邏輯 |
|----------|------|----------|
| 一般營收 | repair_income | 帳類=一般（不含鈑烤）＋票券＋外賣 |
| 鈑烤營收 | repair_income | 帳類=保險 ＋ 帳類=一般且有鈑金/烤漆欄位 |
| 延保營收 | repair_income | 帳類=延保 |
| 有費營收 | 上三者合計 | 一般＋鈑烤＋延保 |

### 稅務處理

```
個別收入欄位（engine_wage, bodywork_income…）→ 含稅，需 ÷1.05 取未稅
total_untaxed → 已為未稅
parts_cost → 已為未稅
```

### 工作天進度計算

1. 若有手動設定工作天數（`working_days_config`）：以設定日曆為準
2. 無手動設定：以本月 1 日到今日（UTC+8）的平日數計算
3. 「已過工作天」依今日時間點即時計算，與有無開單無關

### SA 銷售矩陣過濾邏輯

```
同類型多個值 → OR（例：類別碼 93 OR 94）
不同類型之間 → AND（例：類別碼 93 AND 功能碼 1832）
```

### 技師工時計算

```
目標工時 = 工作天 × 8H × 利用率（依職務設定）
實際工時 = wage ÷ 時薪（可依科別分開設定）
折扣還原 = discount < 1 → wage ÷ discount ÷ 時薪
         = discount 1~100 → wage ÷ (discount/100) ÷ 時薪
```

### 施工周轉率計算

```
引電周轉率 = 引電台次 ÷ 引電技師人數（不含領班）÷ 已過工作天
集團鈑烤 = 全廠鈑噴＋事故保險台次 ÷ 鈑烤廠鈑金+烤漆技師（含領班）÷ 已過工作天
工位承接率 = 台次 ÷ 工位數 ÷ 已過工作天
```

### WIP 未結工單定義

截至選定月份月底，所有在 `business_query` 有進廠紀錄、但在 `repair_income` 尚未結算的工單（跨月累計，已排除 PV 外賣訂單）。

### 業績預估週次鎖定

```
每自然週（週一~週日）每站可提交一次預估。
本週已提交 → 鎖定，不可覆蓋；下週可再提交新版本。
有費 = 一般 + 鈑烤 + 延保（可手動覆蓋自動加總）
```

### 獎金進度計算邏輯

```
revenue / performance 來源 → auto 指標，自動套用所有人
manual 來源 → 需手動設定個人目標才計算
個人目標 = 廠別目標 × 科別占比% × 個人相對權重 ÷ 科別總權重
branch_override filter → 強制指定此指標的分館實績來源
```

### 去年實績上傳規則

上傳去年實績時，**年份欄位需填入今年**（例：2026），原因是系統將去年實績存入今年各月紀錄中，與今年目標並列比較。

---

## 部署指南

### 環境變數

```env
POSTGRES_CONNECTION_STRING=postgresql://user:password@host:5432/volvo_dms
PORT=8080
```

### Zeabur 部署流程

1. 推送到 GitHub `main` branch → Zeabur 自動觸發部署
2. 部署完成後，如有資料表結構異動，需重新上傳 Excel
3. 不需手動執行 SQL，`initDatabase()` 在每次啟動時自動處理建表與欄位補充

> 注意：資料表結構異動使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，不會影響現有資料

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
```

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

---

## 已知維護重點

### 欄位對應

| 項目 | 位置 | 說明 |
|------|------|------|
| Excel 欄位對應 | `lib/parsers.js` | 各報表的中文欄位 alias 對應表 |
| 據點辨識 | `lib/utils.js → detectBranch()` | 從檔名取 AMA/AMC/AMD |
| 期間辨識 | `lib/utils.js → detectPeriod()` | 從檔名取 6 位數期間 |
| 建表 SQL | `db/init.js` | 新增資料表在此加 `CREATE TABLE IF NOT EXISTS` |
| 技師姓名正規化 | `routes/stats.js → canonicalExpr` | 處理斜線/空格/多人施工等情況 |

### 常見問題與解法

**Silent truncation**
- 查詢 endpoint 不加 `LIMIT`，stats endpoint 用 aggregation
- 兩者不一致時必查是否有殘留 LIMIT

**Excel 解析空欄位**
- `data_type='n'` 的空格欄位回傳 `0` 而非 `''`
- 使用 `isCellEmpty()` helper 判斷

**Sticky table headers（常見問題）**
- `border-collapse: separate; border-spacing: 0`（不能用 collapse）
- `position: sticky` 套在 `<thead>` 而非 `<th>`
- 垂直捲動容器需設 `overflow-y: auto` + `max-height`，不可設在 `.card` 上

**部署後仍舊版**
- Zeabur 可能跑舊版，先確認部署完成再重傳 Excel
- `ImagePullBackOff` / `ErrImagePull` 為 Zeabur 平台問題，非程式碼錯誤

**技師姓名多種格式**
- DMS 可能輸出「王大明-ABC」「王大明/李小華」
- `canonicalExpr` 取第一個斜線前的名字，`splitTechName()` 輔助拆分

**parts_catalog.part_type vs parts_sales.part_type**
- 前者為型錄種類（精品/配件/零件）
- 後者為 Paycode（付款類別）
- JOIN 時必須用 `pc.part_type` / `ps.part_type` 明確區分

**discount 欄位格式歧義**
- 可能為小數（0~1）或百分比（1~100），工時計算 SQL 必須同時處理兩種

**factory / roster label 命名反直覺**
- `staff_roster.factory='聯合服務中心'` → 引電美容技師
- `staff_roster.factory='鈑烤廠'` → 鈑金烤漆技師
- 必須透過 `BRANCH_CONFIG` 明確映射，勿依字面判斷

**`db/init.js` 順序**
- `ALTER TABLE` 語句必須在對應 `CREATE TABLE` 之後，避免全新部署時啟動崩潰

**修 bug 方針**
- 先二分搜尋定位精確錯誤行，不假設結構性原因
- 孤立代碼（orphaned code）是重構後的常見殘留，`ReferenceError` 出現時優先排查

---

## 術語對照

| 中文 | 英文/系統欄位 | 說明 |
|------|------|------|
| 有費 | paid | 一般客戶付費工單 |
| 無費 | no-charge | 內結/保固/VSA/善意 |
| 內結 | internal | 公司內部結帳 |
| 保固 | warranty | 廠商保固 |
| 善意維修 | goodwill | 廠商善意維修 |
| VSA | vsa | Volvo 特別協議 |
| 鈑烤 | bodywork | 鈑金＋烤漆 |
| 延保 | extended warranty | 延長保固 |
| SA | service_advisor | 服務顧問 |
| 技師 | tech | 維修技師 |
| 精品 | boutique | 原廠配件精品 |
| 日均台數 | daily_avg | 總台數 ÷ 已過工作天 |
| 工作天數 | working_days | 本月設定或自動偵測 |
| 進廠台數 | car_count | COUNT(DISTINCT plate_no) |
| 去年實績 | last_year_value | 上一年同期數值 |
| 目標數值 | target_value | 本年度月目標 |
| 預估 | estimate | 月中人工輸入預測值 |
| 周轉率 | turnover_rate | 台次 ÷ 人數 ÷ 工作天 |
| 工位承接率 | bay_rate | 台次 ÷ 工位數 ÷ 工作天 |
| PDI | PDI | 新車交車前檢查工單（WIP 特別標記）|
