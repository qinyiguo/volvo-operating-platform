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

## Session `01TaGue54CzED2ZwuRpLPaC1`（2026-04-20 當前 session）

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

## 統計
- 3 天合計 53 個可見 non-merge commit（04-18 資安強化之 PR #1–#7 已 squash，本數未列入）
- 加上 04-21 session 的 8 個 commit，本週期可見 non-merge commit 共 61 個
- 主軸：**全站資安強化**（04-18 當日公告）、**獎金表電子簽核 + 匯出版型**、**月報 Executive 模式**、**手機響應式**、**Light Mode 補洞**、**權限分級（獎金指標設定 vs 獎金簽核）**、**獎金表 UX / 計算邏輯收尾**（04-21）
