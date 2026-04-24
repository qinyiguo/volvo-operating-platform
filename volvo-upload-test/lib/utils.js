/**
 * lib/utils.js
 * -------------------------------------------------------------
 * 跨檔共用的小工具。
 *
 *   pick(row, ...keys)     取第一個非空值（for Excel 欄位 alias）
 *   num(val)               安全轉 number（NaN → 0）
 *   parseDate(val)         轉 YYYY-MM-DD
 *   parseDateTime(val)     轉 ISO 字串（+08:00）
 *   detectFileType(fn,sh)  依檔名 / sheet 名判斷是哪張 Excel 報表
 *   detectBranch(fn)       檔名中的 AMA / AMC / AMD
 *   detectPeriod(fn)       檔名中的 6 位 YYYYMM
 *
 * 主要被 routes/upload.js 與 lib/parsers.js 使用。
 */
const pick = (row, ...keys) => {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
};

const num = (val) => { const n = parseFloat(val); return isNaN(n) ? 0 : n; };

// Excel CSV/Formula injection 防護：儲存格若以 = + - @ Tab CR LF 開頭，
// 在被別人用 Excel 開啟時會被當公式執行（=cmd|'/c calc'!A1, =HYPERLINK(...)）。
// 寫入 DB 前先 prefix 一個單引號，Excel 顯示時會吃掉前綴但不執行公式。
// 對純數字欄位（num()）不必呼叫；只用在會原樣顯示在 XLSX 匯出/前端的字串。
//
// 防繞過：
//  1. 「真前綴 char」涵蓋 = + - @ Tab CR LF VT FF（覆蓋全部 ASCII 控制字元裡會被 Excel 誤判為公式的 prefix）
//  2. 「假空白前綴」攻擊：' =cmd' / '​=cmd' / BOM=cmd 會在 Excel 開啟前被
//     Excel 自動 trim → 變成 '=cmd' 仍被當公式。所以判斷前先剝除 leading
//     space / BOM / zero-width chars，再對剩下的 string 做 prefix 檢查。
const FORMULA_PREFIX = /^[=+\-@\t\r\n\v\f]/;
const LEADING_INVISIBLE = /^[\s﻿​‌‍⁠]+/;
const safeStr = (val) => {
  if (val === null || val === undefined) return '';
  // 剝除 leading invisible chars 後再判斷；保留尾端空白以利上層自行 trim
  const s = String(val).replace(LEADING_INVISIBLE, '');
  return FORMULA_PREFIX.test(s) ? "'" + s : s;
};

const parseDate = (val) => {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const m = String(val).trim().match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : null;
};

const parseDateTime = (val) => {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val) ? null : val.toISOString();
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[\s T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:${m[6]||'00'}+08:00`;
  const dm = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return dm ? `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}T00:00:00+08:00` : null;
};

const detectFileType = (fn, sheets) => {
  const f = fn.toLowerCase();
  if (f.includes('技師績效')||f.includes('工資明細')) return 'tech_performance';
  if (f.includes('維修收入')||f.includes('收入分類')) return 'repair_income';
  if (f.includes('零件銷售')||f.includes('零件明細')) return 'parts_sales';
  if (f.includes('業務查詢')) return 'business_query';
  if (f.includes('零配件比對')||f.includes('零配件對照')||f.includes('parts_catalog')) return 'parts_catalog';
  const n = (sheets||[]).join(',');
  if (n.includes('工資明細')||n.includes('技師績效')) return 'tech_performance';
  if (n.includes('維修收入')||n.includes('收入分類')) return 'repair_income';
  if (n.includes('零件銷售')||n.includes('零件明細')) return 'parts_sales';
  if (n.includes('業務查詢')) return 'business_query';
  return null;
};

const detectBranch = fn => {
  const f = fn.toUpperCase();
  if (f.includes('AMA')) return 'AMA';
  if (f.includes('AMC')) return 'AMC';
  if (f.includes('AMD')) return 'AMD';
  return null;
};

const detectPeriod = fn => { const m = fn.match(/(\d{6})/); return m ? m[1] : null; };

// ── Excel 檔頭驗證（防偽造副檔名上傳惡意內容）──
// xlsx / xlsm / xltx：ZIP 容器（PK\x03\x04）
// xls：OLE2 複合文件（D0CF11E0A1B11AE1）
const XLSX_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const XLS_MAGIC  = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

function isExcelBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (buf.subarray(0, 4).equals(XLSX_MAGIC)) return true;
  if (buf.subarray(0, 8).equals(XLS_MAGIC))  return true;
  return false;
}

// 給 multer.fileFilter 使用：擋掉副檔名不對的檔案；內容驗證（magic bytes）放在
// 各 route 的 handler 開頭呼叫 isExcelBuffer，因為 multer.fileFilter 拿不到 buffer。
function excelFileFilter(req, file, cb) {
  const ok = /\.(xlsx?|xlsm|xltx)$/i.test(file.originalname || '');
  if (!ok) return cb(new Error('只接受 .xlsx / .xls / .xlsm / .xltx 檔'));
  cb(null, true);
}

module.exports = {
  pick, num, safeStr, parseDate, parseDateTime,
  detectFileType, detectBranch, detectPeriod,
  isExcelBuffer, excelFileFilter,
};
