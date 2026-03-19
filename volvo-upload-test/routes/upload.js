const router  = require('express').Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const pool    = require('../db/pool');
const { detectFileType, detectBranch, detectPeriod } = require('../lib/utils');
const {
  parseRepairIncome, parseTechPerformance,
  parsePartsSales, parseBusinessQuery, parsePartsCatalog,
} = require('../lib/parsers');
const { batchInsert, upsertPartsCatalog } = require('../lib/batchInsert');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── 找出最佳 sheet：優先選含關鍵字的 sheet，否則選列數最多的 ──
function pickBestSheet(workbook, fileType) {
  const KW_MAP = {
    repair_income:    ['維修收入', '收入分類', '維修', 'repair'],
    tech_performance: ['技師績效', '工資明細', '技師', 'tech', 'wage'],
    parts_sales:      ['零件銷售', '零件明細', 'parts'],
    business_query:   ['業務查詢', '進廠', 'business'],
    parts_catalog:    ['零配件', '型錄', 'catalog'],
  };
  const keywords = KW_MAP[fileType] || [];
  for (const sn of workbook.SheetNames) {
    if (keywords.some(kw => sn.toLowerCase().includes(kw.toLowerCase()))) {
      return sn;
    }
  }
  // fallback：選列數最多的 sheet
  let best = workbook.SheetNames[0];
  let bestCount = 0;
  for (const sn of workbook.SheetNames) {
    const sheet = workbook.Sheets[sn];
    const ref   = sheet['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    const rows  = range.e.r - range.s.r;
    if (rows > bestCount) { bestCount = rows; best = sn; }
  }
  return best;
}

// ── 動態偵測 header 行（有些 DMS 匯出前幾行是系統資訊，header 不在第一行）──
function findHeaderRow(rawMatrix) {
  // 關鍵字：至少包含其中一個才算是 header 行
  const HEADER_KEYWORDS = [
    '工單號', '工作單號', '結算日期', '技師', '零件', '車牌',
    '工資', '帳類', '服務顧問', '銷售人員', '功能碼', '交修項目',
  ];
  for (let i = 0; i < Math.min(rawMatrix.length, 20); i++) {
    const rowStr = rawMatrix[i].map(c => String(c || '')).join('|');
    if (HEADER_KEYWORDS.some(kw => rowStr.includes(kw))) {
      return i;
    }
  }
  return 0; // 找不到就用第一行
}

// ── 將原始二維陣列轉成物件陣列（自動處理 header 行偏移）──
function sheetToObjects(sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  });
  if (!raw.length) return [];

  const headerRowIdx = findHeaderRow(raw);
  const headers = raw[headerRowIdx].map(h => String(h || '').trim());

  const objects = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    // 完全空行跳過
    if (row.every(c => c === '' || c === null || c === undefined)) continue;
    const obj = {};
    headers.forEach((h, ci) => {
      if (h) obj[h] = row[ci] !== undefined ? row[ci] : '';
    });
    objects.push(obj);
  }
  return objects;
}

router.post('/upload', upload.array('files', 8), async (req, res) => {
  const results = [];

  for (const file of req.files) {
    let filename = file.originalname;
    try { filename = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch (e) {}

    try {
      const workbook = XLSX.read(file.buffer, {
        type: 'buffer',
        cellDates: true,
        cellNF: true,
        cellText: false,
      });

      const fileType = detectFileType(filename, workbook.SheetNames);
      const branch   = detectBranch(filename);
      const period   = detectPeriod(filename);

      if (!fileType) {
        throw new Error('無法辨識檔案類型，請確認檔名包含關鍵字（維修收入/技師績效/零件銷售/業務查詢）');
      }

      const sheetName = pickBestSheet(workbook, fileType);
      const sheet     = workbook.Sheets[sheetName];

      // 用動態 header 偵測，確保不漏資料
      const rawRows = sheetToObjects(sheet);

      if (rawRows.length > 0) {
        console.log(`[${filename}] sheet="${sheetName}" rows=${rawRows.length} 欄位: ${Object.keys(rawRows[0]).slice(0, 10).join(' | ')}`);
      } else {
        console.warn(`[${filename}] sheet="${sheetName}" 無資料列`);
      }

      const client = await pool.connect();
      let rowCount = 0;

      try {
        await client.query('BEGIN');

        if (fileType === 'repair_income') {
          if (!branch || !period) throw new Error('維修收入需要據點（AMA/AMC/AMD）和期間（YYYYMM）');
          await client.query('DELETE FROM repair_income WHERE period=$1 AND branch=$2', [period, branch]);
          const parsed = parseRepairIncome(rawRows, branch, period);
          rowCount = await batchInsert(client, 'repair_income', [
            'period', 'branch', 'work_order', 'settle_date', 'customer', 'plate_no',
            'account_type_code', 'account_type',
            'parts_income', 'accessories_income', 'boutique_income', 'engine_wage',
            'bodywork_income', 'paint_income', 'carwash_income', 'outsource_income',
            'addon_income', 'total_untaxed', 'total_taxed', 'parts_cost', 'service_advisor',
          ], parsed);

        } else if (fileType === 'tech_performance') {
          if (!branch || !period) throw new Error('技師績效需要據點（AMA/AMC/AMD）和期間（YYYYMM）');
          await client.query('DELETE FROM tech_performance WHERE period=$1 AND branch=$2', [period, branch]);
          const parsed = parseTechPerformance(rawRows, branch, period);
          rowCount = await batchInsert(client, 'tech_performance', [
            'period', 'branch', 'tech_name_raw', 'tech_name_clean', 'dispatch_date',
            'work_order', 'work_code', 'task_content', 'standard_hours', 'wage',
            'account_type', 'discount', 'wage_category',
          ], parsed);

        } else if (fileType === 'parts_sales') {
          if (!period) throw new Error('零件銷售需要期間（YYYYMM）');
          if (branch) {
            await client.query('DELETE FROM parts_sales WHERE period=$1 AND branch=$2', [period, branch]);
          } else {
            await client.query('DELETE FROM parts_sales WHERE period=$1', [period]);
          }
          const parsed = parsePartsSales(rawRows, branch, period);
          rowCount = await batchInsert(client, 'parts_sales', [
            'period', 'branch', 'category', 'category_detail', 'order_no', 'work_order',
            'part_number', 'part_name', 'part_type', 'category_code', 'function_code',
            'sale_qty', 'retail_price', 'sale_price_untaxed', 'cost_untaxed',
            'discount_rate', 'department', 'pickup_person', 'sales_person', 'plate_no',
          ], parsed);

        } else if (fileType === 'business_query') {
          if (!period) throw new Error('業務查詢需要期間（YYYYMM）');
          if (branch) {
            await client.query('DELETE FROM business_query WHERE period=$1 AND branch=$2', [period, branch]);
          } else {
            await client.query('DELETE FROM business_query WHERE period=$1', [period]);
          }
          const parsed = parseBusinessQuery(rawRows, branch, period);
          rowCount = await batchInsert(client, 'business_query', [
            'period', 'branch', 'work_order', 'open_time', 'settle_date', 'plate_no',
            'vin', 'status', 'repair_item', 'service_advisor', 'assigned_tech',
            'repair_tech', 'repair_type', 'car_series', 'car_model', 'model_year',
            'owner', 'is_ev', 'mileage_in', 'mileage_out',
          ], parsed);

        } else if (fileType === 'parts_catalog') {
          const parsed = parsePartsCatalog(rawRows);
          rowCount = await upsertPartsCatalog(client, parsed);
        }

        await client.query(
          `INSERT INTO upload_history (file_name,file_type,branch,period,row_count,status)
           VALUES ($1,$2,$3,$4,$5,'success')`,
          [filename, fileType, branch, period, rowCount]
        );
        await client.query('COMMIT');

        results.push({ filename, status: 'success', fileType, branch, period, rowCount });
        console.log(`[${filename}] ✅ 寫入 ${rowCount} 筆`);

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

    } catch (err) {
      console.error(`[${filename}] ❌`, err.message);
      results.push({ filename, status: 'error', error: err.message });
      try {
        await pool.query(
          `INSERT INTO upload_history (file_name,file_type,status,error_msg) VALUES ($1,'unknown','error',$2)`,
          [filename, err.message]
        );
      } catch (e) {}
    }
  }

  res.json({ results });
});

module.exports = router;
