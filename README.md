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
| 資料查詢 | `/query.html` | 四大資料表全文搜尋、排序、Excel 匯出 |
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
| `@e965/xlsx` | Excel 解析（CVE-2023-30533 / CVE-2024-22363 patched fork，取代原版 `xlsx`） |
| `multer` | 檔案上傳 |
| `cors` | 跨域設定 |
| `helmet` | 安全標頭（CSP / HSTS / X-Frame-Options） |
| `cookie-parser` | 解析 HttpOnly cookie（`dms_token` / `dms_csrf`） |
| `express-rate-limit` | `/api/users/login` 暴力破解防護（15 分 10 次） |
| `dotenv` | 環境變數 |

---

## 身份驗證與權限

### 流程概觀

```
登入頁 (/login.html)
   │
   │  POST /api/users/login { username, password }
   ▼
routes/users.js  ── pbkdf2 驗證 + 帳號鎖定檢查 ──▶  user_sessions (token)
   │                                             ──▶  Set-Cookie dms_token  (HttpOnly, Secure, SameSite=Lax)
   │                                             ──▶  Set-Cookie dms_csrf   (非 HttpOnly，前端 JS 要讀)
   │
   │  瀏覽器自動帶 cookie；前端 fetch 補 X-CSRF-Token header
   ▼
public/auth.js   ── fetchWithAuth：credentials:'include' + X-CSRF-Token
   │
   ▼
lib/authMiddleware.js  ── csrfProtect → requireAuth → requirePermission ──▶  受保護 API
```

- **Token 儲存**：`dms_token` **HttpOnly cookie**（防 XSS 竊取）；保留 `Authorization: Bearer` 作為 curl / Postman / 舊 client 相容路徑。`localStorage.dms_token` **已停用**。
- **Session TTL**：**絕對 4 小時** + **閒置 30 分**（OWASP ASVS L2）。每次有效請求更新 `user_sessions.last_activity`（60s 節流）；閒置超時由 `resolveToken()` 的 SQL `WHERE last_activity > NOW() - 30min` 擋。
- **密碼雜湊**：pbkdf2-sha256 + 16-byte salt。預設 **600,000 iterations**（OWASP 2023+）；舊資料 100k 保留於 `users.password_iterations`，登入成功後若 < 600k 會即時重算升級，使用者無感。
- **帳號鎖定**：連續 3 次密碼錯誤 → 暫時鎖 15 分鐘；解鎖後再錯 3 次 → **永久鎖**（需 super_admin 透過 `POST /api/users/:id/unlock` 解）。
- **CSRF 防護**：**double-submit cookie** 模式。登入時伺服器發 `dms_csrf` cookie（非 HttpOnly），前端 JS 讀取後每個 POST/PUT/PATCH/DELETE 以 `X-CSRF-Token` header 帶回，不符 → 403。GET/HEAD/OPTIONS、login/logout、`X-Internal-Service` 內部呼叫豁免；無 cookie 的純 Bearer client 亦豁免。

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
| Feature — 獎金 | `feature:promo_bonus_edit` | 銷售獎金規則 |
| Feature — 獎金 | `feature:bodyshop_bonus_edit` | 業務鈑烤獎金 |
| Feature — 獎金 | `feature:sa_config_edit` | SA 指標銷售配置 |
| Feature — 月報 | `feature:monthly_edit` | 月報版面 / 筆記 |
| Feature — 匯出 | `feature:export_bonus` | 獎金表匯出（Excel / PDF / 104 明細）|
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
| `INITIAL_ADMIN_PASSWORD` | **production 環境必填**（`NODE_ENV=production` 且 users 表為空時）。不再印隨機密碼到 stdout，避免 Zeabur log 外洩；長度 ≥ 10 字元 |

### 選填（部署相關）

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3001`（prod 容器固定 8080） | Express 服務埠 |
| `NODE_ENV` | （未設） | 設 `production` 時：cookie 加 `Secure` flag、`INITIAL_ADMIN_PASSWORD` 必填、錯誤訊息不外漏 |
| `POSTGRES_SSL` | `false` | `false` / `disable` 關閉 TLS；`require` / `true` 啟用 TLS 但接受自簽；`strict` / `verify` 嚴格驗憑證鏈 |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | `app.set('trust proxy', ...)` 值。Zeabur 等反代環境用預設即可；若改 `true` 會信任任意 XFF，攻擊者可偽造 IP 汙染稽核 |
| `CORS_ALLOWED_ORIGINS` | （空） | 跨域白名單（逗號分隔）。同源不受影響 |
| `INTERNAL_API_TOKEN` | 自動隨機 | 多 process 部署時必須顯式指定；同行程內部 loopback 呼叫用 |
| `AUDIT_ALERT_WEBHOOK` | （空） | 資安告警 Webhook URL（`lib/auditAlerts.js` 觸發 BRUTE_FORCE / MASS_DOWNLOAD 等時 POST JSON） |

### 選填（初始化密碼）

僅首次啟動、對應 row 不存在時生效，之後變更請從應用程式內改。

| 變數 | 用途 |
|------|------|
| `INITIAL_ADMIN_PASSWORD` | 第一個 super_admin 使用者（帳號 `admin`）的密碼。production 必填、dev 未設時自動產生隨機密碼印到 stdout 一次 |
| `INITIAL_SETTINGS_PASSWORD` | 系統設定頁（`/api/auth/settings`）的密碼 |

> **production 安全規則**：未設 `INITIAL_ADMIN_PASSWORD` 時 `initDatabase()` 會丟錯不建立 admin 帳號（避免 Zeabur log 保留隨機密碼外洩）。dev 模式維持舊行為自動產生並印 log。

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
│   ├── utils.js              # detectBranch / detectPeriod / num / pick / isExcelBuffer
│   ├── parsers.js            # Excel 中文欄位 alias 對應表
│   ├── batchInsert.js        # 批次 INSERT helper
│   ├── authMiddleware.js     # requireAuth / requirePermission / csrfProtect / 內部 token
│   ├── auditLogger.js        # auditMiddleware：自動記錄使用者操作
│   ├── auditAlerts.js        # 五類資安告警偵測器（BRUTE_FORCE / MASS_DOWNLOAD 等）+ Webhook
│   ├── auditCheckpoint.js    # 月度 hash-chain checkpoint + verify（防 audit_logs 竄改）
│   ├── bonusPeriodLock.js    # 期間鎖雙層（上傳次月初 + 獎金次月 25 日）
│   └── revenueActual.js      # 去年實績 fallback 計算（revenue / performance 共用）
│
├── routes/
│   ├── users.js              # /users/login（公開）、使用者管理（feature:user_manage）、帳號解鎖
│   ├── auth.js               # /auth/settings 設定頁密碼登入（公開）
│   ├── upload.js             # POST /upload 多檔 Excel 上傳（feature:upload_dms）
│   ├── uploadApproval.js     # 鎖期後的雙階段上傳簽核（pending → branch_approved → executed）
│   ├── stats.js              # 各廠統計 API（純讀，requireAuth）
│   ├── techHours.js          # 技師工時、產能、工位、群組設定
│   ├── bonus.js              # 獎金指標 / 目標 / 進度 / 名冊 / 電子簽核
│   ├── bodyshopBonus.js      # 鈑烤獎金申請 / 比對 / 結算
│   ├── promoBonus.js         # 銷售獎金規則與計算（檔名保留為 promoBonus）
│   ├── revenue.js            # 營收目標、預估、週次提交
│   ├── performance.js        # 業績指標定義 / 目標 / 上傳
│   ├── personTargets.js      # 個人業績目標、來源人員清單
│   ├── query.js              # 四大資料表查詢、income-config、working-days
│   ├── saConfig.js           # SA 指標銷售矩陣篩選設定
│   ├── techWage.js           # 工資代碼追蹤設定
│   ├── wip.js                # WIP 工單狀態
│   ├── vctl.js               # VCTL 商務政策指標
│   ├── managerReview.js      # 主管審核（mount 在 /api/manager-review）
│   ├── auditLogs.js          # 操作紀錄查詢 + 告警 / 清理雙人審核 / checkpoint 驗證
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
應用程式主入口。初始化 Express、安全標頭（helmet CSP / HSTS / X-Frame-Options）、CORS（env-driven 白名單）、cookieParser、CSRF 雙提交保護、`/api/users/login` rate limit（15 分 10 次），並將所有 `routes/` 掛載到對應路徑。

**啟動策略（04-23 改版）**：先 `app.listen()` 讓 `/health` 立即可用，`initDatabase()` 在背景**指數回退重試到成功為止**，避免「DB 短暫不可達就 `process.exit(1)` → container 重啟 → 無限 crash loop」。DB 未就緒前 `/api/*` 回 **503 `DB_NOT_READY`**（不再模糊 500）。`/health` 回 `{ ok:true, db_ready }` 方便運維一眼判斷「server 起來但 DB 還沒接好」狀態。

全域 error handler 統一接住 `next(err)`，印出 `pg err.code` / `err.detail` 到 server log，client 只看到 generic message（不外漏 stack trace / DB schema）。

DB 就緒後啟動三個背景工作：24h cleanup（sessions / audit_logs 180d / upload_history 365d）、`auditAlerts` 告警偵測（每 5 分鐘）、`auditCheckpoint` 月度 hash chain。

> 路由掛載順序有意義：含未驗證端點的 `users.js`（`/users/login`）、`auth.js`（`/auth/settings`）必須最早掛上，否則會被其他 router 的 `router.use(requireAuth)` 攔下回 401。

#### `Dockerfile`
Docker 映像定義。基於 `node:20-alpine`，安裝 production 依賴後啟動 `node index.js`，對外埠口為 8080，供 Zeabur 雲端自動部署使用。

#### `package.json`
定義 npm 依賴與啟動腳本。主要依賴：`express`（Web 框架）、`pg`（PostgreSQL）、`@e965/xlsx`（Excel 解析，CVE 修補 fork）、`multer`（檔案上傳）、`cors`、`cookie-parser`、`helmet`（安全標頭）、`express-rate-limit`（登入暴力破解防護）、`dotenv`。

---

### 資料庫層 `db/`

#### `db/pool.js`
建立並匯出 PostgreSQL 連線池（`pg.Pool`），從環境變數 `POSTGRES_CONNECTION_STRING` 讀取連線字串。SSL 由 `POSTGRES_SSL` env var 控制（預設關閉，對應目前 Zeabur Postgres）。

- `max: 10`, `connectionTimeoutMillis: 10_000`（DB 不可達時讓請求快速失敗，不讓 client 痴等 30s+ TCP handshake）、`idleTimeoutMillis: 30_000`（避免 Zeabur 內部 NAT 悶掉殭屍連線）
- `statement_timeout: 30_000` — 單一 statement 最長 30s，防慢查詢拖死整個 pool
- `query_timeout: 30_000` — client 端保險（PG server 沒回應時保護 Node）
- `idle_in_transaction_session_timeout: 60_000` — `BEGIN` 後若 idle 超過 60s 自動 ABORT，防忘了 COMMIT/ROLLBACK 卡住連線
- `pool.on('error')` 必接：idle client 斷線不接會變 uncaught exception → 整個 process 掛掉

所有 routes 皆透過此 pool 執行 SQL 查詢。

#### `db/init.js`
啟動時執行的自動建表腳本(約 560 行)。以 `CREATE TABLE IF NOT EXISTS` 建立所有資料表,並以 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 補充新欄位,確保部署時不影響現有資料、無須手動執行 SQL。除了業務資料表之外也建立 `users` / `user_sessions` / `user_permissions` / `audit_logs`,並 bootstrap 第一個 super_admin 帳號(密碼讀 `INITIAL_ADMIN_PASSWORD` 或隨機產生)。

額外的 DB 層保護：
- **`audit_logs` 防 UPDATE**：`BEFORE UPDATE TRIGGER` + `RAISE EXCEPTION 'audit_logs is append-only'`（從舊 `RULE DO INSTEAD NOTHING` 升級。RULE 是 query rewrite 且靜默失敗，TRIGGER 是 row-level 且立即報錯，攻擊者無法誤以為竄改成功）。`DELETE` 仍開放給雙人審核 cleanup 流程。
- **金額 CHECK 約束**：`bonus_extra` 與 `manager_review` 表加 `CHECK (amount BETWEEN -500000 AND 500000) NOT VALID`，防 app 層驗證被繞過時直接 INSERT 巨額。`NOT VALID` 對既有違規 row 寬容（不會升級失敗），新 INSERT/UPDATE 一律檢查。改動上下限時需同步 `routes/bonus.js` 的 `MAX_EXTRA_BONUS` 與 `routes/managerReview.js` 的 `MAX_MANAGER_REVIEW`。

> ⚠️ `ALTER TABLE` 語句必須置於對應 `CREATE TABLE` 之後,否則全新部署時會因資料表尚不存在而啟動失敗。

---

### 工具函式庫 `lib/`

#### `lib/utils.js`
全域共用小工具，提供：
- `pick(obj, keys)` — 篩選物件欄位
- `num(val)` — 安全轉換為數字（處理 null / undefined）
- `safeStr(val)` — **Excel 公式注入防護**。儲存格若以 `= + - @ \t \r \n \v \f` 開頭，自動 prefix 單引號讓 Excel 不執行公式。內部會先剝除 leading invisible chars（`\s` + BOM `﻿` + ZWSP/ZWNJ/ZWJ + WJ），防止 `' =cmd'` / `'​=cmd'` 之類的「假空白前綴」繞過。任何寫進 DB 後可能再被匯出 XLSX 的字串欄位都應透過此函式處理。
- `parseDate(val)` — 日期格式解析
- `detectBranch(filename)` — 從檔名識別據點代碼（AMA / AMC / AMD）
- `detectPeriod(filename)` — 從檔名擷取六位數期間（YYYYMM）

#### `lib/parsers.js`
各 Excel 報表的**中文欄位別名對應表**。將 DMS 匯出的中文欄名（如「服務顧問」、「帳類」）對應到資料庫英文欄位名（如 `service_advisor`、`account_type`）。是 `upload.js` 解析 Excel 的核心依賴。

內部用 `sstr = (v) => safeStr(String(v ?? '').trim())` 包裝所有字串欄位（取代舊的 `String(...).trim()`），順序刻意先 trim 再 safeStr，避免 ` =cmd` 之類的前置空白繞過 prefix 檢查。

> 若 DMS 報表格式異動（欄名改變），只需更新此檔的對應設定即可，無需修改路由邏輯。

#### `lib/batchInsert.js`
提供 `batchInsert()` 函式,將解析後的大量資料列以批次 `INSERT` 方式寫入 PostgreSQL,避免逐筆 INSERT 造成的效能問題。由 `upload.js` 於 Excel 解析完成後呼叫。

#### `lib/authMiddleware.js`
身份驗證、CSRF 與權限中介層，匯出：

- `requireAuth(req, res, next)` — 要求合法 session token（優先讀 `dms_token` cookie，退回 `Authorization: Bearer`）。SQL 同時驗 **絕對過期 + 30min 閒置**；命中後節流更新 `last_activity`。失敗回 401。
- `requirePermission(key)` — 工廠函式，檢查使用者是否擁有該權限，失敗回 403；super_admin 自動通過。
- `softAuth` — 只附加 `req.user`，不阻擋未登入。
- `csrfProtect(req, res, next)` — **double-submit cookie** CSRF 驗證。GET/HEAD/OPTIONS、`/api/users/login`、`/api/users/logout`、內部呼叫、無 cookie 的純 Bearer client 皆豁免；其餘 mutation 必須帶 `X-CSRF-Token` header 且等於 `dms_csrf` cookie。掛於 `/api` 前做全域守門。
- `scopeBranch(req, requested)` — **廠別查詢約束（防 horizontal IDOR）**。super_admin 任意；其餘使用者必須 ∈ 自己可見廠別集合（`req._branchAllowSet`，由 `loadBranchScope` 預載），未指定 → 強制綁定主要廠，越權回 `null`。
- `loadBranchScope(req, res, next)` — 把使用者的 `branch:XXX` 權限集合載入 `req._branchAllowSet`，給 `scopeBranch` 用。讀取型 router 應在 `requireAuth` 之後 `router.use(loadBranchScope)`。
- `branchScopeMiddleware({ writes = false } = {})` — 路由級工廠：自動 scope `?branch=XXX`，越權回 403 `BRANCH_FORBIDDEN`，未指定則綁主要廠。`writes: false`（預設）只 scope GET（避免破壞寫入端點 body 的 branch 語意）；純讀型路由（如 stats）可改 `writes: true`。
- `canGrantPermission(granterRole, targetRole, perm)` — **權限授予矩陣**。super_admin 任意；branch_admin 只能授予給 user 角色，且禁止授予 `feature:user_manage` / `feature:password_reset` / `feature:approve_upload_branch` / `feature:sys_config_edit`（避免造影子管理員）。
- `internalAuthHeaders()` — 同 process 內部 fetch loopback 用，取得帶 `X-Internal-Service: <token>` 的 header 物件。**警告**：`INTERNAL_API_TOKEN` 等同 super_admin 完全接管，配合 `x-internal-user-id` 可代任意使用者執行寫入。永遠不要寫進 log / metrics 標籤、不要放前端 / CI artifact / Slack；建議季度輪換；多 instance 部署一定要設明確值（不能讓各 process 各自隨機，否則 loopback fetch 會 401）。
- `ALL_PERMISSIONS` / `PAGE_PERMISSIONS` / `BRANCH_PERMISSIONS` / `FEATURE_PERMISSIONS` / `LEGACY_PERMISSIONS` / `SUPER_ADMIN_PERMISSIONS` — 權限鍵值定義表。

#### `lib/auditLogger.js`
Express 全域中介層，攔截 `res.end` 事件，將每次已驗證請求（或登入嘗試）非同步寫入 `audit_logs`。包含：

- 自動依 method + path 推算 `action`（VIEW / CREATE / UPDATE / DELETE / UPLOAD / LOGIN / PWD_CHANGE…）。
- `RESOURCE_LABELS` / `SKIP_PATTERNS` 控制顯示名稱與略過頻繁路由（如 `/api/periods`、`/health`）。
- **真實 username**：login handler 尚未由 `requireAuth` 設 `req.user` → route 自己 stash `req._audit_user` / `req._audit_username` / `req._audit_detail`，middleware 於 `res.end` hook 讀取，確保失敗登入也記錄到嘗試的帳號名而非 `anonymous`。
- IP 解析透過 Express `req.ip`（依 `trust proxy` 設定解析 XFF），避免攻擊者偽造汙染稽核。
- 也匯出 `writeLog(req, overrides)` 供路由手動補記特殊事件。

#### `lib/auditAlerts.js`
背景資安告警偵測器，每 5 分鐘掃描 `audit_logs`，偵測五類異常並寫入 `audit_alerts`（同 `signature` 1 小時內去重）：

- `BRUTE_FORCE` — 單一 IP 短時間多次登入失敗
- `MANY_AUTH_FAIL` — 跨帳號的集中攻擊
- `MASS_DOWNLOAD` — 異常大量 DOWNLOAD 動作
- `MULTI_LOCK` — 短時間多個帳號被鎖
- `SUSPICIOUS_DELETE` — 非 super_admin 的大量 DELETE

觸發時可選擇透過 `AUDIT_ALERT_WEBHOOK` env var 指定的 URL 發 POST JSON。settings 頁 🚨 banner 由此表驅動，super_admin 可 acknowledge / 認領告警。

#### `lib/auditCheckpoint.js`
稽核資料 **tamper-evidence**：每月第一天為上個月的 `audit_logs` 做 SHA-256 摘要 + `prev_hash` 串鏈，寫入 `audit_checkpoints`。若有人改了歷史 row，後續 verify 會對不上。

- 月度 scheduler 自動建 checkpoint
- 提供 verify endpoint 讓 super_admin 隨時驗證某月的 hash chain 是否完整
- 搭配 DB 層 `audit_logs_no_update` rule 阻擋 UPDATE（DELETE 仍開放給 cleanup job / 2-admin 審核）

#### `lib/bonusPeriodLock.js`
期間鎖檢查中介（雙層：上傳鎖 + 獎金鎖）。匯出：

- `checkUploadPeriodLock(period, res, req)` — 上傳層（次月第一個工作日 17:59 鎖）。鎖定後寫入 DMS 四大檔 / 業績或營收目標 / 鈑烤申請回 423 Locked。
- `checkBatchUploadPeriodLock(periods, res, req)` — 批次版（多個 period 時用，如營收目標原生 Excel 一次寫 12 個月）。
- `checkBonusPeriodLock(period, res, req)` / `checkPeriodLock(...)` — 獎金層（次月 25 日 23:59 鎖）。鎖定後獎金規則 / 額外獎金 / 主管考核 / 電子簽核 / 銷售獎金 / 鈑烤獎金 無法寫入。
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
銷售/專案獎金的計算邏輯（約 260 行；檔名保留為 `promoBonus.js`、DB 表為 `promo_bonus_configs`、API 前綴為 `/api/promo-bonus/`，僅 UI 字串改名為「銷售獎金」）。處理短期激勵方案或活動期間的額外獎金，獨立於一般月績效獎金之外。

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

- `/api/query/repair_income` / `tech_performance` / `parts_sales` / `business_query` — 支援篩選、排序、關鍵字搜尋，無筆數上限（供前端 XLSX 匯出）
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
使用者帳號系統（完整實作）：

- `POST /api/users/login` — 帳密驗證、帳號鎖定檢查、建立 `user_sessions`，發 `dms_token` HttpOnly cookie + `dms_csrf` cookie；回應同時帶 `token` / `csrf_token` 供 Bearer client 使用
- `POST /api/users/logout` — 撤銷當前 token，清 cookie
- `GET  /api/users/me` — 取得目前使用者 + 權限清單
- `GET  /api/users` / `POST` / `PUT /:id` / `DELETE /:id` — 使用者管理（`feature:user_manage`）
- `PUT  /api/users/:id/password` — 改密碼（本人需提供舊密碼；管理員可重設下級）。改密碼會 `DELETE FROM user_sessions WHERE user_id=$1` 強制踢出
- `POST /api/users/:id/unlock` — super_admin 解鎖永久鎖定的帳號
- `PUT  /api/users/me/profile` — 更新顯示名稱
- `GET  /api/users/permissions-schema` — 回傳前端用的權限定義表

**Session 規格**：絕對 4 小時 + 閒置 30 分（見 `SESSION_ABSOLUTE_MS` / `SESSION_IDLE_MS`）。
**密碼規格**：pbkdf2-sha256 / **600,000 iterations** / 16-byte salt / 最小長度 10 字元。舊 100k hash 登入成功後即時重算升級。
**帳號鎖定**：`LOCK_THRESHOLD=3` 次錯誤觸發 15 分暫鎖；解鎖後再錯 3 次觸發永久鎖（`requires_manual_unlock=true`，需 super_admin 解）。

`role` 三層：`super_admin` / `branch_admin` / `user`，`canManageRole()` 強制不可越權編輯（branch_admin 只能管 user；不能改自己）。改 role / branch / is_active / permissions 任一項會撤銷該使用者所有 session，防權限延後生效。

#### `routes/uploadApproval.js`
上傳簽核系統，給**鎖期後**仍需補傳的使用者用。雙階段審核：

- `POST /api/upload-requests` — 一般使用者發起申請，上傳檔案 + reason；狀態 `pending`
- `POST /api/upload-requests/:id/approve-branch` — 據點主管（`feature:approve_upload_branch`）一階通過 → `branch_approved`
- `POST /api/upload-requests/:id/approve-super` — super_admin 二階通過 → 透過 `internalAuthHeaders()` + `x-internal-user-id` 以發起者身分**代為 replay** 實際上傳端點 → `executed`。replay 加 5 min `AbortController` hard timeout，避免 fetch 永久 hang
- `POST /api/upload-requests/:id/reject` — 兩階段皆可拒 → `rejected`
- `POST /api/upload-requests/:id/withdraw` — 發起者自己撤回 → `withdrawn`
- `GET /api/upload-requests` — 列表（依角色過濾：自己的 / 自己廠的 / 全部）
- 7 天自動過期（`expires_at` default）

**Watchdog**：本檔在 module load 時啟動 `sweepStuckSuperApproved`（啟動 60s + 每 5min），把卡在 `super_approved` 超過 10 分鐘且無 `executed_at` / 無 `execute_error` 的 row 標 `execute_error`，讓管理員看到並手動處理。**不自動重執行**避免雙重寫入。

**`extra_*` 欄位白名單**：multipart body 裡 `extra_*` 開頭的欄位只接受 `extra_year` / `extra_dataType` 兩個白名單 key、且 value 必須是 string|number；其他全部忽略，防止 `__proto__` 等敏感 key 透過 form 注入。

#### `routes/auditLogs.js`
稽核紀錄查詢 + 告警 / 清理 / 驗證（`requireAuth`）：

- `GET /api/audit-logs` — 操作紀錄查詢（支援使用者 / 日期 / 動作 / keyword ILIKE 篩選、分頁；keyword 走 pg_trgm GIN 索引）
- `GET /api/audit-alerts` — 目前未認領的告警清單（前端 🚨 banner 用）
- `POST /api/audit-alerts/:id/ack` — super_admin 認領告警
- `POST /api/audit-cleanup` — 發起 audit_logs 清理申請（keep_days + reason）
- `POST /api/audit-cleanup/:id/approve` — **雙人審核**：審核者必須 ≠ 發起者，通過後才實際刪
- `GET /api/audit-checkpoints` — 月度 hash-chain checkpoint 列表
- `POST /api/audit-checkpoints/verify?period=YYYY-MM` — 重算上月摘要並比對，super_admin 用

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
**資料查詢頁面**。提供四大資料表的全文搜尋介面，支援篩選、排序、欄位切換、分頁（50/100/200/500 筆），並可匯出 XLSX（使用 `@e965/xlsx`，數字欄位保留 number 型態可直接加總）。

#### `public/bonus.html`
**獎金表頁面**（需權限）。顯示各廠人員名冊（在職/留職停薪/本月離職），以及依指標設定計算的個人達成率與應領獎金。支援獎金指標管理（DMS 來源、職稱分層階梯、科別篩選、計算據點覆蓋）。

畫面四個尾欄：**額外獎金** / **銷售獎金** / **主管考核** / **總獎金**（各自獨立顯示）。

**匯出**（`feature:export_bonus`）分三種格式、三個獨立檔案：

| 格式 | 檔名 | 內容 |
|------|------|------|
| 📊 Excel | `獎金表_<period>_<branch>.xlsx` | 首頁「獎金彙總」+ 各廠分頁，7 欄壓縮：姓名/職務/狀態/**績效**/**銷售**/主管考核/總獎金 |
| 📄 PDF | 另存 PDF | 同 Excel 版型，含電子簽核簽名格 |
| 🧾 104 明細 | `104獎金表明細_<period>_<branch>.xlsx` | 三個工作表（績效/銷售/主管考核）的 104 人資薪資匯入格式 |

**重要：匯出時的數字規則**
- **績效獎金** = 各指標獎金加總（**不含**額外獎金）。
- **銷售獎金** = 原銷售獎金 + **額外獎金**（104 薪資匯入慣例，畫面上仍分開顯示）。
- **無輸入金額預設為 0**（Excel / PDF 不再顯示空白）。
- 金額全 0 但有姓名的員工列**仍保留**，便於核對全員名單。

**104 明細細節**
- 欄位：員工編號 / 科目代碼 (`A016`) / 幣別代碼 (`NTD`) / 加扣金額 / 加扣起始日 / 加扣終止日 / 薪資明細說明 / 備註 / 部門 / 姓名。
- 加扣期間 = `period` 的**次一個月份**（例：`period=202603` → 加扣 `20260401~20260430` → 5 月核發薪資）。跨年 / 閏年以 `new Date(nextY, nextM, 0).getDate()` 自動處理。
- 薪資明細說明 = 加扣月 + 類別（例 `202604績效獎金`），不跟 period。
- 排序：`售後服務處 → AMA → AMC → AMD → 聯合 → 鈑烤 → 零件 → 其他`，同廠內依部門、姓名。
- 全員納入（含 0 元 / 無金額者）。
- 每筆資料列依廠別套用淺色底色（AMA 淺藍、AMC 淺綠、AMD 淺黃、聯合 淺紫、鈑烤 淺橘、零件 淺蒂芙尼、售後服務處 極淺灰）。
- 資料來源：計算當下蒐集至全域 `_bonusExportList`（免重解 DOM）。必須先切到「獎金名單」分頁完成計算後才能匯出。

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
| `promo_bonus_configs` | 銷售獎金規則(含 tier 階梯、role_amounts、target_factories；表名保留 `promo_` 前綴) |
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

> `repair_item`（交修項目名稱）為 `TEXT`；DMS 匯出常把多筆交修串接成一格，實測會超過 200 字，故不用 `VARCHAR(n)`。

---

## API 文件

> 所有 API 皆需 session。瀏覽器透過 `dms_token` HttpOnly cookie 自動帶（登入後由 server Set-Cookie）；curl / Postman 改帶 `Authorization: Bearer <token>`。**狀態變更請求**（POST / PUT / PATCH / DELETE）另需 `X-CSRF-Token` header（值 = `dms_csrf` cookie），`public/auth.js` 的 `fetchWithAuth` 會自動補上。下表「權限」欄列出 mutation 所需的 `requirePermission` 值；空白代表只需登入。
>
> **共通錯誤碼**：`401 UNAUTHORIZED`（未登入 / 過期 / 閒置超時）、`403 FORBIDDEN`（無權限）、`403 CSRF_FAIL`（CSRF token 驗證失敗）、`403 ACCOUNT_LOCKED_TEMP`（帳號暫時鎖定）、`403 ACCOUNT_LOCKED_PERM`（帳號永久鎖定，需管理員解）、`423 PERIOD_LOCKED`（期間已鎖）、`503 DB_NOT_READY`（伺服器啟動中 DB 尚未就緒）、`429`（登入 rate limit）。

### 帳號 / Session

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| POST | `/api/users/login` | (公開) | 帳密登入；Set-Cookie `dms_token` + `dms_csrf`，回應 `{ token, csrf_token, user:{id,username,display_name,role,branch,permissions}, expires_at, idle_timeout_ms }` |
| POST | `/api/users/logout` | requireAuth | 撤銷 token |
| GET  | `/api/users/me` | requireAuth | 取得目前使用者 |
| GET  | `/api/users` | feature:user_manage | 使用者列表 |
| POST | `/api/users` | feature:user_manage | 新增使用者 |
| PUT  | `/api/users/:id` | feature:user_manage | 更新基本資料 / 權限 |
| DELETE | `/api/users/:id` | feature:user_manage | 刪除使用者 |
| PUT  | `/api/users/:id/password` | requireAuth | 改密碼(自己需舊密碼) |
| PUT  | `/api/users/me/profile` | requireAuth | 更新顯示名稱 |
| GET  | `/api/users/permissions-schema` | requireAuth | 權限定義表 |
| POST | `/api/users/:id/unlock` | super_admin | 解鎖永久鎖定帳號 |
| GET  | `/api/audit-logs` | requireAuth | 操作紀錄 |
| GET  | `/api/audit-alerts` | requireAuth | 目前未認領告警 |
| POST | `/api/audit-alerts/:id/ack` | super_admin | 認領告警 |
| POST | `/api/audit-cleanup/:id/approve` | super_admin | 雙人審核通過稽核清理 |
| POST | `/api/audit-checkpoints/verify` | super_admin | 驗證某月 hash chain |

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
| `/api/bonus/promo-dept-mode` | `feature:promo_bonus_edit` | 銷售獎金部門模式（團體 vs 個人）|
| `/api/bonus/progress` | — | 獎金進度計算 |
| `/api/bonus/roster` / `/roster-summary` | — | 人員名冊查詢（含留停 / 復職過濾）|
| `/api/bonus/roster/:period/:emp_id` | `feature:bonus_metric_edit` | 人工調整廠別 / 部門 |
| `/api/bonus/signatures` | `feature:bonus_sign` | 獎金電子簽核（每期每廠一份） |
| `/api/promo-bonus/configs` | `feature:promo_bonus_edit` | 銷售獎金規則 CRUD |
| `/api/promo-bonus/results` | — | 銷售獎金計算結果 |
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
- 額外獎金 / 銷售獎金 / 主管考核 **不受影響**。
- 團體制（`scope_type='dept'`）：任一 dept-scope 指標觸發 → 所有團體池歸 0，池徽章與個人分配一致。

**獎金類別（畫面顯示 vs 匯出聚合）**

畫面尾欄四格各自獨立：**額外獎金** / **銷售獎金** / **主管考核** / **總獎金**。

匯出（Excel / PDF / 104 明細）時按 104 薪資匯入慣例重分類：

| 匯出欄位 | 包含項目 |
|----------|---------|
| 績效獎金 | 各指標獎金加總（**不含**額外獎金） |
| 銷售獎金 | 原銷售獎金 + **額外獎金**（L-4 的額外欄併入 L-3 的銷售欄） |
| 主管考核 | 原主管考核（可正可負） |
| 總獎金 | 上三者合計（與畫面上的總獎金一致，只是拆分方式不同） |

**命名對照表（「促銷」→「銷售」）**

2026-04-22 起 UI 全改稱「銷售獎金」。為了不動遷既有資料與 API 呼叫端，以下程式識別名保留 `promo_` 前綴：

| 識別類別 | 保留名 |
|---------|-------|
| 檔案 | `routes/promoBonus.js`、`lib/` 相關 helper |
| DB 表 | `promo_bonus_configs` |
| API 路徑 | `/api/promo-bonus/*`、`/api/bonus/promo-dept-mode` |
| 權限鍵 | `feature:promo_bonus_edit` |
| 前端全域變數 | `_promoApiResults`、`_promoTeamModeCache`、`isPromoTeam` 等 |

新增功能時請沿用「銷售獎金」為顯示字串、`promo_*` 為程式識別名。

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
| **獎金鎖** | 次月 25 日 23:59 | `lib/bonusPeriodLock.js` → `checkBonusPeriodLock()` | 獎金指標、額外獎金、主管考核、電子簽核、銷售獎金規則、鈑烤獎金 |

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
5. 錯誤處理一律用 `next(err)`，讓全域 error handler 統一處理（不要自己 `res.status(500).json({error: err.message})` 外漏 pg 訊息）。
6. 若要記 audit log 以外的特殊事件，在 handler 內 `await writeLog(req, {action:'XXX', ...})`。
7. 前端**一律**用 `DmsAuth.fetchWithAuth('/api/...')`，它會自動帶 cookie + `X-CSRF-Token`；不要直接 `fetch(...)`，否則 mutation 會被 CSRF middleware 403。

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

### 增加一個獎金計算規則(銷售獎金)
1. 在 `promo_bonus_configs.rule_type` 加新 enum 值。
2. `routes/promoBonus.js` 的 `/promo-bonus/results` handler 內增加 `else if (cfg.rule_type === 'xxx')` 分支。
3. 前端 bonus.html 的銷售獎金設定 modal 加對應 UI。

### 某個 endpoint 401 / 403 / 503
- **401 `UNAUTHORIZED`** = cookie/token 無效 / 絕對過期 / 閒置 30 分 → 重新登入
- **403 `FORBIDDEN`** = 已登入但無對應 feature/page 權限 → 去 settings「使用者管理」勾上
- **403 `CSRF_FAIL`** = 前端沒帶 `X-CSRF-Token` header 或值不符；檢查是否用 `DmsAuth.fetchWithAuth`
- **403 `ACCOUNT_LOCKED_TEMP` / `ACCOUNT_LOCKED_PERM`** = 帳號被鎖；暫時鎖等 15 分或 super_admin 解
- **423 `PERIOD_LOCKED`** = 期間已鎖；super_admin 可 bypass，一般使用者走 `/api/upload-requests` 申請簽核
- **503 `DB_NOT_READY`** = server 剛起 DB 還沒接好，等 10~30 秒自動恢復（詳見 FAQ）
- **「未登入或登入已過期」出現在登入端點本身** = router mount 順序錯了，`users.js` 和 `auth.js` 必須掛在最前

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
INITIAL_ADMIN_PASSWORD=            # production 必填，長度 ≥ 10

# 選填（部署）
NODE_ENV=production                # 啟用 cookie Secure flag / 錯誤訊息不外漏
PORT=8080
POSTGRES_SSL=false                 # require / strict 開啟 TLS
TRUST_PROXY=loopback, linklocal, uniquelocal   # Zeabur 反代環境預設即可
CORS_ALLOWED_ORIGINS=              # 逗號分隔，跨域才需設
INTERNAL_API_TOKEN=                # 多 process 部署需顯式指定
AUDIT_ALERT_WEBHOOK=               # 資安告警觸發時 POST JSON 的目標 URL

# 選填（首次啟動初始密碼，建議設定後刪除）
INITIAL_SETTINGS_PASSWORD=
```

完整說明見 [環境變數](#環境變數)。

### Zeabur 部署流程

1. 推送到 GitHub 對應 branch → Zeabur 自動觸發部署。
2. **啟動策略**：server 先 listen（`/health` 可用避免 Zeabur 冷啟動殺 container），`initDatabase()` 在背景**指數回退重試**；DB 就緒前 `/api/*` 一律回 `503 DB_NOT_READY`，就緒後自動恢復。判斷方法：
   ```bash
   curl https://<host>/health
   # { "ok": true, "db_ready": true }   ← 期待這個
   ```
3. **首次部署**：
   - **production 必須設 `INITIAL_ADMIN_PASSWORD`**（`NODE_ENV=production`），否則 `initDatabase()` 拒絕建立 admin 帳號（避免雲端 log 保留隨機密碼外洩）
   - 登入後立即透過「個人設定」改密碼（雖然你已經用 env 設的密碼登入了，還是建議換一次，並把 env 清掉）
   - 若用到獨立設定頁，也請把 `INITIAL_SETTINGS_PASSWORD` 改掉
4. **日常部署**：
   - 程式碼 / SQL schema 異動皆透過 `initDatabase()` 自動處理（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`），不需手動 SQL
   - DB 短暫不可達不再造成 container crash-loop（04-23 改背景重試）
5. **DB 異動** 之後仍需重新上傳的 Excel 限縮到「欄位定義改變」的情況，大多數變動可直接生效

> ⚠️ 資料表結構異動絕對不要用 `DROP TABLE`，以免清空 prod 資料。
> ⚠️ Zeabur / 任何雲端環境不要 `TRUST_PROXY=true`（會信任任意 XFF → 攻擊者可偽造 IP 汙染稽核與 rate limit）。保留預設 `loopback, linklocal, uniquelocal` 即可。

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
USER node                    # 不以 root 跑 node（04-23 補）
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

### 路由掛載順序（易錯點）

`index.js` 內 router mount 順序**有意義**，由上至下：

1. `helmet` / `cors` / `express.json` / `express.urlencoded` / `cookieParser`
2. `express.static`（公開前端檔）
3. `auditMiddleware`（log 所有已驗證請求）
4. `csrfProtect`（掛於 `/api` 前；豁免清單見 `lib/authMiddleware.js::CSRF_EXEMPT_PATHS`）
5. `loginLimiter`（`/api/users/login` 15 分 10 次）
6. **DB readiness gate**（04-23 新增，`/api/*` 未就緒 → 503 `DB_NOT_READY`）
7. `users.js` 路由（含未驗證 `/users/login` → 必須最早掛上，否則被其他 router 的 `router.use(requireAuth)` 攔回 401）
8. 其他業務路由
9. `/health`
10. 全域 error handler（終點）

新增含未驗證端點的 router 時請依此處理；新增 mutation 端點記得確認前端有走 `DmsAuth.fetchWithAuth`（帶 CSRF token），不然會被 403。

### 前端 fetch token 注入

`public/auth.js` 在每個頁面載入時提供 `DmsAuth.fetchWithAuth(url, options)` 包裝：

- 自動帶 cookie（`credentials: 'include'`）
- 自動補 `X-CSRF-Token` header（讀 `dms_csrf` cookie）
- 401 → 自動導回 `/login.html`

新建 HTML 頁面必加 `<script src="/auth.js"></script>`，且頁面內呼叫 API 一律走 `DmsAuth.fetchWithAuth`（不要直接 `fetch`），否則 mutation 會被 CSRF middleware 403。`auth.js` 已不再操作 `localStorage.dms_token`（HttpOnly cookie 接手後 JS 根本讀不到，也讀不到才安全）。

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

**登入回 503 `DB_NOT_READY`**
- 正常現象：container 剛起、`initDatabase()` 還沒連上 DB；等 10~30 秒自動恢復
- 長時間不恢復：檢查 `POSTGRES_CONNECTION_STRING` 是否正確、DB 實例是否健康
- 驗證：`curl https://<host>/health` 看 `db_ready` 是否翻 true
- `initDB` 每次失敗會印 `[initDB] 嘗試 N 失敗：…` 到 Zeabur log

**登入回 500（DB 已 ready 但仍掛）**
- 走全域 error handler，log 會印 `[unhandled] POST /api/users/login code=… msg=… detail=… stack=…`
- 常見原因：schema 欄位缺漏（對照 `db/init.js` 的 users 表 ALTER 清單）、pbkdf2 iterations 記錯、pg 連線中斷
- 先看 pg `err.code` 定位：`42P01`（表不存在）、`42703`（欄位不存在）、`08006`（連線失敗）

**帳號被鎖定**
- 3 次錯 → 15 分暫鎖：過 15 分自動解，或由 super_admin 透過 `POST /api/users/:id/unlock` 立即解
- 連 2 輪都錯 → 永久鎖（`requires_manual_unlock=true`）：只能靠 super_admin 解
- 鎖定狀態下連登入 API 都會直接拒絕（不再驗密碼）避免持續 DoS

**CSRF token 驗證失敗（403 `CSRF_FAIL`）**
- 新頁面載入時會透過 `/api/users/me` 重新拿到 cookie；若頁面長時間未刷新、cookie 過期就會錯
- 前端 `DmsAuth.fetchWithAuth` 會自動補 header；自行寫 `fetch(..., {method:'POST'})` 會踩雷
- 純 Bearer client（curl）不帶 `dms_token` cookie → 自動豁免 CSRF

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

## 資安修補對應表

> 完整滲透測試報告見 `docs/PENTEST_REPORT_2026-04-24.md`（v1）與 `docs/PENTEST_REPORT_2026-04-24_v2.md`（v2 復測 + 新攻擊面）。下表彙整所有實際修補的對應 OWASP / CWE 分類，方便日後 audit 對照。

### 認證 / 授權（OWASP A01 / A07）
| 議題 | 修補位置 | 說明 |
|---|---|---|
| 廠別 horizontal IDOR | `lib/authMiddleware.js::scopeBranch` + `branchScopeMiddleware`，套用 11 個 router | super_admin 任意；其餘必須 ∈ 自己廠；越權回 403 BRANCH_FORBIDDEN |
| branch_admin 造影子管理員 | `lib/authMiddleware.js::canGrantPermission`，users.js POST/PUT 兩處 | branch_admin 不得授予 user_manage / password_reset / approve_upload_branch / sys_config_edit |
| login timing oracle | `routes/users.js::dummyVerify`，5 個 login 分支 + 4 個 password reset 分支 | 帳號不存在 / 停用 / 鎖定 / 缺欄位 / 不存在 ID 全跑 dummy PBKDF2 |
| `locked_until` ISO 時戳洩露 | `routes/users.js` | 改回 `minutes_remaining` 整數 |
| login rate-limit IPv6 /64 繞過 | `index.js` | 雙層 limiter（IP 10/15min + username 5/15min） |
| password reset 404 → user_id 枚舉 | `routes/users.js` | 不存在 ID 改回 401 + dummyVerify |
| INTERNAL_TOKEN 風險揭露 | `lib/authMiddleware.js:34` 文件 | 等同 super_admin、勿入 log、季度輪換、多 instance 必設明值 |

### 注入（OWASP A03）
| 議題 | 修補位置 | 說明 |
|---|---|---|
| Excel 公式注入（CSV injection） | `lib/utils.js::safeStr` + `lib/parsers.js::sstr` | `= + - @ \t \r \n \v \f` 開頭加單引號；先剝 leading invisible chars 防 ` =cmd` / BOM / ZWSP 繞過 |
| `LIKE` wildcard 濫用 | `routes/notes.js` GET `/notes` | prefix 必填且 escape `\ % _` 為字面字元 |
| stored XSS via roster Excel | `public/bonus.html`（17 處 `innerHTML` sink） | `esc()` 純文字 sink；onclick 用 `esc(JSON.stringify(...).slice(1,-1))` 雙層編碼 |
| PG 錯誤訊息洩 schema | 18 個 route 共 149 處 | `res.status(500).json({error:err.message})` → 通用訊息 + `console.error` |

### 業務邏輯 / 資料完整性（OWASP A04）
| 議題 | 修補位置 | 說明 |
|---|---|---|
| 財務金額無上下限 | `routes/bonus.js` MAX_EXTRA_BONUS / `managerReview.js` MAX_MANAGER_REVIEW / `bodyshopBonus.js` rate audit | extra-bonus / manager-review ±500_000；bodyshop income 夾擠 ≥ 0 |
| App 層被繞過時直接 INSERT 巨額 | `db/init.js::ensureAmountChecks` | DB 層 `CHECK (amount BETWEEN -500000 AND 500000) NOT VALID` |
| `notes.js` 任何登入者讀全部月報 | `routes/notes.js` GET 加 `requirePermission('page:monthly')` |
| audit cleanup `keep_days` 缺下界 | `routes/auditLogs.js` approve | 再驗 ≥ 30，防 DB row 被竄改後一鍵刪光 |
| super-approve 後 replay 失敗狀態不一致 | `routes/uploadApproval.js` | 5 min `AbortController` + 10 min watchdog 標記卡住 row（不自動重執行） |
| `extra_*` 欄位放任 | `routes/uploadApproval.js` | 白名單 `extra_year` / `extra_dataType` + 限 string\|number |

### 完整性 / 防竄改（OWASP A08）
| 議題 | 修補位置 | 說明 |
|---|---|---|
| `audit_logs` UPDATE 防護 | `db/init.js` | RULE → BEFORE UPDATE TRIGGER + RAISE EXCEPTION（row-level、會報錯而非靜默） |
| `audit_logs` DELETE 雙人審核 | `routes/auditLogs.js` | 申請 → 另一 super_admin approve → 才實際 DELETE |
| 月度 hash-chain checkpoint | `lib/auditCheckpoint.js` | 每月第一天為上月 audit_logs 算 SHA-256 + 串鏈 |

### 通訊 / 設定（OWASP A05）
| 議題 | 修補位置 | 說明 |
|---|---|---|
| 慢查詢 / 卡死交易 → pool DoS | `db/pool.js` | `statement_timeout: 30s` + `idle_in_transaction_session_timeout: 60s` + `query_timeout: 30s` |
| Loopback fetch DNS / port 風險 | `routes/bonus.js` + `routes/personTargets.js` | `localhost` → `127.0.0.1`、PORT env regex 驗證、metric_id / period 格式檢查 + encodeURIComponent |
| CSRF token 雙暴露 | `routes/users.js` login | 不再回 response body，只透過 `dms_csrf` cookie 派送（前端 `auth.js::_readCookie`） |
| CSRF token entropy | `routes/users.js` | `crypto.randomBytes(32)`（256-bit，OWASP 建議） |

### 已知 deferred 項目
| 議題 | 狀態 | 原因 |
|---|---|---|
| CSP `unsafe-inline` 移除 | **暫不動** | 全站 491 處 inline `onclick=`（settings 139 / bonus 119 / stats 93 / monthly 73 / performance 34 / query 13 / approvals 9 / login 1）；移除需把全部改 `addEventListener`，估 1 週 + 全頁回歸測試。前置：先加 `Content-Security-Policy-Report-Only` 蒐集真實 violation 資料 1-2 週再分頁逐個改 |
| Cookie 顯式 `domain` | **暫不動** | 單機部署不需；多子網域時才需顯式設 |

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
