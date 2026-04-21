/**
 * lib/bonusPeriodLock.js
 * -------------------------------------------------------------
 * 獎金期間鎖定：純計算、不寫 DB。
 *
 * 規則：期間 YYYYMM 的獎金，在「次月 25 日 23:59」後鎖定。
 *   例：202603 → 2026/04/25 23:59 後鎖定
 *
 * 被 routes/bonus.js、routes/managerReview.js、routes/bodyshopBonus.js 等共用。
 */

function bonusPeriodLockAt(period) {
  if (!period || !/^\d{6}$/.test(String(period))) return null;
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4)); // 1-indexed
  // 次月 25 日 23:59（month 參數為 0-indexed，所以次月就是 m）
  return new Date(y, m, 25, 23, 59, 0, 0);
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
