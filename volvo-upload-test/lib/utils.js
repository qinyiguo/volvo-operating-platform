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

module.exports = { pick, num, parseDate, parseDateTime, detectFileType, detectBranch, detectPeriod };
