# Excel 上傳規則

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

## 據點識別邏輯（`detectBranch`）

```javascript
if (filename.includes('AMA')) return 'AMA';
if (filename.includes('AMC')) return 'AMC';
if (filename.includes('AMD')) return 'AMD';
```

## 期間識別邏輯（`detectPeriod`）

從檔名取第一個 6 位數字（YYYYMM）

## 人員名冊上傳（獎金表）

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
