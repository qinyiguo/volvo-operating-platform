/**
 * lib/bonusPeriodLock.js
 * -------------------------------------------------------------
 * 獎金期間鎖定：純計算、不寫 DB。
 *
 * 規則：期間 YYYYMM 的獎金，在「次月第一個工作日 17:59」後鎖定。
 *   工作日 = 非週六 / 週日 / 元旦（1/1）。春節等其他國定假日若落在
 *   月初偶發狀況，可由 super_admin 人工覆蓋。
 *   例：202603 → 2026/04/01（週三）17:59
 *       202612 → 2027/01/04（週一，跳過 1/1 元旦 + 週末）17:59
 *
 * 被 routes/bonus.js、routes/managerReview.js、routes/bodyshopBonus.js
 * 等共用。
 */

function isHoliday(d) {
  // 會落在「月初」且日期固定的國定假日：元旦、勞動節。
  // 其他浮動假日（春節、清明等）若剛好撞上，由 super_admin 人工覆蓋。
  const mo = d.getMonth();      // 0-indexed
  const day = d.getDate();
  if (mo === 0 && day === 1) return true;   // 1/1 元旦
  if (mo === 4 && day === 1) return true;   // 5/1 勞動節
  return false;
}

function bonusPeriodLockAt(period) {
  if (!period || !/^\d{6}$/.test(String(period))) return null;
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4)); // 1-indexed
  // 從次月 1 號 17:59 開始（Date month 參數 0-indexed，故 m 就是次月）
  const d = new Date(y, m, 1, 17, 59, 0, 0);
  // 若為週末或元旦 → 往後推到第一個工作日
  for (let safety = 0; safety < 14; safety++) {
    const dow = d.getDay();            // 0 Sun / 6 Sat
    if (dow !== 0 && dow !== 6 && !isHoliday(d)) break;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function isBonusPeriodLocked(period) {
  const t = bonusPeriodLockAt(period);
  return t ? Date.now() >= t.getTime() : false;
}

/**
 * Express helper：若 period 已鎖定，回 403 並 return true（呼叫端應立即 return）。
 * 用法：`if (checkPeriodLock(period, res, req)) return;`
 *
 * super_admin 可跨越鎖定（維運需求）；傳入 req 才能識別角色。
 * 未傳 req（舊呼叫）→ 一律以一般使用者對待。
 */
function checkPeriodLock(period, res, req) {
  if (!period) return false;
  if (req && req.user && req.user.role === 'super_admin') return false;
  if (isBonusPeriodLocked(period)) {
    const lockAt = bonusPeriodLockAt(period);
    res.status(403).json({
      error: '此期間（' + period.slice(0,4) + '/' + period.slice(4) + '）資料已鎖定（僅系統管理員可修改）',
      locked: true,
      lock_at: lockAt && lockAt.toISOString(),
    });
    return true;
  }
  return false;
}

/**
 * 批次寫入時：若 entries 中任何一筆的 period 已鎖定 → 擋下整批。
 * 回傳 true = 已回 403，呼叫端應 return；false = 繼續執行。
 */
function checkBatchPeriodLock(periods, res, req) {
  if (req && req.user && req.user.role === 'super_admin') return false;
  const uniq = [...new Set((periods || []).filter(Boolean))];
  for (const p of uniq) {
    if (isBonusPeriodLocked(p)) {
      const lockAt = bonusPeriodLockAt(p);
      res.status(403).json({
        error: '批次中含已鎖定期間（' + p.slice(0,4) + '/' + p.slice(4) + '），整批拒絕',
        locked: true,
        lock_at: lockAt && lockAt.toISOString(),
      });
      return true;
    }
  }
  return false;
}

module.exports = { bonusPeriodLockAt, isBonusPeriodLocked, checkPeriodLock, checkBatchPeriodLock };
