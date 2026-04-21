/**
 * lib/bonusPeriodLock.js
 * -------------------------------------------------------------
 * 期間鎖定：純計算、不寫 DB。分兩層：
 *
 *   A. 上傳鎖 uploadPeriodLockAt  —— 次月第一個工作日 17:59
 *      - DMS 四大檔 / 人員名冊 / 業績目標 / 營收目標 / 鈑烤申請
 *      - 目的：給獎金計算一個穩定的原始資料基礎，開月第一天就凍結來源
 *      - 工作日 = 非週六、非週日、非 1/1 元旦、非 5/1 勞動節
 *
 *   B. 獎金表鎖 bonusPeriodLockAt —— 次月 25 日 23:59
 *      - 獎金指標 / 目標 / 權重 / 手動實績 / 額外獎金 / 主管考核 /
 *        促銷規則 / 業務鈑烤獎金計算 / 檢查人簽核
 *      - 目的：主管仍有時間完成簽核，但月結帳前必須封存
 *
 *   super_admin 可跨越兩種鎖（維運需求），需透過 checkXxxLock 傳入 req。
 */

// ── A. 上傳鎖：次月第一工作日 17:59 ──
function isHoliday(d) {
  const mo = d.getMonth(), day = d.getDate();
  if (mo === 0 && day === 1) return true;   // 1/1 元旦
  if (mo === 4 && day === 1) return true;   // 5/1 勞動節
  return false;
}
function uploadPeriodLockAt(period) {
  if (!period || !/^\d{6}$/.test(String(period))) return null;
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4));      // 1-indexed
  const d = new Date(y, m, 1, 17, 59, 0, 0);   // 次月 1 號 17:59
  for (let safety = 0; safety < 14; safety++) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(d)) break;
    d.setDate(d.getDate() + 1);
  }
  return d;
}
function isUploadPeriodLocked(period) {
  const t = uploadPeriodLockAt(period);
  return t ? Date.now() >= t.getTime() : false;
}

// ── B. 獎金表鎖：次月 25 日 23:59 ──
function bonusPeriodLockAt(period) {
  if (!period || !/^\d{6}$/.test(String(period))) return null;
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4));      // 1-indexed
  // Date 月份 0-indexed → 次月即 m；日 25、23:59
  return new Date(y, m, 25, 23, 59, 0, 0);
}
function isBonusPeriodLocked(period) {
  const t = bonusPeriodLockAt(period);
  return t ? Date.now() >= t.getTime() : false;
}

// ── Express helpers：403 擋下並 return true；super_admin 放行 ──
function checkPeriodLock(period, res, req) {
  if (!period) return false;
  if (req && req.user && req.user.role === 'super_admin') return false;
  if (isBonusPeriodLocked(period)) {
    const lockAt = bonusPeriodLockAt(period);
    res.status(403).json({
      error: '此期間（' + period.slice(0,4) + '/' + period.slice(4) + '）獎金表已鎖定（僅系統管理員可修改）',
      locked: true,
      lock_at: lockAt && lockAt.toISOString(),
    });
    return true;
  }
  return false;
}

function checkUploadPeriodLock(period, res, req) {
  if (!period) return false;
  if (req && req.user && req.user.role === 'super_admin') return false;
  if (isUploadPeriodLocked(period)) {
    const lockAt = uploadPeriodLockAt(period);
    res.status(403).json({
      error: '此期間（' + period.slice(0,4) + '/' + period.slice(4) + '）原始資料已鎖定（僅系統管理員可再上傳）',
      locked: true,
      lock_at: lockAt && lockAt.toISOString(),
      lock_type: 'upload',
    });
    return true;
  }
  return false;
}

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

// 批次上傳（多期間）鎖定檢查
function checkBatchUploadPeriodLock(periods, res, req) {
  if (req && req.user && req.user.role === 'super_admin') return false;
  const uniq = [...new Set((periods || []).filter(Boolean))];
  for (const p of uniq) {
    if (isUploadPeriodLocked(p)) {
      const lockAt = uploadPeriodLockAt(p);
      res.status(403).json({
        error: '批次中含已鎖定原始資料期間（' + p.slice(0,4) + '/' + p.slice(4) + '），整批拒絕',
        locked: true,
        lock_at: lockAt && lockAt.toISOString(),
        lock_type: 'upload',
      });
      return true;
    }
  }
  return false;
}

module.exports = {
  // 獎金表鎖
  bonusPeriodLockAt, isBonusPeriodLocked,
  checkPeriodLock, checkBatchPeriodLock,
  // 上傳鎖
  uploadPeriodLockAt, isUploadPeriodLocked,
  checkUploadPeriodLock, checkBatchUploadPeriodLock,
};
