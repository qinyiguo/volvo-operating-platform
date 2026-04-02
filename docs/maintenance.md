# 已知維護重點

## 欄位對應

| 項目 | 位置 | 說明 |
|------|------|------|
| Excel 欄位對應 | `lib/parsers.js` | 各報表的中文欄位 alias 對應表 |
| 據點辨識 | `lib/utils.js → detectBranch()` | 從檔名取 AMA/AMC/AMD |
| 期間辨識 | `lib/utils.js → detectPeriod()` | 從檔名取 6 位數期間 |
| 建表 SQL | `db/init.js` | 新增資料表在此加 `CREATE TABLE IF NOT EXISTS` |
| 技師姓名正規化 | `routes/stats.js → canonicalExpr` | 處理斜線/空格/多人施工等情況 |

## 常見問題與解法

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
