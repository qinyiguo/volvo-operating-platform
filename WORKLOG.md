# 工作日誌

> 期間：2026-04-18 ~ 2026-04-21
> 彙整方式：依 commit message 末尾的 `session_xxx` 反推 session，配合時間排序。

---

## Session `01HZpAfC6F5TswTJ4sW55GmE`（主力開發 session，2026-04-19 ~ 04-20）

### 獎金表 — 電子簽核
- `79ec5b1` 新增 `bonus_signatures` 資料表與檢查人簽核 canvas modal；每廠一人、可重簽/撤銷、套用期間鎖定
- `162433e` 簽名與簽核時間帶入 PDF / Excel 匯出
- `12465d4` 匯出：各廠獨立簽章格；PDF 每據點強制分頁

### 獎金表 — 期間鎖定
- `278472a` A4 直式 PDF + 次月最後一天 23:00 鎖定
- `e5c8364` 抽出 `lib/bonusPeriodLock.js`；補齊 8 個寫入端點的鎖檢查

### 獎金表 — 匯出版型重塑
- `df1fbae` Excel 欄位收斂為 績效 / 促銷 / 主管考核
- `82ac07a` 主管考核理由獨立區塊
- `090035e` 顏色 / 框線 / 對齊
- `a303a83` 文字列跨欄合併
- `0c8384d` 獎金彙總首頁、5 格簽章列（含董事長室）、左對齊合併文字
- `ea196c5` 匯出 Excel 移入「獎金名單」tab；移除重複按鈕
- `ec0215c` 按鈕改名「匯出當月獎金表」+ Excel / PDF chooser modal
- `feb8062` PDF 完全比照 Excel 版型
- `c6a35f4` / `8612848` / `d4e2317` / `98ed158` / `80e28f5` 細節修復

### 獎金表 — UX 小修
- `1905d01` / `92b2609` 手動 K 儲存遺失 × 1000
- `efa9f79` 手動目標 modal 殘留前期值
- `77cb952` 主管考核金額可點擊彈窗
- `7060bf1` 促銷獎金明細彈窗 responsive + 可捲動
- `817c9ce` 促銷獎金規則列表收進設定 modal
- `7cfada1` 額外獎金下拉加入本月有獎金的離職人員
- `84e28f0` 工位設定：設定頁 → 各廠明細 / 周轉率右上

### 月報（Executive Mode）
- `6396eea` storyboard / 排名 / WIP health / 全域期間 / 簡報模式
- `ce75f69` 圖表視覺強化
- `c2e512f` notes canvas + GridStack 拖拉、版面持久化、樣板
- `63d913a` canvas follow-ups
- `69d7f2f` chartEnhancer TypeError 修復（改用 WeakMap）
- `e589df3` GridStack 版面未存檔（change event 簽名錯誤）
- `0854dc0` info card 不再蓋住圖表、sub-charts 加 YTD

### Stats
- `5d1cbc1` 上月結清狀況改跟選定期間而非系統日期

---

## Session `01TaGue54CzED2ZwuRpLPaC1`（2026-04-20 ~ 04-21，跨日 session，分支 `claude/fix-signature-saving-5gxKw`）

### 04-20 部分
- `607dcf7` 各據點主管無法儲存簽名：`/bonus/signatures` 權限改為 `page:bonus`
- `af00b3a` 導入獨立權限 `feature:bonus_sign`（獎金簽核）
  - `authMiddleware` 註冊新權限
  - 簽核端點改用此權限
  - `settings.html` 加勾選
  - `db/init.js` 啟動時自動補給既有 `page:bonus` 使用者
  - auditLogger 標記 `/api/bonus/signatures` 為「獎金簽核」
- `db88cd3` 手機版響應式修補：
  - `bonus.html` 加 768px / 480px 斷點、inline grid 單欄化、簽名 canvas 縮高
  - `monthly_report.html` 加 480px，`.kpiRow` 單欄
  - `settings.html` `.modal-close` 44×44、權限 grid 單欄

### 04-21 權限模型大改（細緻化）
- `faa3aa8` 01:23 granular permission model + role presets
  - 角色、頁面、功能權限分層；內建 admin / data_staff / 據點主管 … 預設組合
- `e87cb05` 01:44 nav 隱藏沒權限的連結、修補關聯 UI gap
- `fc15466` 01:55 匯出權限：獎金表 / 查詢 / 明細 / 月報 / 稽核 各自 guard

### 04-21 業績
- `90160ae` 02:39 集團天數進度不應把 3 廠工作天加總（應取集團單位）

### 04-21 期間鎖定分層
一開始 bonus 鎖死在月底 → 多次調整最終拆成「上傳層」月初鎖 + 「獎金層」次月 25 日鎖
- `1b7f09e` 02:48 期間鎖定提醒：頁面載入 / 切換期間時都顯示
- `00adb54` 02:52 鎖定時點從月底 23:00 → 次月 25 日 23:59
- `68a7cdb` 03:27 補齊所有跨月寫入端點的鎖檢查；super_admin bypass
- `a625a1d` 03:41 鎖定時點調為次月第一個工作日 17:59
- `e973be1` 06:26 **分層鎖**：上傳鎖（月初）+ 獎金鎖（25 日）
- `25208a5` 06:30 `/bonus/upload-roster` 移除上傳鎖（HR 對帳彈性）

### 04-21 legacy 清理 & 主題
- `cde8014` 03:00 移除舊「系統管理員密碼」設定（orphan `settings_password`）
- `21dcd2d` 03:05 grey 文字對比提升（修 dark-mode 可讀性）
- `2ff15d3` 03:14 真正修法：inline grey hex → CSS vars（取代單純 selector hack）

### 04-21 上傳簽核（locked period 兩階段）
- `76c77fa` 04:05 鎖期後仍允許上傳，但必須兩階段簽核
- `af617a0` 04:26 「上傳簽核」從 設定 底下提升為獨立 nav 連結
- `cc47562` 05:35 進一步拉成頂層獨立頁面 `/approvals.html`

### 04-21 獎金指標 Modal（為 fix-bonus-reset-logic 鋪路）
- `d566bd9` 06:43 移除「實績期間」override — 所有分頁共用單一期間選擇
- `772a0e2` 07:07 獎金規則三項改善：
  - 套用對象 picker 簡化（summary chips + 預設收合）
  - 階梯金額 per-tier mode 切換（`flat` ↔ `per_role`）
  - 「未達標歸零」threshold checkbox（寫入 `bonus_rule.zero_below_rate`，為當日後續連動歸零的 PR 做基礎）

合計 04-21 此 session 共 18 個 non-merge commit。

---

## Session `01X3Czqv5t8BTvrsdpUCcAwe`

此 repo 的 commit 歷史找不到此 session 的標註。可能的原因：
1. 只有問答 / 研究，沒產生 commit
2. 工作在其他 repo
3. commit message 未帶 session 連結

若補得到對話摘要或時間範圍可再併入。

---

## 未標註 session 的早期 commit（2026-04-18 ~ 04-19 凌晨）

### 資安強化（2026-04-18，系統更新公告）
本日最大項目為全站資安強化，相關 commit 多在早期 PR（#1–#7）已 squash-merge，`git log` 不可見；以下依當日更新公告歸檔：

**安全性**
- 全站 API 全面加上登入驗證：獎金、薪資、目標、檔案上傳、系統設定等敏感功能一律需登入 + 授權；未登入或無權限直接拒絕
- 移除系統內建預設密碼 `admin1234`；首次部署時隨機產生，或由 `INITIAL_ADMIN_PASSWORD` 環境變數指定
- 系統設定密碼改加密儲存（PBKDF2 + salt），不再以明文存於 DB；舊密碼登入後自動升級為加密格式
- 拒絕 `?_token=` URL query 登入方式，只接受 `Authorization: Bearer`，避免 token 外流到瀏覽紀錄、Referer、server log

**傳輸與跨網域**
- 限制 CORS 來源：未授權網域無法呼叫本系統 API
- PostgreSQL 連線可切換 SSL，適配不同部署環境（`DATABASE_SSL` 環境變數）

**前端與顯示**
- 修正獎金頁面 XSS：錯誤訊息與檔名顯示全部 HTML-escape
- 前端自動帶入登入 token：升級後不需重複登入即可使用各頁功能

### WIP 未結工單（04-18）
- `b763f01` KPI 區重構為更清楚的 call-to-action
- `7c945ea` 由上而下 drill-down 重組
- `9a2a6cd` Modal status tab 計數跟隨主要篩選
- `43c583e` 狀態註解歷史存入 SQL 並在編輯器顯示
- `049ccdd` KPI 布局存檔後被舊模板覆蓋修復

### 主題統一（04-18）
- `c6b9bcc` Light / Dark 切換統一
- `a98bbfe` 各頁 inline style 補 light-theme override

### Performance 改版（04-19 凌晨）
- `f6503c0` Hero 區改為 narrative status card
- `e14c7d7` 9 卡 → 3×3 矩陣 + YoY 修復
- `0596d22` revKPI-sub 布局填滿寬度
- `feaa1ee` SA matrix 小計橫捲穿透修復

### 其他
- `de5455b` README 重組
- `8c3a0fd` 檔頭 docblock 補齊
- `ed62814` Excel 上傳從設定頁 → 業績頁 modal
- `73907fe` 廠別下拉加入「售後服務處」
- `e3c5217` / `ed3b7ae` / `d997fb4` monthly_report light-theme 修補
- `bb0c439` 促銷獎金規則按鈕改名、預設展開
- `b6540ce` PDF 頁尾淡字修復

---

## Session `claude/fix-bonus-reset-logic-tOTi4`（2026-04-21，bonus 表 UX / 邏輯精修）

分支：`claude/fix-bonus-reset-logic-tOTi4`（8 commits）。全部在 `public/bonus.html`，最後一筆延伸到 `routes/bonus.js` + `db/init.js`。

### 獎金計算 — 未達標歸零連動（4112e9c）
- `calcBonus` 抽出 `isZeroBelowTriggered()` helper
- 廠別總計迴圈與部門級 per-person 迴圈在加總前先掃描各指標，偵測任一觸發即 `zeroOutAll=true`，整組績效獎金歸 0（原本只歸零「觸發的那一項」，旁邊的績效獎金仍照領）
- 團體制 `scope='dept'` 獎金池也納入：任一 dept-scope 指標觸發 → 所有池歸 0，池徽章與分配一致
- 額外獎金 / 促銷獎金 / 主管考核 不受影響；「未達標歸零」提示文字同步更新

### 獎金名單 — 排序改依職等（84d1607, d45604b, 1899e7a）
- `memberRows.sort` 由 `total desc` 改成：職務排名 → 總獎金 desc → 姓名
- 新增 `jobTitleRank(title)` keyword 清單：董事長 → 總經理 → 副總 → 處長 → 資深協理 → 協理 → 廠長 → 資深經理 → 技術長 → 經理 → 副理 …
- 技術長位置微調：原本在資深經理之上 → 改放在資深經理下方、一般經理之上
- 技師類細化：資深技師 / L4 → L3 → L2 → L1 → L0 技師 / 高級美容技師 / 美容技師 / 洗車美容 / 實習生；較具體的關鍵字排在「技師」之前避免被泛用詞搶匹配

### 匯出版型 — 簽核欄修整（d87b155）
- HTML 獎金彙總頁、Excel 彙總頁、頁面列印區：由左至右統一改為 **董事長室 → 總經理室 → 最高主管 → 單位主管 → 承辦人**
- `.signRow` CSS 格線由 `1fr 1.4fr 1fr 1.4fr 1fr` → `repeat(5,1fr)`，五格等寬（原本單位主管 / 總經理室寬 40%）

### 廠別排序（9511c84）
- `FACTORY_ORDER` / `ORDER` / `FC_ORDER` 三個常數統一：`AMA → AMD → AMC` → **`AMA → AMC → AMD`**
- 人員名單、獎金名單、部門分群渲染皆套用

### 獎金規則 Modal 精簡（4290650）
- 標題：新增指標 → **新增獎金規則**；儲存指標 → **儲存**
- 移除：「說明」、「規則說明」（含遺留的孤兒 `</div>`）、「單位」、「排列順序」
- 主頁上「編輯指標」按鈕 tooltip 同步改名
- 編輯現有規則時，`description / unit / sort_order` 保留原值送回後端，不會被清空

### 留職復職日 + 當月濾選（13f0a52）
- Schema：`staff_roster` 新增 `reinstated_date DATE`（附 `ALTER TABLE IF NOT EXISTS` 升級既有 DB）
- Excel 解析：讀 `留職復職日` header（使用者慣例為 CW 欄位），UPSERT 一併寫入
- `activeFilter` 規則改寫：留職停薪者只在「`unpaid_leave_date` 在當月」或「`reinstated_date` 在當月」時留在獎金表名單；`f.param` → `f.params`（2 參數），4 個呼叫端同步更新
- `/bonus/roster-summary` 的 `unpaidLeave` 清單套用相同規則，附帶 `reinstated_date` 回傳
- UI：新進卡片顯示到職日（藍）；留職停薪卡片顯示「停薪 YYYY-MM-DD」（黃）+「復職 YYYY-MM-DD」（綠）
- 效果：3/21 留職停薪 → 3 月有、4 月沒有；4/10 復職 → 4 月重新出現

---

## Session `claude/fix-upload-error-dYN1c`（2026-04-22，業務查詢上傳失敗修補 + 獎金表匯出大整修）

分支：`claude/fix-upload-error-dYN1c`（10 commits，跨兩項主題）。

### 維修業務查詢 Excel 上傳失敗 — `repair_item` 改 TEXT（37a32f3）
- 症狀：上傳 `維修業務查詢-開單時間-2026{01..04}.xls(x)` 4 檔皆顯示失敗，後端 PostgreSQL 錯誤 `value too long for type character varying(200)`
- 原因：`business_query` 表僅 `repair_item`（DMS 的「交修項目名稱」）欄位是 `VARCHAR(200)`；DMS 匯出常把同工單多個交修項目串成一格，實測超過 200 字即被整批 INSERT 拒絕
- 修正：`db/init.js`
  - `CREATE TABLE business_query` 兩處（初始建表 + `work_order` 缺欄時的重建分支）：`repair_item VARCHAR(200)` → `repair_item TEXT`
  - 新增 `ALTER TABLE business_query ALTER COLUMN repair_item TYPE TEXT` 升級既有 DB
- 效果：部署後 4 支業務查詢檔可成功寫入，不再截斷

### 獎金表匯出整修（04fba05 → 10df8cf，8 commits）
完整重寫匯出輸出；資料來源由「DOM 解析」改為「計算當下蒐集的 `_bonusExportList`」；螢幕顯示欄位不動（仍有額外 / 銷售 / 主管考核 三獨立欄）。

**1. 額外獎金併入銷售獎金（04fba05 → 10df8cf）**
- Excel / PDF 匯出原本「績效獎金 = 各指標獎金加總 + 額外獎金」。改為 104 薪資匯入慣例：
  - 績效獎金 = 各指標獎金加總（**不含**額外）
  - 銷售獎金 = 原銷售獎金 + **額外獎金**
- 壓縮範圍由 `3..L-4` 改 `3..L-5`；cells[L-4]（額外）併入銷售欄。
- PDF 匯出原本未同步（績效仍含額外、銷售不含額外）→ 已修；兩種匯出數字現可對齊。

**2. 獎金表 Excel：0 預設值（dc2508f）**
- 績效 / 銷售 / 主管考核 / 總獎金 無值時原顯示空白，改為 `0`。
- 濾空規則放寬為「姓名 / 職務 / 狀態 皆空才濾」，金額全 0 但有姓名的列保留，方便核對全員名單。

**3. 新增 104 獎金表明細匯出（04fba05 → 4bbfa93）**
- 獨立函式 `exportBonus104()` 寫出單獨檔案 `104獎金表明細_<period>_<branch>.xlsx`，不混進獎金表 Excel。
- 匯出格式選擇 modal 由 2 鈕（Excel / PDF）擴為 3 鈕，新增「🧾 104 明細 — 薪資匯入格式」。
- 三個工作表（Tab）：**績效獎金** / **銷售獎金** / **主管考核**。
- 欄位（10 欄）：員工編號 / 科目代碼 (A016) / 幣別代碼 (NTD) / 加扣金額 / 加扣起始日 / 加扣終止日 / 薪資明細說明 / 備註 / 部門 / 姓名。
- 加扣期間 = `period` 的**次一個月份**（例：`period=202603` 3 月計算 → 加扣 `20260401~20260430` → 5 月核發）；跨年／閏年自動處理。
- 薪資明細說明 = 加扣月 + 類別（例：`202604績效獎金`），不再跟著 period。
- 排序：`售後服務處 → AMA → AMC → AMD → 聯合 → 鈑烤 → 零件 → 其他`；同廠依部門、姓名。
- 全員納入，含 0 元 / 無金額者（原本會被跳過）。
- 依廠別套用淺色底色（AMA 淺藍 / AMC 淺綠 / AMD 淺黃 / 聯合 淺紫 / 鈑烤 淺橘 / 零件 淺蒂芙尼 / 售後服務處 極淺灰），方便人眼掃描。

**4. 渲染期蒐集 `_bonusExportList`（04fba05）**
- 於 `renderProgressContent` 的 dept 迴圈內、`memberRows.sort` 後 push 每人 `{branch, branch_label, dept, dept_code, emp_id, emp_name, job_title, status, perfBonus, extraBonus, promoBonus, mrBonus, total}`。
- perfBonus 僅加總各指標獎金（不含額外 / 促銷 / 主管考核）。
- 供 `exportBonusExcel` / `exportBonus104` 共用，免重複 DOM 解析。

**5. `_applyBonusStyles` 支援可變欄寬（04fba05）**
- 原本 `dept / factory / noteTitle` 列的 merge 硬碼 `0..6`（7 欄假設）；改為 `0..maxC`，同時支援 7 欄主表與 10 欄 104 明細。
- 7 欄主表 `maxC=6` 時行為與原本相同。

**6. 全站顯示文字：促銷獎金 → 銷售獎金（8a96bde, 10df8cf）**
- `bonus.html`（43 處）、`settings.html`、`routes/bonus.js`、`db/init.js`、`lib/authMiddleware.js`、`lib/auditLogger.js`、`routes/promoBonus.js`、`lib/bonusPeriodLock.js` 的中文顯示字串與 docblock 全數改名。
- 程式識別名**保留不動**：`feature:promo_bonus_edit`、`/api/promo-bonus/*`、`promo_bonus_configs`、`_promoApiResults`、`_promoTeamModeCache`、`isPromoTeam` 等。只改 UI 字串與 log label。
- 第二波補掉單獨「促銷」字眼（團體/個人切換鈕、index 註解、settings 頁面簡介、兩份 docblock）。

**7. PDF 匯出同步修正（10df8cf）**
- `exportBonusPdf` 原本與 Excel 不一致：績效仍含額外、銷售只取原促銷。檢查後統一為同一套 `3..L-5` + `L-4+L-3` 邏輯，兩種匯出數字可對齊。

---

## 統計
- 3 天合計 53 個可見 non-merge commit（04-18 資安強化之 PR #1–#7 已 squash，本數未列入）
- 04-21 再補 26 個 non-merge commit：
  - session `01TaGue54CzED2ZwuRpLPaC1`（`fix-signature-saving-5gxKw` 分支續戰）= 18 個
  - session `claude/fix-bonus-reset-logic-tOTi4`（本日新開分支）= 8 個
- 04-22 再補 10 個 non-merge commit（`claude/fix-upload-error-dYN1c`）：
  - 業務查詢上傳失敗修補（repair_item TEXT）= 1 個
  - 獎金表匯出整修（104 明細 + 額外→銷售 + 0 預設 + 全站改名 + PDF 同步）= 9 個
- 本週期可見 non-merge commit 共 89 個
- 主軸：**全站資安強化**（04-18 當日公告）、**獎金表電子簽核 + 匯出版型**、**月報 Executive 模式**、**手機響應式**、**Light Mode 補洞**、**權限模型細緻化**（04-21 大改）、**期間鎖定分層（上傳 / 獎金）+ 兩階段簽核**（04-21）、**獎金表 UX / 計算邏輯收尾**（04-21）、**104 薪資匯入格式 + 類別重分配 + 促銷 → 銷售 改名**（04-22）

---

## Session `claude/fix-upload-error-dYN1c` 續（2026-04-23，資安全面重做 + 稽核系統四階段強化 + 部署 bug 收尾）

分支續跑一整天，從資安檢查報告出發，把系統安全姿態從「功能堪用」拉到「可對外」等級，然後在 Zeabur 實際部署後又陸續修了一堆連帶的 deploy-specific bug。共 11 個 commit。

### 1. 全面資安檢查與修補（45ff5f1）
基於 agent 做的 OWASP 風格檢查報告，分級處理：

**CRITICAL**
- **C1 SQL Injection** `routes/auditLogs.js` 6 支 query 把 `guard.branch` 直接拼接 SQL（源自 `users.branch` 欄位，super_admin 可寫）→ 全改 `$1` 參數綁定
- **C3 Login brute force**：`/api/users/login` 裝 `express-rate-limit` 15 分 10 次/IP

**HIGH**
- **H1** `helmet` + CSP + HSTS + X-Frame-Options + X-Content-Type-Options
- **H4** `uploadApproval` replay URL 改寫死 `127.0.0.1:${PORT}`，不信任 `req.headers.host`（防 Host header 注入把 internal auth header 外送）
- **H5** `lib/utils.js` 新 `isExcelBuffer` + `excelFileFilter`，6 個上傳 route 全套 magic bytes 驗證（防副檔名偽造 + zip bomb）
- **H6** CSV / XLSX 匯出 formula injection 防護（`= + - @ \t \r` 起頭補 `'`）— query / settings / stats / bonus 匯出全套
- **H7** 使用者 role / branch / is_active / permissions 變更 → `revokeAllSessions()` 撤銷所有 session
- **H8** global error handler 回 generic message，PG schema / err.message 不再外漏

**MEDIUM**
- **M1** auditLogger 吞錯改 `console.warn`
- **M2** `app.set('trust proxy')` + `req.ip` 代替手解 X-Forwarded-For（防偽 IP 汙染稽核）
- **M3** production 必填 `INITIAL_ADMIN_PASSWORD`，不再印隨機密碼到 stdout
- **M4** `.gitignore` / `.dockerignore` / `package-lock.json` / Dockerfile USER node + npm ci
- **M5** 密碼最小長度 6 → **10 字元**
- **M7** pbkdf2 100k → **600k**（OWASP 2023+）。加 `users.password_iterations` 欄位漸進升級：登入成功後若 iter < 600k 自動 rehash，使用者無感；`crypto.timingSafeEqual` 防時序攻擊

**H3**（動態 SQL 識別名）親自審計確認 `${fld}` / `${statExpr}` / `${col}` 皆由 ternary 從封閉字串集選出，是隱式 allowlist，不需動

### 2. xlsx CVE 修補 + HttpOnly cookie + CSRF + XSS 收尾（c93cfe4）
- **C2 xlsx@0.18.5 CVE**（GHSA-4r6h-8v6p-xvw6 / GHSA-5pgg-2g8v-p4x9）：
  - 伺服端：`package.json` npm alias `xlsx → @e965/xlsx@0.20.3`（SheetJS 官方維護鏡像）
  - 前端：stats.html / bonus.html fallback CDN 換 `@e965/xlsx@0.20.3`
- **C4 localStorage token → HttpOnly cookie + CSRF**：
  - Server 登入發 `dms_token` (httpOnly, secure, sameSite=lax, 8h) + `dms_csrf`（非 httpOnly 讓 JS 讀）
  - `requireAuth` / `softAuth` 優先讀 cookie，Bearer 保留相容 curl
  - `csrfProtect` middleware（double-submit cookie）：GET/HEAD/OPTIONS 豁免、內部服務豁免、純 API client（無 cookie）豁免、其他狀態變更請求必須 `X-CSRF-Token` 等於 `dms_csrf` cookie
  - `public/auth.js`：init() 不再靠 localStorage 判斷，直接打 `/api/users/me`；fetch 包裝自動加 `credentials` + 從 `dms_csrf` 讀 CSRF token 塞 header
  - `login.html`：登入後不寫 token 到 localStorage；logout 清兩個 cookie
  - `index.js`：加 `cookie-parser`；CSP 補 jsdelivr + cdnjs 白名單
- **XSS 掃尾**：query.html / monthly_report.html / approvals.html 全加 `window._h` HTML escape，`${e.message}` 全換 `_h(...)` 包裹

### 3. Session TTL 收緊 + 帳號鎖定（988cf83）
依 OWASP ASVS L2 對含個資系統的建議：
- **絕對 TTL: 8h → 4h**
- 新增**閒置 TTL: 30 min**（user_sessions 新 `last_activity` 欄位，resolveToken 檢查，每次有效請求更新，節流 <60s 不重複寫）
- 前端 `auth.js` 閒置偵測：30 分無操作自動登出 + 最後 1 分鐘黃底警告條
- **帳號鎖定狀態機**（`users` 表新 4 欄 `failed_login_count` / `locked_until` / `had_temp_lock` / `requires_manual_unlock`）
  - 3 次錯誤 → 暫時鎖 15 分
  - 之前被暫鎖過又再錯 3 次 → 永久鎖，需 super_admin 解
  - `POST /api/users/:id/unlock`（僅 super_admin）
  - settings 使用者管理頁：⏳ 暫時鎖 / 🔒 永久鎖徽章 + 🔓 解鎖按鈕
  - 新 audit action: `LOGIN_LOCK_TEMP` / `LOGIN_LOCK_PERM` / `ACCOUNT_UNLOCK`

### 4. 稽核系統四階段強化（1acdd4c）
agent 檢查後發現稽核系統嚴重資料缺口（所有登入事件 username='anonymous'、無告警、無防竄改）。分四階段處理：

**Phase 1 — 關鍵資料補強**
- 修 `username='anonymous'` bug：`writeLog` 支援 `req._audit_user / _audit_username / _audit_detail`，login handler 全路徑填真實 username + 結果描述（含「密碼錯誤（第 N/3 次）→ 觸發暫時鎖」）
- DELETE/UPDATE 補 `resource_detail`：`users`、`bonus_metrics`、`performance_metrics`、`revenue_targets`、`promo_bonus_configs` 五支 DELETE 先 SELECT 預存名稱後再刪，寫入明細；users PUT 只記敏感欄位 diff
- `pg_trgm` GIN 索引加速 ILIKE 搜尋 `resource_detail` / `resource`

**Phase 2 — 資安告警（`lib/auditAlerts.js`，每 5 分鐘掃）**
- **BRUTE_FORCE** 同 IP 1h 內 401 ≥ 20 → critical
- **MANY_AUTH_FAIL** 同帳號 1h 內失敗 ≥ 10 → high
- **MULTI_LOCK** 1h 內 ≥ 5 帳號被鎖 → critical
- **MASS_DOWNLOAD** 同帳號 10 分內 DOWNLOAD ≥ 100 → critical
- **SUSPICIOUS_DELETE** 10 分內 DELETE ≥ 20 / 非工作時間 DELETE ≥ 3 → high / medium
- 同 signature 1h 去重；`ALERT_WEBHOOK_URL` 發 Slack/Teams；設定頁頂端 🚨 banner + 認領按鈕

**Phase 3 — UI 優化**
- 點擊紀錄列彈詳細 modal
- CSV 匯出欄位挑選（per-user localStorage 記憶）
- 💾 存 / 📂 載篩選預設
- 稽核清理**雙人審核**（`audit_cleanup_requests` 表）：A super_admin 發起 → B 另一位核准才執行；24h 過期；防單一 rogue admin 洗稽核

**Phase 4 — Tamper-evidence（`lib/auditCheckpoint.js`）**
- 每月自動為上月做 SHA-256 hash + `chain_hash = SHA256(prev_hash || rows_digest)` 鏈式雜湊
- DB `RULE audit_logs_no_update` 阻擋 UPDATE（只能 DELETE 走雙人審核）
- `GET /audit-checkpoints/verify` 驗證單月或全部；失敗回 stored vs recomputed hash
- 設定頁「🔗 Hash Chain 防竄改驗證」區塊

### 5. 部署後連環 bug 收尾（90f94d9 → 3cfa37e 共 6 commit）

CSP 太嚴格 + 遷移後的連帶效應：

**90f94d9** 登入頁壞掉（CSP 擋 Google Fonts + CSRF 擋 login POST + form 預設 GET 洩密碼）
- `style-src` 加 `fonts.googleapis.com`、`font-src` 加 `fonts.gstatic.com`
- `csrfProtect` 豁免 `/api/users/login` + `/api/users/logout`（用 `req.originalUrl` 比對）
- login form 改 `method="post" action=""` 讓 fallback 也不會把帳密塞 URL

**fbc6a9f** 登入後 form 仍 native POST → `Cannot POST /login.html`
- 原本 `onsubmit="handleLogin(event);return false"` 在 handleLogin 拋例外時 `return false` 不會跑
- 三層防護：form method + 純 inline `event.preventDefault();return false` + `addEventListener(..., capture=true)`

**6e4068d** 點各廠明細 / 獎金表等頁面所有按鈕報 CSP 錯
- helmet 預設 `script-src-attr: 'none'` 獨立於 `script-src`，擋全站 `onclick="…"`
- 明確加 `script-src-attr` / `script-src-elem` / `style-src-attr` / `style-src-elem` 放行 inline event handler

**ddc6a35** 月報 gridstack / chart.js 載入失敗
- `connect-src` 只有 `'self'` 擋 library 動態 fetch sub-resource
- 放行 `cdn.jsdelivr.net` + `cdnjs.cloudflare.com`

**04654c8** agent bug-sweep 後一次修 4 個真實 bug
- **CSP unpkg** 沒白名單（monthly_report.html gridstack 三層 fallback jsdelivr → **unpkg** → cdnjs，jsdelivr 掛時 unpkg 被擋）→ 全 directive 加 `https://unpkg.com`
- **logout 根本沒發 POST**：`if (token)` 檢查 `localStorage.getItem('dms_token')`，cookie 時代永遠 null → POST 從未發 → server session 沒刪。改無條件 POST
- **fetchWithAuth 送 `Bearer null`** header：加 `if (token)` 才塞 Authorization
- **bonus.html 重複包 window.fetch**：覆蓋掉 auth.js 全域包裝，所有 POST/PUT/DELETE 漏 `X-CSRF-Token` → CSRF 403。移除這層

**633c295** 登出畫面不跳轉
- fetch 可能 hang 導致 `await` 卡住，redirect 永遠跑不到
- `AbortController` 3 秒強制 abort + `keepalive: true` + `window.location.replace`

**3cfa37e** Zeabur DB 連線 timeout → container crash loop
- `index.js` 原本 `initDatabase().catch(err => process.exit(1))` → DB 短暫掛就殺服務 → crash loop
- 改：先起 HTTP server 讓 `/health` 200，DB init 背景 async loop 指數回退 2/4/8/16/32s 永不放棄，成功後才啟動 cleanupStaleRows / auditAlertDetector / auditCheckpointScheduler
- `db/pool.js` 加 `connectionTimeoutMillis: 10_000` + `idleTimeoutMillis: 30_000` + `pool.on('error')` 接 idle 斷線
- `routes/bodyshopBonus.js` 原 require-time 同步 `initTable()` 改背景 loop + rethrow 讓 retry 看到失敗

---

## 統計更新
- 04-23 共 11 個 non-merge commit（`claude/fix-upload-error-dYN1c` 分支持續延伸）：
  - 資安全面修補（CRITICAL + HIGH + MEDIUM 共 14 項） = 3 個大 commit
  - 稽核系統四階段強化 = 1 個大 commit（含 3 個新 lib 檔 + 7 個新表 / 欄位 + ~1000 行）
  - Session / 帳號鎖定 = 1 個大 commit
  - 部署後連環 bug 修補 = 6 個
- 04-22 ~ 04-23 session 累計 21 個 non-merge commit，單分支 4.5k+ 行新增
- 本週期可見 non-merge commit 共 **100 個**
- 主軸（追加）：**OWASP 全面修補 + 稽核系統防竄改 + 帳號鎖定 + 部署韌性**（04-23，系統從「功能堪用」拉到「可對外上線」）
