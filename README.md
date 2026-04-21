# Volvo DMS Dashboard — 技術文件

> 內部儀表板，追蹤 AMA、AMC、AMD 三個據點（及聯合服務中心、鈑烤廠）的服務營運數據。

---

## 目錄

1. [快速上手](#快速上手)
2. [系統概覽](#系統概覽)
3. [技術架構](#技術架構)
4. [身份驗證與權限](#身份驗證與權限)
5. [環境變數](#環境變數)
6. [專案結構](#專案結構)
7. [檔案說明](#檔案說明)
8. [資料庫資料表](#資料庫資料表)
9. [API 文件](#api-文件)
10. [Excel 上傳規則](#excel-上傳規則)
11. [核心業務邏輯](#核心業務邏輯)
12. [常見修改任務](#常見修改任務)
13. [部署指南](#部署指南)
14. [本地開發](#本地開發)
15. [已知維護重點](#已知維護重點)
16. [術語對照](#術語對照)

---

## 快速上手

> **給接手的人**:5 分鐘搞清楚在看什麼、要改什麼去哪。

### 這個系統在做什麼
Volvo 經銷商三個據點(AMA 內湖 / AMC 仁愛 / AMD 士林)加上鈑烤廠、聯合服務中心的**售後服務營運儀表板**。把 DMS 匯出的 Excel 灌進 Postgres,讓管理層看業績、算獎金、追 WIP。

### 技術堆疊一句話
`Node.js + Express` 後端 + `純 HTML/Vanilla JS`(無框架)前端 + `PostgreSQL`,部署在 Zeabur(GitHub 自動部署)。

### 開檔案先看哪
| 想知道 | 先看 |
|---|---|
| 整體結構 | `index.js`(路由掛載順序)、本 README「專案結構」 |
| 每個後端檔在幹嘛 | 每個 `.js` 檔頂端的 JSDoc header |
| 每個頁面在幹嘛 | 每個 `.html` 頂端的 `<!-- -->` 註解 |
| 資料表結構 | `db/init.js`(全部 `CREATE TABLE` / `ALTER TABLE` 在這) |
| 身份驗證 | `lib/authMiddleware.js` + 本 README「身份驗證與權限」 |
| 業務邏輯術語 | 本 README「核心業務邏輯」+「術語對照」 |

### 改完要怎麼上線
```
git push (到對應 branch) → Zeabur 自動 deploy → 進去驗證
```
不用手動執行 SQL、不用手動重啟。`initDatabase()` 每次啟動會自己補欄位。

---

## 系統概覽

| 頁面 | 路徑 | 說明 |
|------|------|------|
| 業績指標與預估 | `/performance.html` | 四大營收達成率、集團合計、業績預估（Modal 週次提交）、VCTL 商務政策指標 |
| 各廠明細 | `/stats.html` | 維修收入、單車銷售額、個人業績、零件銷售、精品配件、指標銷售、每日進廠、WIP、技師工時、施工周轉率 |
| 資料查詢 | `/query.html` | 四大資料表全文搜尋、排序、CSV 匯出 |
| 獎金表 | `/bonus.html` | 人員名冊、獎金指標設定、獎金進度計算 |
| 月報 | `/monthly_report.html` | 月度報表彙整 |
| 設定 | `/settings.html` | Excel 上傳、指標設定、目標設定、工作天數、工位設定、使用者管理、操作紀錄 |
| 登入 | `/login.html` | 帳號密碼登入入口 |

> 所有頁面與 API 皆需登入,並依使用者授予的權限分流。詳見 [身份驗證與權限](#身份驗證與權限)。

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

## 身份驗證與權限

### 流程概觀

```
登入頁 (/login.html)
   │
   │  POST /api/users/login { username, password }
   ▼
routes/users.js  ── pbkdf2 驗證 ──▶  user_sessions (token)
   │
   │  Bearer token 存於 localStorage.dms_token
   ▼
public/auth.js   ── 全域 fetch wrapper 自動帶上 Authorization
   │
   ▼
lib/authMiddleware.js  ── requireAuth + requirePermission ──▶  受保護 API
```

- **Token**:`crypto.randomBytes(32)` 隨機字串,存 `user_sessions`,有效 8 小時。
- **密碼**:pbkdf2-sha256 / 100000 iterations / 16-byte salt。
- **Session 比對**:伺服器端只接受 `Authorization: Bearer` header(query string `?_token=` 已停用)。

### 權限鍵值

來源：`lib/authMiddleware.js`（`PAGE_PERMISSIONS` / `BRANCH_PERMISSIONS` / `FEATURE_PERMISSIONS`）

| 類型 | Key | 用途 |
|------|-----|------|
| Page | `page:performance` | 業績指標頁 |
| Page | `page:stats` | 各廠明細頁 |
| Page | `page:query` | 資料查詢頁 |
| Page | `page:bonus` | 獎金表頁 |
| Page | `page:settings` | 系統設定頁（也用於 income-config / working-days / beauty-op-hours 寫入）|
| Page | `page:monthly` | 月報頁 |
| Branch | `branch:AMA` / `branch:AMC` / `branch:AMD` | 可見廠別 |
| Branch | `branch:AME` | 聯合（美容）＋鈑烤 |
| Feature — 上傳 | `feature:upload_dms` | DMS 四大檔上傳 |
| Feature — 上傳 | `feature:upload_roster` | 人員名冊上傳（不受上傳鎖限制）|
| Feature — 上傳 | `feature:upload_targets` | 業績 / 營收目標上傳 |
| Feature — 上傳 | `feature:upload_bodyshop` | 業務鈑烤申請上傳 |
| Feature — 業績 | `feature:perf_metric_edit` | 業績指標定義 |
| Feature — 業績 | `feature:perf_target_edit` | 業績目標 / 個人目標 |
| Feature — 業績 | `feature:revenue_target_edit` | 營收目標 / 週次預估 |
| Feature — 各廠明細 | `feature:tech_config_edit` | 產能 / 工位 / 技師 / 工資代碼 |
| Feature — 各廠明細 | `feature:wip_edit` | WIP 工單狀態 |
| Feature — 獎金 | `feature:bonus_metric_edit` | 獎金指標 / 目標 / 權重 |
| Feature — 獎金 | `feature:bonus_extra_edit` | 額外獎金 / 主管考核 |
| Feature — 獎金 | `feature:bonus_sign` | 獎金電子簽核（檢查人） |
| Feature — 獎金 | `feature:promo_bonus_edit` | 促銷獎金規則 |
| Feature — 獎金 | `feature:bodyshop_bonus_edit` | 業務鈑烤獎金 |
| Feature — 獎金 | `feature:sa_config_edit` | SA 指標銷售配置 |
| Feature — 月報 | `feature:monthly_edit` | 月報版面 / 筆記 |
| Feature — 匯出 | `feature:export_bonus` | 獎金表匯出（Excel / PDF / HTML） |
| Feature — 匯出 | `feature:export_data` | 資料匯出（查詢 / 明細 / WIP / 月報圖） |
| Feature — 匯出 | `feature:export_audit` | 操作紀錄匯出 |
| Feature — 系統 | `feature:sys_config_edit` | 系統設定（收入 / 工作天 / 美容工時）|
| Feature — 系統 | `feature:user_manage` | 使用者管理 |
| Feature — 系統 | `feature:password_reset` | 重設他人密碼 |
| Feature — 簽核 | `feature:approve_upload_branch` | 上傳簽核（據點主管階段）|

> **舊權限兼容**：`feature:upload` / `feature:targets` / `feature:bonus_edit` 仍保留於 `LEGACY_FEATURE_PERMISSIONS`，`db/init.js` 啟動時會把持有者自動補上新權限；新功能請一律使用細分權限。

`role = 'super_admin'` 自動擁有全部權限，不必逐項授予，也可 bypass 期間鎖與簽核流程。

### 內部呼叫機制

伺服器端某些路由會以 HTTP loopback 呼叫自家 API(例如 `bonus/progress` → `stats/tech-hours`)。由於這些 API 也需要 auth,使用 `lib/authMiddleware.js` 提供的 shared secret:

```js
const { internalAuthHeaders } = require('../lib/authMiddleware');
fetch(url, { headers: internalAuthHeaders() });  // 自動帶 X-Internal-Service token
```

預設由啟動時 `crypto.randomBytes()` 產生;多 process 部署時設 `INTERNAL_API_TOKEN` env var 共用同值。

---

## 環境變數

### 必填

| 變數 | 說明 |
|------|------|
| `POSTGRES_CONNECTION_STRING` | Postgres 連線字串 |

### 選填(部署相關)

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3001`(prod 容器固定 8080) | Express 服務埠 |
| `POSTGRES_SSL` | `false` | `false` / `disable` 關閉 TLS;`require` / `true` 啟用 TLS 但接受自簽;`strict` / `verify` 嚴格驗憑證鏈 |
| `CORS_ALLOWED_ORIGINS` | (空) | 跨域白名單(逗號分隔)。同源不受影響 |
| `INTERNAL_API_TOKEN` | 自動隨機 | 多 process 部署時必須顯式指定 |

### 選填(初始化密碼)

僅首次啟動、對應 row 不存在時生效,之後變更請從應用程式內改。

| 變數 | 用途 |
|------|------|
| `INITIAL_ADMIN_PASSWORD` | 第一個 super_admin 使用者(帳號 `admin`)的密碼 |
| `INITIAL_SETTINGS_PASSWORD` | 系統設定頁(`/api/auth/settings`)的密碼 |

> 未指定時系統會產生隨機密碼並印一次到 stdout(prefix `[initDB]`),請即時記下並登入後變更。

---

## 專案結構

```
volvo-upload-test/
├── index.js                  # Express 入口、CORS、中介層、路由掛載
├── Dockerfile
├── package.json
│
├── db/
│   ├── pool.js               # PG Pool（POSTGRES_SSL 控制 TLS）
│   └── init.js               # 啟動自動建表 / 補欄位 / bootstrap admin
│
├── lib/
│   ├── utils.js              # detectBranch / detectPeriod / num / pick
│   ├── parsers.js            # Excel 中文欄位 alias 對應表
│   ├── batchInsert.js        # 批次 INSERT helper
│   ├── authMiddleware.js     # requireAuth / requirePermission / 內部 token
│   └── auditLogger.js        # auditMiddleware：自動記錄使用者操作
│
├── routes/
│   ├── users.js              # /users/login（公開）、使用者管理（feature:user_manage）
│   ├── auth.js               # /auth/settings 設定頁密碼登入（公開）
│   ├── upload.js             # POST /upload 多檔 Excel 上傳（feature:upload_dms）
│   ├── stats.js              # 各廠統計 API（純讀，requireAuth）
│   ├── techHours.js          # 技師工時、產能、工位、群組設定
│   ├── bonus.js              # 獎金指標 / 目標 / 進度 / 名冊
│   ├── bodyshopBonus.js      # 鈑烤獎金申請 / 比對 / 結算
│   ├── promoBonus.js         # 促銷獎金規則與計算
│   ├── revenue.js            # 營收目標、預估、週次提交
│   ├── performance.js        # 業績指標定義 / 目標 / 上傳
│   ├── personTargets.js      # 個人業績目標、來源人員清單
│   ├── query.js              # 四大資料表查詢、income-config、working-days
│   ├── saConfig.js           # SA 指標銷售矩陣篩選設定
│   ├── techWage.js           # 工資代碼追蹤設定
│   ├── wip.js                # WIP 工單狀態
│   ├── vctl.js               # VCTL 商務政策指標
│   ├── managerReview.js      # 主管審核（mount 在 /api/manager-review）
│   ├── auditLogs.js          # 操作紀錄查詢 API
│   └── notes.js              # app_settings 鍵值對說明欄 API
│
└── public/
    ├── index.html            # meta refresh → performance.html
    ├── login.html            # 登入頁
    ├── auth.js               # DmsAuth helper + 全域 fetch token 注入
    ├── performance.html
    ├── stats.html
    ├── query.html
    ├── bonus.html
    ├── monthly_report.html
    ├── settings.html
    └── theme.css
```

---

## 檔案說明

### 入口與設定

#### `index.js`
應用程式主入口。初始化 Express、設定 CORS、multer 檔案上傳中介層、靜態資源服務,並將所有 `routes/` 掛載到對應路徑。服務啟動時自動呼叫 `initDatabase()` 建立資料表。

> 注意:含未驗證端點的 router(`users.js` 的 `/users/login`、`auth.js` 的 `/auth/settings`)必須最早掛上,否則會被其他 router 的 `router.use(requireAuth)` 攔下回 401。

#### `Dockerfile`
Docker 映像定義。基於 `node:20-alpine`，安裝 production 依賴後啟動 `node index.js`，對外埠口為 8080，供 Zeabur 雲端自動部署使用。

#### `package.json`
定義 npm 依賴與啟動腳本。主要依賴：`express`（Web 框架）、`pg`（PostgreSQL）、`xlsx`（Excel 解析）、`multer`（檔案上傳）、`cors`、`dotenv`。

---

### 資料庫層 `db/`

#### `db/pool.js`
建立並匯出 PostgreSQL 連線池（`pg.Pool`），從環境變數 `POSTGRES_CONNECTION_STRING` 讀取連線字串。SSL 由 `POSTGRES_SSL` env var 控制(預設關閉,對應目前 Zeabur Postgres)。所有 routes 皆透過此 pool 執行 SQL 查詢。

#### `db/init.js`
啟動時執行的自動建表腳本(約 560 行)。以 `CREATE TABLE IF NOT EXISTS` 建立所有資料表,並以 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 補充新欄位,確保部署時不影響現有資料、無須手動執行 SQL。除了業務資料表之外也建立 `users` / `user_sessions` / `user_permissions` / `audit_logs`,並 bootstrap 第一個 super_admin 帳號(密碼讀 `INITIAL_ADMIN_PASSWORD` 或隨機產生)。

> ⚠️ `ALTER TABLE` 語句必須置於對應 `CREATE TABLE` 之後,否則全新部署時會因資料表尚不存在而啟動失敗。

---

### 工具函式庫 `lib/`

#### `lib/utils.js`
全域共用小工具，提供：
- `pick(obj, keys)` — 篩選物件欄位
- `num(val)` — 安全轉換為數字（處理 null / undefined）
- `parseDate(val)` — 日期格式解析
- `detectBranch(filename)` — 從檔名識別據點代碼（AMA / AMC / AMD）
- `detectPeriod(filename)` — 從檔名擷取六位數期間（YYYYMM）

#### `lib/parsers.js`
各 Excel 報表的**中文欄位別名對應表**。將 DMS 匯出的中文欄名（如「服務顧問」、「帳類」）對應到資料庫英文欄位名（如 `service_advisor`、`account_type`）。是 `upload.js` 解析 Excel 的核心依賴。

> 若 DMS 報表格式異動（欄名改變），只需更新此檔的對應設定即可，無需修改路由邏輯。

#### `lib/batchInsert.js`
提供 `batchInsert()` 函式,將解析後的大量資料列以批次 `INSERT` 方式寫入 PostgreSQL,避免逐筆 INSERT 造成的效能問題。由 `upload.js` 於 Excel 解析完成後呼叫。

#### `lib/authMiddleware.js`
身份驗證與權限中介層,匯出:

- `requireAuth(req, res, next)` — 要求合法 session token,失敗回 401。
- `requirePermission(key)` — 工廠函式,檢查使用者是否擁有該權限,失敗回 403;super_admin 自動通過。
- `softAuth` — 只附加 `req.user`,不阻擋未登入。
- `internalAuthHeaders()` — 同 process 內部 fetch loopback 用,取得帶 `X-Internal-Service: <token>` 的 header 物件。
- `ALL_PERMISSIONS` / `PAGE_PERMISSIONS` / `BRANCH_PERMISSIONS` / `FEATURE_PERMISSIONS` — 權限鍵值定義表。

#### `lib/auditLogger.js`
Express 全域中介層,攔截 `res.end` 事件,將每次已驗證請求(或登入嘗試)非同步寫入 `audit_logs`。包含:

- 自動依 method + path 推算 `action`(VIEW / CREATE / UPDATE / DELETE / UPLOAD / LOGIN / PWD_CHANGE...)。
- `RESOURCE_LABELS` / `SKIP_PATTERNS` 控制顯示名稱與略過頻繁路由(如 `/api/periods`、`/health`)。
- 也匯出 `writeLog(req, overrides)` 供路由手動補記特殊事件。

#### `lib/bonusPeriodLock.js`
期間鎖檢查中介（雙層：上傳鎖 + 獎金鎖）。匯出：

- `checkUploadPeriodLock(period, res, req)` — 上傳層（次月第一個工作日 17:59 鎖）。鎖定後寫入 DMS 四大檔 / 業績或營收目標 / 鈑烤申請回 423 Locked。
- `checkBatchUploadPeriodLock(periods, res, req)` — 批次版（多個 period 時用，如營收目標原生 Excel 一次寫 12 個月）。
- `checkBonusPeriodLock(period, res, req)` / `checkPeriodLock(...)` — 獎金層（次月 25 日 23:59 鎖）。鎖定後獎金規則 / 額外獎金 / 主管考核 / 電子簽核 / 促銷獎金 / 鈑烤獎金 無法寫入。
- `checkBatchPeriodLock(periods, res, req)` — 獎金層批次版。
- `super_admin` role 自動 bypass（給緊急狀況用）。失敗時用 `res.status(423).json(...)` 直接回覆，呼叫端拿到 `true` 表示要中止。

#### `lib/revenueActual.js`
「去年實績」自動 fallback 的計算核心。當 `revenue_targets.*_last_year` 或 `performance_targets.last_year_value` 為 NULL 時，讀取路徑會用這裡的 helper 從上年同月 DMS 資料回算，省掉每年手動上傳去年 Excel 的作業：

- `computeAllRevenues(period, branch)` → `{paid, bodywork, general, extended}`，邏輯沿用 `routes/bonus.js` 的 `computeRevenueActual()`，來源 `repair_income` + `parts_sales`（外賣類別），單位：元。
- `computePerfActualForMetric(metric, period, branch)` → 單一業績指標實績。依 `metric.metric_type` 切 `repair_income` / `parts` / `tech_wage` / `boutique` / `repair_subfield` 五種查詢路徑，filter 條件（account_type / work_code / part_number / boutique_type / subfield + wo_mode …）與 `/api/stats/performance` 當月計算**完全一致**，所以新增指標立即能撈到去年同條件的實績。
- `prevYearPeriod(period)` → `'202701'` → `'202601'`。
- `hasPrevYearSource(period, branch)` → 探測上年同月是否有 `repair_income` row。

目前使用者：`routes/revenue.js` GET `/revenue-targets`、`routes/performance.js` GET `/performance-targets`、`routes/stats.js` GET `/stats/performance`。

---

### 路由層 `routes/`

> 路由層約定:每個檔案頂端 `router.use(requireAuth)`(`auth.js` / `users.js` 例外,因含登入端點),mutation route 以 inline `requirePermission(...)` 加上對應權限。詳見 [身份驗證與權限](#身份驗證與權限)。

#### `routes/upload.js`
處理 `POST /api/upload`（`feature:upload_dms`）。接收 multer 上傳的 Excel 檔（最多 8 個、50 MB 限制），依檔名自動識別報表類型與據點期間，刪除同據點同期間的舊資料後，呼叫 `parsers` + `batchInsert` 重新寫入。支援六種報表：

| 報表 | 目標資料表 |
|------|-----------|
| 維修收入分類明細 | `repair_income` |
| 技師績效報表 | `tech_performance` |
| 零件銷售明細 | `parts_sales` |
| 業務查詢 | `business_query` |
| 零配件比對 | `parts_catalog` |
| 員工基本資料（獎金表頁面） | `staff_roster` |

#### `routes/stats.js`
最大的路由檔（約 890 行）。提供 `/api/stats/*` 所有統計端點，包含：維修收入彙總、有費/無費收入分解、單車銷售額、SA 業績排名、零件銷售、精品配件矩陣、指標銷售矩陣、每日進廠台數、個人業績達成率、VCTL 實績等，共 15 支以上 API。全部支援 `?period=YYYYMM&branch=AMA` 查詢參數。

> 技師姓名正規化（斜線/空格/多人施工）在此檔的 `canonicalExpr` 處理。

#### `routes/techHours.js`
處理技師工時相關計算（約 850 行）：

- `/api/stats/tech-hours` — 目標工時 vs 實際工時（工資金額回推，含折扣還原）
- `/api/stats/tech-hours-raw` — 技師折扣工時明細
- `/api/stats/tech-turnover` — 施工周轉率（引電台次 ÷ 技師人數 ÷ 工作天）
- `/api/tech-capacity-config` — 技師工時產能設定 CRUD
- `/api/tech-bay-config` — 各廠工位數設定 CRUD

> `discount` 欄位可能為小數（0~1）或百分比（1~100），工時計算 SQL 須同時處理兩種格式。

#### `routes/bonus.js`
獎金表後端（約 756 行）。提供完整的獎金計算功能：

- `/api/bonus/metrics` — 獎金指標定義 CRUD（DMS 來源、職稱分層階梯、科別篩選）
- `/api/bonus/progress` — 依廠別目標 × 科別占比 × 個人相對權重計算應領獎金
- `/api/bonus/roster` — 人員名冊查詢（依廠別/部門/在職狀態）
- `/api/bonus/upload-roster` — 上傳員工基本資料 Excel

#### `routes/bodyshopBonus.js`
鈑烤廠（鈑金/烤漆技師）的**專屬獎金計算邏輯**（約 600 行）。針對施工台次、工位承接率等鈑烤特定指標計算達成率與應領獎金，與引電技師的一般獎金邏輯分開維護。

#### `routes/promoBonus.js`
促銷/專案獎金的計算邏輯（約 260 行）。處理短期激勵方案或活動期間的額外獎金，獨立於一般月績效獎金之外。

#### `routes/revenue.js`
管理四大營收目標與業績預估（約 370 行）：

- `/api/revenue-targets` — 一般/鈑烤/延保/有費月目標與去年實績 CRUD
- `/api/revenue-estimates` — 各站本月最新預估值（即時顯示）
- `/api/revenue-estimates/weekly-submit` — 週次預估提交（每週每站一次，提交後鎖定）
- `/api/revenue-estimates/history` — 週次提交歷史紀錄
- `/api/revenue-estimates/week-status` — 本週各站是否已提交

#### `routes/performance.js`
管理業績指標定義與月目標（約 308 行）：

- `/api/performance-metrics` — 指標定義 CRUD（對應 `performance_metrics` 資料表）
- `/api/performance-targets` — 各指標月目標與去年實績 CRUD

#### `routes/personTargets.js`
管理 SA 個人業績目標（約 286 行）：

- `/api/person-targets` — 依廠別/SA 設定個人目標權重或直接目標值，支援拖曳排序（`order` 欄位）

#### `routes/query.js`
四大資料表的全文查詢端點（約 219 行）：

- `/api/query/repair_income` / `tech_performance` / `parts_sales` / `business_query` — 支援篩選、排序、關鍵字搜尋，無筆數上限（供 CSV 匯出）
- `/api/periods` — 取得所有有效期間清單
- `/api/counts` — 各資料表筆數統計
- `/api/working-days` — 工作天數設定 CRUD

#### `routes/saConfig.js`
管理 SA 指標銷售矩陣的篩選條件（約 70 行）：

- 同類型多值為 OR 邏輯（如：類別碼 93 OR 94）
- 不同類型之間為 AND 邏輯（如：類別碼 93 AND 功能碼 1832）

#### `routes/techWage.js`
管理工資代碼追蹤設定（約 111 行）：

- `/api/tech-wage-config` — 指定要追蹤的工資代碼 CRUD
- `/api/stats/tech-wage-matrix` — 依工資代碼統計台數/金額/工時矩陣

#### `routes/auth.js`
系統設定頁的密碼登入(獨立於使用者帳號系統,`app_settings.settings_password`):

- `POST /api/auth/settings` — 驗證設定頁密碼,回 8 小時 in-memory token
- `GET  /api/auth/settings/check` — 確認 token 有效
- `PUT  /api/auth/settings/password` — 修改設定頁密碼

密碼以 `pbkdf2$salt$hash` 形式存於 `app_settings.settings_password`,舊明文資料登入後自動升級。

#### `routes/users.js`
使用者帳號系統(完整實作):

- `POST /api/users/login` — 帳密驗證,建立 `user_sessions` token
- `POST /api/users/logout` — 撤銷當前 token
- `GET  /api/users/me` — 取得目前使用者 + 權限清單
- `GET  /api/users` / `POST` / `PUT /:id` / `DELETE /:id` — 使用者管理(`feature:user_manage`)
- `PUT  /api/users/:id/password` — 改密碼(本人需提供舊密碼;管理員可重設下級)
- `PUT  /api/users/me/profile` — 更新顯示名稱
- `GET  /api/users/permissions-schema` — 回傳前端用的權限定義表

`role` 三層:`super_admin` / `branch_admin` / `user`,`canManageRole()` 強制不可越權編輯。

#### `routes/auditLogs.js`
查詢 `audit_logs`(`requireAuth`):

- `GET /api/audit-logs` — 操作紀錄查詢(支援使用者/日期/動作篩選、分頁)

#### `routes/notes.js`
通用「說明欄」鍵值對 API,後端寫入 `app_settings`(`note_<key>` 前綴),供各頁說明文字儲存:

- `GET /api/notes/:key` / `PUT /:key` / `PUT /notes/batch` / `GET /notes?prefix=...`

#### `routes/wip.js`
WIP 未結工單管理（約 110 行）：

- `/api/wip/status` — 查詢未結工單（有進廠紀錄但尚未在 `repair_income` 結算，跨月累計，排除 PV 外賣訂單）
- `/api/wip/status/:work_order/:branch` — 行內更新工單狀態（等料 / 施工中 / 已可結帳…）

#### `routes/vctl.js`
VCTL 商務政策指標管理（約 160 行）：

- `/api/vctl/metrics` — 指標定義 CRUD（來源可指定：零件 / 配件 / 精品 / 工資）
- `/api/stats/vctl` — 計算各指標的售價、成本、毛利率實績

#### `routes/managerReview.js`
主管審核介面的後端端點（約 33 行）。供主管確認或調整獎金計算結果使用，目前為輕量路由。

---

### 前端頁面 `public/`

#### `public/index.html`
根路徑入口，僅做 meta refresh 重導向至 `performance.html`。

#### `public/performance.html`
**業績指標與預估頁面**。顯示工作天進度條、有費 KPI 卡片（集團合計與三廠拆分，含 YoY）、收入分解表（一般/保險/延保/票券/外賣）、各自訂業績指標達成率，以及每週一次的業績預估 Modal（週次鎖定，含歷史紀錄分頁）。底部顯示 VCTL 商務政策指標毛利率。

#### `public/stats.html`
**各廠明細頁面**（最大前端檔案，約 295 KB）。包含 11 個分頁：

| 分頁 | 主要功能 |
|------|---------|
| 維修收入 | 有費/無費收入摘要、SA 排名、帳類分析 |
| 單車銷售額 | 依保養/維修/自費鈑烤/延保/保險的車均金額 |
| 個人業績 | SA 個人達成率（三科別），支援科別占比、拖曳排序、Excel 匯出 |
| 零件銷售 | 種類彙總、Top 20 零件 |
| 精品配件 | 精品/配件銷售矩陣（需上傳零件型錄） |
| 指標銷售 | SA 銷售人員 / 技師施工雙視角矩陣 |
| 每日進廠 | 日均台數、日均線切換、天數進度 |
| WIP 未結工單 | 依進廠月份/維修類型統計，支援 PDI 標記、行內狀態填寫 |
| 技師工時 | 目標工時 vs 實際工時，含折扣還原 |
| 施工周轉率 | 引電周轉率、集團鈑烤周轉率、工位承接率 |

#### `public/query.html`
**資料查詢頁面**。提供四大資料表的全文搜尋介面，支援篩選、排序、欄位切換、分頁（50/100/200/500 筆），並可匯出帶 BOM 的 CSV（相容中文 Excel）。

#### `public/bonus.html`
**獎金表頁面**（需權限）。顯示各廠人員名冊（在職/留職停薪/本月離職），以及依指標設定計算的個人達成率與應領獎金。支援獎金指標管理（DMS 來源、職稱分層階梯、科別篩選、計算據點覆蓋）。

#### `public/settings.html`
**系統設定頁面**（需 `page:settings` 權限，約 170 KB）。包含 10 個設定分頁：

| 分頁 | 功能 |
|------|------|
| 上傳 Excel | 拖拉上傳，顯示歷史紀錄 |
| 資料庫狀態 | 各資料表筆數統計 |
| 指標銷售設定 | SA 銷售矩陣篩選條件 |
| 工作天數 | 月曆點選實際營業日，三站同步 |
| 工資代碼設定 | 追蹤特定工資代碼台數/金額/工時 |
| 營收目標 | 四大營收月目標與去年實績，支援 Excel 批次匯入 |
| 零配精品銷售 | 業績指標定義、目標設定、Excel 批次匯入 |
| 個人業績目標 | 依廠別總目標設定 SA 個人權重，支援拖曳排序 |
| 工位設定 | 各廠引擎/鈑金/烤漆工位數 |
| 管理員密碼 | 修改登入密碼 |

#### `public/theme.css`
所有頁面共用的 CSS（約 25 KB）。定義深色/淺色雙主題（CSS 變數切換）、card 元件、sticky table headers、進度條、badge、modal 等全域樣式。

> Sticky table headers 需使用 `border-collapse: separate; border-spacing: 0`（不可用 `collapse`），且 `position: sticky` 須套在 `<thead>` 而非 `<th>`。

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
| `person_metric_targets` | 個人業績目標(權重/直接目標) |
| `revenue_targets` | 四大營收月目標與去年實績 |
| `revenue_estimates` | 本月各營收最新預估值(即時顯示用) |
| `revenue_estimate_history` | 週次預估提交歷史(每週每站一筆,鎖定後不可覆蓋) |
| `working_days_config` | 各據點每月實際營業日 |
| `income_config` | 外賣收入對應的 category 值 |
| `bonus_metrics` | 獎金指標定義 |
| `bonus_targets` | 獎金目標設定(`metric_id, emp_id, dept_code, period` 唯一) |
| `bonus_actual_overrides` | 手動覆蓋的獎金實績值 |
| `bonus_extra` | 額外獎金(主管手動加項) |
| `manager_review` | 主管審核調整金額(`period, emp_id` 唯一) |
| `wip_status_notes` | WIP 工單狀態標記(等料/施工中/已可結帳…) |
| `vctl_metrics` | VCTL 商務政策指標定義 |
| `promo_bonus_configs` | 促銷獎金規則(含 tier 階梯、role_amounts、target_factories) |
| `bodyshop_bonus_applications` | 鈑烤獎金申請與比對結果(含 source_app_id 自我參照) |
| `beauty_op_hours` | 美容工時代碼標準時數 |
| `bonus_signatures` | 獎金表電子簽核（每期每廠一列；存簽名 base64、簽核人、時間）|
| `upload_approval_requests` | 鎖期後補傳的兩階段簽核申請（據點主管 → 最終核准）|
| `wip_status_history` | WIP 狀態異動歷史（每筆 comment / ETA 改動都留檔）|
| `tech_hours_excludes` | 技師「不計目標 / 不算人數」名單（period / branch / emp_name 複合主鍵）；被列入者 `target_hours` 歸 0、周轉率分母扣除、獎金工時指標自動排除；跨使用者共用，由工時表或周轉率頁的按鈕切換 |

### 帳號 / Session / 操作紀錄

| 資料表 | 說明 |
|--------|------|
| `users` | 使用者帳號(pbkdf2 hash + salt、role、branch、is_active) |
| `user_sessions` | 登入 token(主鍵 `token`,FK 至 `users.id`,有 `expires_at`) |
| `user_permissions` | 使用者額外權限授予(`user_id, permission_key` 唯一) |
| `audit_logs` | 操作紀錄(method、path、resource、IP、UA、status、duration) |

### 系統資料表

| 資料表 | 說明 |
|--------|------|
| `app_settings` | 設定頁密碼(hash)、產能設定、工位設定、`note_*` 說明欄、`team_mode_*` 等鍵值對 |
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

> 所有 API 皆需 `Authorization: Bearer <token>` header(由 `public/auth.js` 全域 fetch wrapper 自動補)。下表「權限」欄列出 mutation 所需的 `requirePermission` 值;空白代表只需登入。

### 帳號 / Session

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| POST | `/api/users/login` | (公開) | 帳密登入,回 token + 使用者 + 權限 |
| POST | `/api/users/logout` | requireAuth | 撤銷 token |
| GET  | `/api/users/me` | requireAuth | 取得目前使用者 |
| GET  | `/api/users` | feature:user_manage | 使用者列表 |
| POST | `/api/users` | feature:user_manage | 新增使用者 |
| PUT  | `/api/users/:id` | feature:user_manage | 更新基本資料 / 權限 |
| DELETE | `/api/users/:id` | feature:user_manage | 刪除使用者 |
| PUT  | `/api/users/:id/password` | requireAuth | 改密碼(自己需舊密碼) |
| PUT  | `/api/users/me/profile` | requireAuth | 更新顯示名稱 |
| GET  | `/api/users/permissions-schema` | requireAuth | 權限定義表 |
| GET  | `/api/audit-logs` | requireAuth | 操作紀錄 |

### 設定頁登入(獨立於使用者系統)

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| POST | `/api/auth/settings` | (公開) | 設定頁密碼登入,回 8 小時 in-memory token |
| GET  | `/api/auth/settings/check` | (公開) | token 是否有效 |
| PUT  | `/api/auth/settings/password` | (透過 token 驗證) | 改設定頁密碼 |

### 上傳

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| POST | `/api/upload` | `feature:upload_dms` | 上傳 Excel（最多 8 個，50 MB 限制） |
| POST | `/api/upload-revenue-targets` | `feature:upload_targets` | 上傳營收目標 |
| POST | `/api/upload-revenue-targets-native` | `feature:upload_targets` | 上傳營收目標（原生格式） |
| POST | `/api/upload-performance-targets-native` | `feature:upload_targets` | 上傳業績指標目標 |
| POST | `/api/bodyshop-bonus/upload` | `feature:upload_bodyshop` | 鈑烤獎金資料上傳 |
| POST | `/api/bonus/upload-roster` | `feature:upload_roster` | 上傳人員名冊（含留職停薪日 / 留職復職日） |

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
| `/api/stats/performance` | 業績指標達成率（含去年同期 fallback，見 `lib/revenueActual.js`）|
| `/api/stats/daily` | 每日進廠台數 |
| `/api/stats/wip` | WIP 未結工單 |
| `/api/stats/tech-hours` | 技師工時目標 vs 實際 |
| `/api/stats/tech-hours-raw` | 技師折扣工時明細 |
| `/api/stats/tech-turnover` | 施工周轉率（引電＋集團鈑烤）；tech_names 帶 `excluded` 旗標，tech_count 分母已扣除 |
| `/api/stats/person-performance` | 個人業績達成率 |
| `/api/stats/vctl` | VCTL 商務政策指標實績 |

### 資料查詢 API

| 路徑 | 說明 |
|------|------|
| `/api/query/repair_income` | 維修收入明細（無筆數上限）|
| `/api/query/tech_performance` | 技師績效明細 |
| `/api/query/parts_sales` | 零件銷售明細 |
| `/api/query/business_query` | 業務查詢明細 |
| `/api/periods` | 取得所有有效期間清單（DB 裡有資料的所有月份 ∪ 下一年 + 今年 + 去年；供前端期間下拉使用，年末可先選隔年月份做規劃）|

### 設定 API

下表只列關鍵 mutation 的權限；讀取（GET）皆只需 `requireAuth`。

| 路徑 | 權限（寫入） | 說明 |
|------|-----------|------|
| `/api/sa-config` | `feature:sa_config_edit` | 指標銷售設定 CRUD |
| `/api/tech-wage-config` | `feature:tech_config_edit` | 工資代碼設定 CRUD |
| `/api/performance-metrics` | `feature:perf_metric_edit` | 業績指標定義 CRUD |
| `/api/performance-targets/batch` | `feature:perf_target_edit` | 業績目標批次寫入（GET 讀取時 `last_year_value` NULL 會自動 fallback 上年同月實績） |
| `/api/revenue-targets/batch` | `feature:revenue_target_edit` | 營收目標批次寫入（GET `*_last_year` NULL 會自動 fallback） |
| `/api/revenue-estimates/batch` | `feature:revenue_target_edit` | 業績預估即時最新值 |
| `/api/revenue-estimates/weekly-submit` | `feature:revenue_target_edit` | 提交本週預估（週次鎖定） |
| `/api/revenue-estimates/week-status` | — | 各站是否已提交 |
| `/api/revenue-estimates/history` | — | 週次提交歷史 |
| `/api/working-days` | `feature:sys_config_edit` | 工作天數設定 |
| `/api/income-config/:key` | `feature:sys_config_edit` | 外賣 category 等收入設定 |
| `/api/beauty-op-hours/:op_code` | `feature:sys_config_edit` | 美容工時代碼 |
| `/api/person-targets/batch` | `feature:perf_target_edit` | 個人業績目標 |
| `/api/bonus/pp-alloc` | `feature:bonus_metric_edit` | 個人占比配置 |
| `/api/bonus/metrics` | `feature:bonus_metric_edit` | 獎金指標 CRUD |
| `/api/bonus/targets/batch` | `feature:bonus_metric_edit` | 獎金目標批次寫入 |
| `/api/bonus/actual-override` | `feature:bonus_metric_edit` | 手動覆蓋實績 |
| `/api/bonus/dept-mode` / `/dept-weights` | `feature:bonus_metric_edit` | 部門模式 / 權重 |
| `/api/bonus/extra-bonuses` | `feature:bonus_extra_edit` | 額外獎金 CRUD |
| `/api/manager-review` | `feature:bonus_extra_edit` | 主管審核調整 |
| `/api/bonus/beauty-branches` | `feature:bonus_metric_edit` | 美容據點分配 |
| `/api/bonus/promo-dept-mode` | `feature:promo_bonus_edit` | 促銷部門模式 |
| `/api/bonus/progress` | — | 獎金進度計算 |
| `/api/bonus/roster` / `/roster-summary` | — | 人員名冊查詢（含留停 / 復職過濾）|
| `/api/bonus/roster/:period/:emp_id` | `feature:bonus_metric_edit` | 人工調整廠別 / 部門 |
| `/api/bonus/signatures` | `feature:bonus_sign` | 獎金電子簽核（每期每廠一份） |
| `/api/promo-bonus/configs` | `feature:promo_bonus_edit` | 促銷獎金規則 CRUD |
| `/api/promo-bonus/results` | — | 促銷獎金計算結果 |
| `/api/bodyshop-bonus/*` | `feature:bodyshop_bonus_edit` | 鈑烤獎金申請 / 比對 / 結算 |
| `/api/tech-capacity-config` | `feature:tech_config_edit` | 技師工時產能設定 |
| `/api/tech-bay-config` | `feature:tech_config_edit` | 工位數設定 |
| `/api/tech-group-config-v2` | `feature:tech_config_edit` | 技師群組設定（組別 A/B/C…）|
| `/api/tech-hours-excludes` | `feature:tech_config_edit` | 技師「不計目標 / 不算人數」名單 — PUT 單筆 toggle；GET 回傳 `{branch: [emp_name]}`；**同時**影響工時表、周轉率分母、獎金工時指標三處計算 |
| `/api/vctl/metrics` | `feature:bonus_metric_edit` | VCTL 指標 CRUD |
| `/api/wip/status/*` | `feature:wip_edit` | WIP 狀態更新（帶歷史至 `wip_status_history`）|
| `/api/notes/*` | `feature:monthly_edit` | 月報筆記 / 版面 |
| `/api/upload-approvals/*` | `feature:approve_upload_branch` / `feature:user_manage` | 上傳簽核（鎖期補傳兩階段）|

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

Excel 欄位對應（以 **header 名稱** 辨識，不限欄位位置；以下「建議位置」只是慣例）：

| Excel Header | 建議位置 | `staff_roster` 欄位 |
|---|---|---|
| 員工編號 | — | `emp_id` |
| 中文姓名 | — | `emp_name` |
| 部門代碼 | — | `dept_code` |
| 部門中文名稱 | — | `dept_name` |
| 職務中文名稱 | — | `job_title` |
| 在職狀態 | — | `status`（在職 / 留職停薪 / 離職）|
| 到職日期 | — | `hire_date` |
| 離職日期 | — | `resign_date` |
| 留職停薪日 | CV | `unpaid_leave_date` |
| **留職復職日** | **CW** | `reinstated_date`（04-21 新增） |
| 一階主管 / 二階主管 | — | `mgr1` / `mgr2` |
| 職種名稱 / 職類名稱 | — | `job_category` / `job_class` |

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

**獎金表名單納入規則**（`routes/bonus.js` → `activeFilter()`）：

| 狀態 | 納入條件 |
|---|---|
| `在職` | 一律納入 |
| `離職` | `resign_date ≥ 上月 1 號`（當月內離職者仍算，供核發當月工時） |
| `留職停薪` | `unpaid_leave_date ≥ 本月 1 號` **或** `reinstated_date ≥ 本月 1 號` |

> 例：3/21 留職停薪 → 3 月獎金表有、4 月沒有；4/10 復職 → 4 月重新出現。

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

### 技師「不計目標 / 不算人數」清單（共用）

`tech_hours_excludes` 表 + `GET/PUT /api/tech-hours-excludes`（權限 `feature:tech_config_edit`）是系統中**唯一**的「此期該技師不納入計算基準」設定，四處連動：

| 模組 | 讀取時的行為 |
|---|---|
| `/api/stats/tech-hours` | 命中者 `target_hours=0`、`target_excluded=true`、`user_excluded=true`、`achieve_rate=null`；部門 / 組別小計自動少算這份目標 |
| `/api/stats/tech-turnover` | 引電與集團鈑烤 tech 清單都附上 `excluded:true`；`tech_count` 分母只算未排除者，周轉率即時重算 |
| `/api/bonus/progress`（工時型指標） | 直接讀 `tech.target_hours` 加總 → 由於已被 tech-hours 歸 0，**獎金工時指標自動排除** |
| `/api/stats/tech-hours-raw` | 不影響（原始 DMS 明細不受排除影響）|

**設定入口**：
- `stats.html` 工時表每列「✅ 計入 / ❌ 不計」按鈕（以前只存 localStorage，已遷移至 DB）
- `stats.html` 周轉率頁的技師姓名按鈕（04-21 新增），共用同一份清單

**存儲粒度**：period / branch / emp_name。同一人在不同月份或不同 branch 可獨立排除。鈑烤技師 branch 用 `'鈑烤'`；引電用 `AMA / AMC / AMD`。

**跨使用者共用**：所有人看到同一份清單，避免不同瀏覽器看到不同分母的陷阱。修改需 `feature:tech_config_edit`。

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

分母可微調：周轉率頁的技師姓名按鈕可切換「是否納入分母」，資料寫入 `tech_hours_excludes`（同工時表「不計目標」），因此一個動作同時影響周轉率、工時達成率、獎金工時指標（見「技師『不計目標 / 不算人數』清單」一節）。

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

**未達標歸零（`bonus_rule.zero_below_rate`）**

- 在「新增獎金規則」modal 勾選「🎯 未達標歸零」並設定門檻 %。
- 只要**任一**應用於該員工的績效指標達成率 < 該指標的 `zero_below_rate`，該員工**所有績效指標獎金**一起歸 0（由 `public/bonus.html` 的 `isZeroBelowTriggered()` + 兩個 per-person 迴圈實作）。
- 額外獎金 / 促銷獎金 / 主管考核 **不受影響**。
- 團體制（`scope_type='dept'`）：任一 dept-scope 指標觸發 → 所有團體池歸 0，池徽章與個人分配一致。

### 獎金表排序

`public/bonus.html` 的 `renderProgressContent()` 內：

- **廠別順序**：`FC_ORDER = ['售後服務處','AMA','AMC','AMD','聯合','鈑烤','零件','其他']`（`FACTORY_ORDER` / `ORDER` / `FC_ORDER` 三個常數需同步）。
- **部門內排序**：依 `jobTitleRank()` 職等（高 → 低），再以總獎金 desc、姓名做 tie-break。
- **職等關鍵字清單**（節錄）：董事長 → 總經理 → 副總 → 處長 → 資深協理 → 協理 → 廠長 → **資深經理 → 技術長 → 經理** → 副理 → 主任 → 組長 → 領班 → 資深技師 → **L4技師 → L3 → L2 → L1 → L0** → **高級美容技師 → 美容技師 → 洗車美容** → 實習生 → 組員 → 助理 → 工讀。
- 清單依 `indexOf` 順序匹配，較具體的（`L4技師`、`美容技師`）必須排在泛用詞（`技師`）之前；新增職稱關鍵字時注意這個順序。

### 去年實績上傳規則

上傳去年實績時，**年份欄位需填入今年**（例：2027 年上傳 2026 實績，year 欄位選 `2027`），原因是系統將去年實績存入今年各月紀錄中，與今年目標並列比較 — 查 `period='202701'~'202712'` 可同時拿到「2027 目標」與「2026 實績」。

**自動 fallback（不用再手動上傳去年實績）**

只要**上年度 DMS 四大檔都有上傳過**，三個端點讀取時會自動從
`repair_income` / `tech_performance` / `parts_sales` 計算上年同月的數字
補進 `*_last_year` / `last_year_value` 欄位再回傳，DB 不會寫回，隨時可被
手動上傳的 Excel 覆蓋：

- `/api/revenue-targets`：補 `paid_last_year` / `bodywork_last_year` /
  `general_last_year` / `extended_last_year`
- `/api/performance-targets`：補 `last_year_value`
- `/api/stats/performance`：回傳 `branches[br].last_year` 時，若
  `performance_targets.last_year_value` 為空，動態算上年同月實績 — 這條
  路徑讓 **2027 年新增的指標**（例如新產品零件編號）也能立即拿到 2026
  同期數字，不需要 performance_targets 事先存在該 row

實作於 `lib/revenueActual.js`：
- `computeAllRevenues(period, branch)` → `{paid, bodywork, general, extended}`
- `computePerfActualForMetric(metric, period, branch)` → 單一指標實績，
  支援 `repair_income` / `parts` / `tech_wage` / `boutique` /
  `repair_subfield` 五種 metric_type
- `prevYearPeriod(period)` → YYYYMM 上年同月

補上的欄位會帶 `_last_year_auto:true` 旗標；`/stats/performance` 的回傳
則是 `branches[br].last_year_auto:true`。前端若要標示「自動推算」可用。

### 期間鎖定（雙層）

| 層級 | 鎖定時機 | 實作 | 鎖住的寫入 |
|---|---|---|---|
| **上傳鎖** | 次月第一個工作日 17:59 | `lib/bonusPeriodLock.js` → `checkUploadPeriodLock()` | DMS 四大檔（repair_income / tech_performance / parts_sales / business_query）、業績 / 營收目標、鈑烤申請 |
| **獎金鎖** | 次月 25 日 23:59 | `lib/bonusPeriodLock.js` → `checkBonusPeriodLock()` | 獎金指標、額外獎金、主管考核、電子簽核、促銷獎金規則、鈑烤獎金 |

- **人員名冊**（`/bonus/upload-roster`）**不受**上傳鎖限制 —— HR 月初對帳後仍可補傳 / 修正。
- **`super_admin`** role 完全 bypass，給緊急狀況用。
- 前端在獎金表頁上方會顯示倒數提醒；切換期間時也會重算。

### 上傳簽核（鎖期後的補傳流程）

- 鎖定後仍可提交補傳，但走兩階段：
  1. 據點主管（`feature:approve_upload_branch`）核准
  2. 最終簽核者（`feature:user_manage` 或 `super_admin`）蓋章
- 紀錄於 `upload_approval_requests` 表，狀態：`pending` → `branch_approved` → `approved` / `rejected`。
- 前端頁面：`/approvals.html`（已從 設定 底下提升為頂層 nav）。

### 獎金表電子簽核

- 每期每廠一列於 `bonus_signatures`（欄位：`period`, `branch`, `signer_id`, `signer_name`, `signature_data`（PNG base64）, `signed_at`）。
- 簽核權限：`feature:bonus_sign`。
- 簽名 canvas 在 `bonus.html` 的 `openSignatureModal()`；撤銷 / 重簽會寫入 `audit_logs`。
- Excel / PDF / HTML 匯出都會嵌入最新簽名；彙總頁另有 5 格簽核欄（董事長室 → 總經理室 → 最高主管 → 單位主管 → 承辦人，等寬 `repeat(5,1fr)`）。

---

## 常見修改任務

> Cheatsheet:遇到 X,先改 Y。

### 新增一個 API 端點
1. 挑對應 route 檔（例如新增獎金相關功能 → `routes/bonus.js`）。
2. 在檔尾 `module.exports` 之前加 `router.get/post/put/delete(...)`。
3. **寫入類端點**記得加 `requirePermission('feature:bonus_metric_edit')` 之類的細分鍵（舊 `feature:bonus_edit` 僅為兼容保留）。
4. **跨月寫入**記得加 `checkBonusPeriodLock(period, res, req)` 或 `checkUploadPeriodLock(...)`（見 `lib/bonusPeriodLock.js`）。
5. 若要記 audit log 以外的特殊事件，在 handler 內 `await writeLog(req, {action:'XXX', ...})`。
6. 前端直接 `fetch('/api/...')`，`auth.js` 的全域 wrapper 會自動帶 token。

### 新增資料表 / 加欄位
**一律改 `db/init.js`**,不要在 route 檔 top-level 下 `pool.query(ALTER...)`。
- 新表 → `CREATE TABLE IF NOT EXISTS` 加在對應段落。
- 加欄位 → `ALTER TABLE xxx ADD COLUMN IF NOT EXISTS ...` 緊接在 CREATE 之後。
- 不用手動執行 SQL;下次啟動 `initDatabase()` 會自動跑。

### DMS Excel 欄名改了
改 `lib/parsers.js` 的 alias 對應表。route 層不用動。

### 新增一個前端頁
1. `public/xxx.html` 複製現有頁當範本(建議 query.html,結構最單純)。
2. 頁頂記得加 `<script src="/auth.js"></script>` 和 `<link rel="stylesheet" href="/theme.css">`。
3. HTML 檔頂加 `<!-- ... -->` 註解說明用途、權限、相依 API。
4. nav 加入連結,含 theme toggle button:
   ```html
   <button id="themeToggleBtn" class="theme-toggle-btn" onclick="toggleTheme()">☀️</button>
   ```

### 新增一個權限鍵
1. `lib/authMiddleware.js` 的 `PAGE_PERMISSIONS` / `FEATURE_PERMISSIONS` 加進去。
2. 使用者管理頁(settings)會自動顯示成勾選項。
3. 後端 route 用 `requirePermission('feature:xxx')` 套用。

### 增加一個獎金計算規則(促銷)
1. 在 `promo_bonus_configs.rule_type` 加新 enum 值。
2. `routes/promoBonus.js` 的 `/promo-bonus/results` handler 內增加 `else if (cfg.rule_type === 'xxx')` 分支。
3. 前端 bonus.html 的促銷設定 modal 加對應 UI。

### 某個 endpoint 401 / 403
- **401** = token 無效 / 過期 → 重新登入。
- **403** = 已登入但無對應 feature/page 權限 → 去 settings「使用者管理」勾上。
- **「未登入或登入已過期」出現在登入端點本身** = router mount 順序錯了,users.js 和 auth.js 必須掛在最前。

### 某頁在 light 模式下看起來怪怪的
- 先找那塊元素用了什麼 `style="background:#XXXXXX"`。
- 確認 `theme.css` 內有對應 `body.light-theme [style*="background:#XXXXXX"] { ... }` 覆蓋。
- 沒有就加上去。整批 inline hardcoded 深色值的覆蓋集中在 theme.css 下半部。

---

## 部署指南

### 環境變數樣板

```env
# 必填
POSTGRES_CONNECTION_STRING=postgresql://user:password@host:5432/volvo_dms

# 選填（部署）
PORT=8080
POSTGRES_SSL=false                # require / strict 開啟 TLS
CORS_ALLOWED_ORIGINS=             # 逗號分隔，跨域才需設
INTERNAL_API_TOKEN=               # 多 process 部署需顯式指定

# 選填（首次啟動初始密碼，建議設定後刪除）
INITIAL_ADMIN_PASSWORD=
INITIAL_SETTINGS_PASSWORD=
```

完整說明見 [環境變數](#環境變數)。

### Zeabur 部署流程

1. 推送到 GitHub 對應 branch → Zeabur 自動觸發部署。
2. **首次部署**:
   - 若未設 `INITIAL_ADMIN_PASSWORD` / `INITIAL_SETTINGS_PASSWORD`,啟動 log 會印一次隨機密碼,**請立刻記下**。
   - 用 `admin` + 印出的密碼登入 → 立即透過「個人設定」改密碼。
   - 若設定頁需要密碼,亦請進「管理員密碼」改掉。
3. **日常部署**:
   - 程式碼 / SQL schema 異動皆透過 `initDatabase()` 自動處理(`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`),不需手動 SQL。
4. **DB 異動** 之後仍需重新上傳的 Excel 限縮到「欄位定義改變」的情況,大多數變動可直接生效。

> ⚠️ 資料表結構異動絕對不要用 `DROP TABLE`,以免清空 prod 資料。

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
cat > .env <<'EOF'
POSTGRES_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/volvo_dms
POSTGRES_SSL=false
PORT=3001
INITIAL_ADMIN_PASSWORD=devadmin
INITIAL_SETTINGS_PASSWORD=devsettings
EOF

# 3. 啟動（會自動建表 + bootstrap super_admin）
npm start
# → http://localhost:3001/login.html  以 admin / devadmin 登入
```

---

## 已知維護重點

### 路由掛載順序(易錯點)

`index.js` 內 router mount 順序**有意義**:含未驗證端點的 `users.js`(`/users/login`)與 `auth.js`(`/auth/settings`)必須最早掛上,否則會被其他 router 的 `router.use(requireAuth)` 攔下回 401。新增含未驗證端點的 router 時請依此處理。

### 前端 fetch token 注入

`public/auth.js` 在每個頁面載入時會替換 `window.fetch`,自動為 `/api/*` 請求補上 `Authorization: Bearer`。若新建 HTML 頁面記得 `<script src="/auth.js"></script>`,不然要登入的 API 會全 401。

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
- 先二分搜尋定位精確錯誤行,不假設結構性原因
- 孤立代碼(orphaned code)是重構後的常見殘留,`ReferenceError` 出現時優先排查

**權限相關 401 / 403**
- 401:token 過期 / 沒帶 / DB 找不到 session → 重新登入。
- 403:登入了但缺對應 `feature:` / `page:` 權限 → 從「使用者管理」加上。
- 「未登入或登入已過期」固定字串來自 `lib/authMiddleware.js requireAuth`;若 login 端點本身回這個錯,通常是 router mount 順序錯了(見上方「路由掛載順序」)。

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
