# Volvo DMS Dashboard — 技術文件

> 內部儀表板，追蹤 AMA、AMC、AMD 三個據點（及聯合服務中心、鈑烤廠）的服務營運數據。

---

## 目錄

1. [系統概覽](#系統概覽)
2. [技術架構](#技術架構)
3. [身份驗證與權限](#身份驗證與權限)
4. [環境變數](#環境變數)
5. [專案結構](#專案結構)
6. [頁面功能](#頁面功能)
7. [資料庫資料表](#資料庫資料表)
8. [API 文件](#api-文件)
9. [Excel 上傳規則](#excel-上傳規則)
10. [核心業務邏輯](#核心業務邏輯)
11. [部署指南](#部署指南)
12. [本地開發](#本地開發)
13. [已知維護重點](#已知維護重點)
14. [術語對照](#術語對照)

---

## 系統概覽

| 頁面 | 路徑 | 說明 |
|------|------|------|
| 業績指標與預估 | `/performance.html` | 四大營收達成率、集團合計、業績預估（Modal 週次提交）、VCTL 商務政策指標 |
| 各廠明細 | `/stats.html` | 維修收入、單車銷售額、個人業績、零件銷售、精品配件、指標銷售、趨勢、每日進廠、WIP、技師工時、施工周轉率 |
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

來源:`lib/authMiddleware.js`

| 類型 | Key | 用途 |
|------|-----|------|
| Page | `page:performance` | 業績指標頁 |
| Page | `page:stats` | 各廠明細頁 |
| Page | `page:query` | 資料查詢頁 |
| Page | `page:bonus` | 獎金表頁 |
| Page | `page:settings` | 系統設定頁(也用於 income-config / working-days / beauty-op-hours 寫入) |
| Page | `page:monthly` | 月報頁 |
| Branch | `branch:AMA` / `branch:AMC` / `branch:AMD` | 可見廠別 |
| Feature | `feature:upload` | Excel 上傳 |
| Feature | `feature:targets` | 目標設定(營收/業績/個人) |
| Feature | `feature:bonus_edit` | 獎金指標 / 設定 / 鈑烤獎金等寫入 |
| Feature | `feature:user_manage` | 使用者管理 |

`role = 'super_admin'` 自動擁有全部權限,不必逐項授予。

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
│   ├── upload.js             # POST /upload 多檔 Excel 上傳（feature:upload）
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

---

### 路由層 `routes/`

> 路由層約定:每個檔案頂端 `router.use(requireAuth)`(`auth.js` / `users.js` 例外,因含登入端點),mutation route 以 inline `requirePermission(...)` 加上對應權限。詳見 [身份驗證與權限](#身份驗證與權限)。

#### `routes/upload.js`
處理 `POST /api/upload`(`feature:upload`)。接收 multer 上傳的 Excel 檔(最多 8 個、50 MB 限制),依檔名自動識別報表類型與據點期間,刪除同據點同期間的舊資料後,呼叫 `parsers` + `batchInsert` 重新寫入。支援六種報表:

| 報表 | 目標資料表 |
|------|-----------|
| 維修收入分類明細 | `repair_income` |
| 技師績效報表 | `tech_performance` |
| 零件銷售明細 | `parts_sales` |
| 業務查詢 | `business_query` |
| 零配件比對 | `parts_catalog` |
| 員工基本資料（獎金表頁面） | `staff_roster` |

#### `routes/stats.js`
最大的路由檔（約 890 行）。提供 `/api/stats/*` 所有統計端點，包含：維修收入彙總、有費/無費收入分解、單車銷售額、SA 業績排名、零件銷售、精品配件矩陣、指標銷售矩陣、月份趨勢、每日進廠台數、個人業績達成率、VCTL 實績等，共 15 支以上 API。全部支援 `?period=YYYYMM&branch=AMA` 查詢參數。

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
| 月份趨勢 | 各月維修收入折線圖 |
| 每日進廠 | 日均台數、日均線切換、天數進度 |
| WIP 未結工單 | 依進廠月份/維修類型統計，支援 PDI 標記、行內狀態填寫 |
| 技師工時 | 目標工時 vs 實際工時，含折扣還原 |
| 施工周轉率 | 引電周轉率、集團鈑烤周轉率、工位承接率 |

#### `public/query.html`
**資料查詢頁面**。提供四大資料表的全文搜尋介面，支援篩選、排序、欄位切換、分頁（50/100/200/500 筆），並可匯出帶 BOM 的 CSV（相容中文 Excel）。

#### `public/bonus.html`
**獎金表頁面**（密碼保護）。顯示各廠人員名冊（在職/留職停薪/本月離職），以及依指標設定計算的個人達成率與應領獎金。支援獎金指標管理（DMS 來源、職稱分層階梯、科別篩選、計算據點覆蓋）。

#### `public/settings.html`
**系統設定頁面**（密碼保護，約 170 KB）。包含 10 個設定分頁：

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
| POST | `/api/upload` | feature:upload | 上傳 Excel(最多 8 個,50 MB 限制) |
| POST | `/api/upload-revenue-targets` | feature:upload | 上傳營收目標 |
| POST | `/api/upload-revenue-targets-native` | feature:upload | 上傳營收目標(原生格式) |
| POST | `/api/upload-performance-targets-native` | feature:upload | 上傳業績指標目標 |
| POST | `/api/bodyshop-bonus/upload` | feature:upload | 鈑烤獎金資料上傳 |
| POST | `/api/bonus/upload-roster` | feature:upload | 上傳人員名冊 |

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

下表只列關鍵 mutation 的權限;讀取(GET)皆只需 `requireAuth`。

| 路徑 | 權限(寫入) | 說明 |
|------|-----------|------|
| `/api/sa-config` | feature:bonus_edit | 指標銷售設定 CRUD |
| `/api/tech-wage-config` | feature:bonus_edit | 工資代碼設定 CRUD |
| `/api/performance-metrics` | feature:targets | 業績指標定義 CRUD |
| `/api/performance-targets` | feature:targets | 業績目標設定 |
| `/api/revenue-targets` | feature:targets | 營收目標設定 |
| `/api/revenue-estimates` | feature:targets | 業績預估即時最新值 |
| `/api/revenue-estimates/weekly-submit` | feature:targets | 提交本週預估(週次鎖定) |
| `/api/revenue-estimates/week-status` | — | 各站是否已提交 |
| `/api/revenue-estimates/history` | — | 週次提交歷史 |
| `/api/working-days` | page:settings | 工作天數設定 |
| `/api/income-config/:key` | page:settings | 外賣 category 等收入設定 |
| `/api/beauty-op-hours/:op_code` | page:settings | 美容工時代碼 |
| `/api/person-targets` | feature:targets | 個人業績目標 |
| `/api/bonus/pp-alloc` | feature:bonus_edit | 個人占比配置 |
| `/api/bonus/metrics` | feature:bonus_edit | 獎金指標 CRUD |
| `/api/bonus/targets/batch` | feature:bonus_edit | 獎金目標批次寫入 |
| `/api/bonus/actual-override` | feature:bonus_edit | 手動覆蓋實績 |
| `/api/bonus/dept-mode` / `/dept-weights` | feature:bonus_edit | 部門模式/權重 |
| `/api/bonus/extra-bonuses` | feature:bonus_edit | 額外獎金 CRUD |
| `/api/bonus/beauty-branches` | feature:bonus_edit | 美容據點分配 |
| `/api/bonus/promo-dept-mode` | feature:bonus_edit | 促銷部門模式 |
| `/api/bonus/progress` | — | 獎金進度計算 |
| `/api/bonus/roster` | — | 人員名冊查詢 |
| `/api/bonus/roster/:period/:emp_id` | feature:bonus_edit | 人工調整廠別/部門 |
| `/api/promo-bonus/configs` | feature:bonus_edit | 促銷獎金規則 CRUD |
| `/api/promo-bonus/results` | — | 促銷獎金計算結果 |
| `/api/bodyshop-bonus/*` | feature:bonus_edit | 鈑烤獎金申請 / 比對 / 結算 |
| `/api/manager-review` | feature:bonus_edit | 主管審核調整 |
| `/api/tech-capacity-config` | feature:bonus_edit | 技師工時產能設定 |
| `/api/tech-bay-config` | feature:bonus_edit | 工位數設定 |
| `/api/tech-group-config-v2` | feature:bonus_edit | 技師群組設定 |
| `/api/vctl/metrics` | feature:bonus_edit | VCTL 指標 CRUD |
| `/api/wip/status/*` | requireAuth | WIP 狀態更新 |
| `/api/notes/*` | requireAuth | 說明欄鍵值對 |

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
