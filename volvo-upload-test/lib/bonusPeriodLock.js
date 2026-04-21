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
 * 用法：`if (checkPeriodLock(period, res)) return;`
 */
function checkPeriodLock(period, res) {
  if (!period) return false;
  if (isBonusPeriodLocked(period)) {
    const lockAt = bonusPeriodLockAt(period);
    res.status(403).json({
      error: '此期間（' + period.slice(0,4) + '/' + period.slice(4) + '）獎金表已鎖定，無法修改',
      locked: true,
      lock_at: lockAt && lockAt.toISOString(),
    });
    return true;
  }
  return false;
}

module.exports = { bonusPeriodLockAt, isBonusPeriodLocked, checkPeriodLock };
