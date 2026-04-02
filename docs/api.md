# API 文件

## 上傳

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/upload` | 上傳 Excel（最多 8 個，50MB 限制）|

## 統計 API（`/api/stats/*`）

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

## 資料查詢 API

| 路徑 | 說明 |
|------|------|
| `/api/query/repair_income` | 維修收入明細（無筆數上限）|
| `/api/query/tech_performance` | 技師績效明細 |
| `/api/query/parts_sales` | 零件銷售明細 |
| `/api/query/business_query` | 業務查詢明細 |
| `/api/periods` | 取得所有有效期間清單（含補全近兩年月份）|

## 設定 API

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
