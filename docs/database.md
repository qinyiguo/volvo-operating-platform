# 資料庫資料表

## 主要資料表（DMS 來源）

| 資料表 | 來源 | 說明 |
|--------|------|------|
| `repair_income` | 維修收入分類明細.xlsx | 工單收入、帳類、SA |
| `tech_performance` | 技師績效報表.xlsx | 技師工資、工時、工資代碼 |
| `parts_sales` | 零件銷售明細.xlsx | 零件銷售、種類、銷售人員 |
| `business_query` | 業務查詢.xlsx | 進廠工單、車輛資訊 |
| `parts_catalog` | 零配件比對.xlsx | 零件型錄（精品/配件判斷依據）|
| `staff_roster` | 員工基本資料.xlsx（獎金表上傳）| 人員名冊、部門、狀態 |

## 設定資料表

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

## 系統資料表

| 資料表 | 說明 |
|--------|------|
| `app_settings` | 管理員密碼、技師工時產能設定、工位設定等系統參數 |
| `upload_history` | Excel 上傳紀錄 |

## 重要欄位說明

### `repair_income`

```
period, branch, work_order, settle_date, clear_date, customer, plate_no,
account_type_code, account_type,
parts_income, accessories_income, boutique_income, engine_wage,
bodywork_income, paint_income, carwash_income, outsource_income, addon_income,
total_untaxed (未稅合計), total_taxed (含稅合計), parts_cost (未稅),
service_advisor
```

> 各別收入欄位為含稅，需 ÷1.05 取未稅值；`parts_cost` 與 `total_untaxed` 已為未稅

### `tech_performance`

```
period, branch, tech_name_raw, tech_name_clean,
dispatch_date, work_order, work_code, task_content,
standard_hours, wage, account_type, discount, wage_category
```

> `discount` 可能為小數（0~1）或百分比（1~100），計算時須同時處理兩種格式

### `parts_sales`

```
period, branch, category, order_no, work_order,
part_number, part_name, part_type (Paycode), category_code, function_code,
sale_qty, retail_price, sale_price_untaxed, cost_untaxed, discount_rate,
pickup_person, sales_person, plate_no
```

### `business_query`

```
period, branch, work_order, open_time, settle_date,
plate_no, vin, status, repair_item,
service_advisor, assigned_tech, repair_tech, repair_type,
car_series, car_model, model_year, owner, is_ev,
mileage_in, mileage_out,
repair_amount, labor_fee, repair_material_fee, sales_material_fee
```
