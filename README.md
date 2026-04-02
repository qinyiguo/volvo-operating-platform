# Volvo DMS Dashboard — 技術文件

> 內部儀表板，追蹤 AMA、AMC、AMD 三個據點（及聯合服務中心、鈑烤廠）的服務營運數據。

---

## 系統概覽

| 頁面 | 路徑 | 說明 |
|------|------|------|
| 業績指標與預估 | `/performance.html` | 四大營收達成率、集團合計、業績預估（Modal 週次提交）、VCTL 商務政策指標 |
| 各廠明細 | `/stats.html` | 維修收入、單車銷售額、個人業績、零件銷售、精品配件、指標銷售、趨勢、每日進廠、WIP、技師工時、施工周轉率 |
| 資料查詢 | `/query.html` | 四大資料表全文搜尋、排序、CSV 匯出 |
| 獎金表 | `/bonus.html` | 人員名冊、獎金指標設定、獎金進度計算（密碼保護） |
| 設定 | `/settings.html` | Excel 上傳、指標設定、目標設定、工作天數、工位設定、密碼管理（密碼保護） |

## 技術架構

```
前端     HTML + Vanilla JS（無框架）
後端     Node.js + Express
資料庫   PostgreSQL
部署     Zeabur（GitHub 自動部署）
容器     Docker（node:20-alpine）
```

## 文件目錄

| 文件 | 內容 |
|------|------|
| [技術架構與專案結構](docs/architecture.md) | 套件依賴、目錄結構 |
| [頁面功能](docs/pages.md) | 各頁面功能詳細說明 |
| [資料庫資料表](docs/database.md) | 資料表定義、重要欄位說明 |
| [API 文件](docs/api.md) | 所有 REST API 端點 |
| [Excel 上傳規則](docs/upload-rules.md) | 檔名規則、據點/期間識別、人員名冊 |
| [核心業務邏輯](docs/business-logic.md) | 營收定義、稅務、工時、周轉率、獎金計算 |
| [部署與本地開發](docs/deployment.md) | 環境變數、Zeabur 部署、本地啟動 |
| [已知維護重點](docs/maintenance.md) | 欄位對應、常見問題與解法 |
| [術語對照](docs/glossary.md) | 中英文術語對照表 |

## 快速開始

```bash
npm install
cp .env.example .env   # 填入 POSTGRES_CONNECTION_STRING
npm start              # 自動建表，預設 port 8080
```
