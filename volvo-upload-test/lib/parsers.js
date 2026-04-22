/**
 * lib/parsers.js
 * -------------------------------------------------------------
 * 各 Excel 報表的中文欄位 alias 對應與 row 清洗。
 *
 * 匯出的 parse* 函式接收 xlsx sheet_to_json 後的陣列，
 * 回傳準備寫入 DB 的物件陣列。
 *
 * DMS 報表若改版（欄名換字），請來這裡改 alias 表，
 * 上層 routes/upload.js 不用動。
 */
const { pick, num, parseDate, parseDateTime } = require('./utils');

// 只排除「完全空白」或「純中文且無數字/英文」的值（真正的標題/合計列）
// 原本 isNoteRow 用 /[\u4e00-\u9fff]/ 太激進，把正常資料也過濾掉了
const isTitleRow = (v) => {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  if (!s || s === 'undefined' || s === 'null') return true;
  // 純中文（含全形括號空格）且無任何數字或英文 → 標題/合計列
  if (/^[\u4e00-\u9fff（）【】〔〕「」\s]+$/.test(s) && !/[A-Za-z0-9]/.test(s)) return true;
  return false;
};

// 舊名稱保留供相容（若其他地方有用到）
const isNoteRow = isTitleRow;

const parseRepairIncome = (rows, branch, period) => rows
  .filter(r => !isTitleRow(pick(r, '工作單號', '工單號')))
  .map(r => ({
    period, branch,
    work_order:           String(pick(r, '工作單號', '工單號')).trim(),
    settle_date:          parseDate(pick(r, '結算日期')),
    clear_date:           parseDate(pick(r, '結清日期')),
    customer:             String(pick(r, '客戶名稱', '客戶') || '').trim(),
    plate_no:             String(pick(r, '車牌號碼', '車牌') || '').trim(),
    account_type_code:    String(pick(r, '帳類代碼') || '').trim(),
    account_type:         String(pick(r, '帳類') || '').trim(),
    parts_income:         num(pick(r, '零件收入')),
    accessories_income:   num(pick(r, '配件收入')),
    boutique_income:      num(pick(r, '精品收入')),
    engine_wage:          num(pick(r, '引擎工資', '工資收入')),
    bodywork_income:      num(pick(r, '鈑金收入')),
    paint_income:         num(pick(r, '烤漆收入')),
    carwash_income:       num(pick(r, '洗車美容收入', '洗車收入')),
    outsource_income:     num(pick(r, '外包收入')),
    addon_income:         num(pick(r, '附加服務收入', '附加服務')),
    total_untaxed:        num(pick(r, '收入合計（未稅）', '收入合計(未稅)', '收入合計')),
    total_taxed:          num(pick(r, '收入合計(含稅)', '收入合計（含稅）')),
    parts_cost:           num(pick(r, '零件成本（未稅）', '零件成本(未稅)', '零件成本')),
    service_advisor:      String(pick(r, '服務顧問', '接待員') || '').trim(),
  }));

const parseTechPerformance = (rows, branch, period) => rows
  .filter(r => !isTitleRow(pick(r, '工作單號', '工單號')))
  .map(r => ({
    period, branch,
    tech_name_raw:   String(pick(r, '技師姓名', '姓名') || '').trim(),
    tech_name_clean: String(pick(r, '技師姓名', '姓名') || '').trim().replace(/\s+/g, ''),
    dispatch_date:   parseDate(pick(r, '出廠日期')),
    work_order:      String(pick(r, '工作單號', '工單號')).trim(),
    work_code:       String(pick(r, '維修工時代碼', '工時代碼') || '').trim(),
    task_content:    String(pick(r, '作業內容') || '').trim(),
    standard_hours:  num(pick(r, '標準工時')),
    wage:            num(pick(r, '工資')),
    account_type:    String(pick(r, '帳類') || '').trim(),
    discount:        num(pick(r, '折扣')),
    wage_category:   String(pick(r, '工資類別') || '').trim(),
  }));

const parsePartsSales = (rows, branch, period) => rows
  .filter(r => {
    const orderNo = String(pick(r, '結帳單號') || '').trim();
    const partNum = String(pick(r, '零件編號') || '').trim();
    // 兩者都空 → 無效列
    if (!orderNo && !partNum) return false;
    // 兩者都是純中文 → 標題列
    if (isTitleRow(orderNo) && isTitleRow(partNum)) return false;
    return true;
  })
  .map(r => {
    const rowBranch = branch || (() => {
      const b = String(r['據點代碼'] || r['據點'] || r['點'] || r['分店'] || '').toUpperCase().trim();
      return ['AMA', 'AMC', 'AMD'].includes(b) ? b : null;
    })();
    return {
      period, branch: rowBranch,
      category:            String(pick(r, '類別') || '').trim(),
      category_detail:     String(pick(r, '類別細節', '類別明細') || '').trim(),
      order_no:            String(pick(r, '結帳單號') || '').trim(),
      work_order:          String(pick(r, '工單號', '工作單號') || '').trim(),
      part_number:         String(pick(r, '零件編號') || '').trim(),
      part_name:           String(pick(r, '零件名稱') || '').trim(),
      part_type:           String(pick(r, 'Paycode', '種類', '零件種類') || '').trim(),
      category_code:       String(pick(r, '零件類別') || '').trim(),
      function_code:       String(pick(r, '功能碼') || '').trim(),
      sale_qty:            num(pick(r, '銷售數量', '數量')),
      retail_price:        num(pick(r, '零售價')),
      sale_price_untaxed:  num(pick(r, '實際售價(稅前)', '實際售價(未稅)', '實際售價')),
      cost_untaxed:        num(pick(r, '成本總價(稅前)', '成本(未稅)', '成本')),
      discount_rate:       num(pick(r, '折扣率')),
      department:          String(pick(r, '付款部門', '部門') || '').trim(),
      pickup_person:       String(pick(r, '領料人員', '領料人', '接待人員') || '').trim(),
      sales_person:        String(pick(r, '銷售人員', '業務員') || '').trim(),
      plate_no:            String(pick(r, '車牌號碼', '車牌') || '').trim(),
    };
  });

const parseBusinessQuery = (rows, branch, period) => rows
  .filter(r => {
    const wo    = String(pick(r, '工單號', '工作單號') || '').trim();
    const plate = String(pick(r, '車牌號碼', '車牌號', '車牌') || '').trim();
    if (!wo && !plate) return false;
    if (isTitleRow(wo) && isTitleRow(plate)) return false;
    return true;
  })
  .map(r => {
    const rowBranch = branch || (() => {
      const b = String(r['據點代碼'] || r['據點'] || r['點'] || r['分店'] || '').toUpperCase().trim();
      return ['AMA', 'AMC', 'AMD'].includes(b) ? b : null;
    })();
    return {
      period, branch: rowBranch,
      work_order:     String(pick(r, '工單號', '工作單號') || '').trim(),
      open_time:      parseDateTime(pick(r, '工單開單時間', '開單時間', '開工時間', '進廠時間', '開立時間', '開單日期', '接車時間')),
      settle_date:    parseDate(pick(r, '結算日期')),
      plate_no:       String(pick(r, '車牌號碼', '車牌號', '車牌') || '').trim(),
      vin:            String(pick(r, '車身號碼', 'VIN') || '').trim(),
      status:         String(pick(r, '工單狀態', '狀態') || '').trim(),
      repair_item:    String(pick(r, '交修項目名稱', '交修項目', '交修內容') || '').trim(),
      service_advisor:String(pick(r, '服務顧問') || '').trim(),
      assigned_tech:  String(pick(r, '指定技師') || '').trim(),
      repair_tech:    String(pick(r, '維修技師') || '').trim(),
      repair_type:    String(pick(r, '維修類型') || '').trim(),
      car_series:     String(pick(r, '車系') || '').trim(),
      car_model:      String(pick(r, '車型') || '').trim(),
      model_year:     String(pick(r, '年式') || '').trim(),
      owner:          String(pick(r, '車主') || '').trim(),
      is_ev:          String(pick(r, '電車', '油電', '動力') || '').trim(),
      mileage_in:     parseInt(pick(r, '進廠里程')) || null,
      mileage_out:    parseInt(pick(r, '出廠里程')) || null,
      repair_amount:       num(pick(r, '維修金額', '修理金額')),
      labor_fee:           num(pick(r, '工時費', '工資費', '工時收入')),
      repair_material_fee: num(pick(r, '維修材料費', '修理材料費', '材料費')),
      sales_material_fee:  num(pick(r, '銷售材料費', '零件銷售費', '材料銷售費')),
    };
  });

const parsePartsCatalog = (rows) => rows
  .filter(r => {
    const p = String(pick(r, '零件編號', '料號') || '').trim();
    return p && !isTitleRow(p);
  })
  .map(r => ({
    part_number:   String(pick(r, '零件編號', '料號') || '').trim(),
    part_name:     String(pick(r, '零件名稱', '品名') || '').trim(),
    part_category: String(pick(r, '零件類別') || '').trim(),
    part_type:     String(pick(r, '零件種類', '種類') || '').trim(),
    category_code: String(pick(r, '零件類別') || '').trim(),
    function_code: String(pick(r, '功能碼') || '').trim(),
    branch:        String(pick(r, '據點') || '').trim() || null,
  }));

module.exports = {
  isNoteRow,
  isTitleRow,
  parseRepairIncome,
  parseTechPerformance,
  parsePartsSales,
  parseBusinessQuery,
  parsePartsCatalog,
};
