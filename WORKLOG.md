# 工作日誌

> 期間：2026-04-18 ~ 2026-04-20
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

## 統計
- 3 天合計 53 個 non-merge commit
- 主軸：**獎金表電子簽核 + 匯出版型**、**月報 Executive 模式**、**手機響應式**、**Light Mode 補洞**、**權限分級（獎金指標設定 vs 獎金簽核）**
