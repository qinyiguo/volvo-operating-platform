require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DB 連線
// ============================================================
const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: false,
  max: 10,
});

// ============================================================
// 自動建表
// ============================================================
const initDatabase = async () => {
  const client = await pool.connect();
  try {
    console.log('[initDB] 開始建表...');

    // 上傳歷史
    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_history (
        id           SERIAL PRIMARY KEY,
        file_name    VARCHAR(255) NOT NULL,
        file_type    VARCHAR(50),
        branch       VARCHAR(10),
        period       VARCHAR(6),
        row_count    INTEGER DEFAULT 0,
        status       VARCHAR(20) DEFAULT 'success',
        error_msg    TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 維修收入
    await client.query(`
      CREATE TABLE IF NOT EXISTS repair_income (
        id                 SERIAL PRIMARY KEY,
        period             VARCHAR(6),
        branch             VARCHAR(10),
        work_order         VARCHAR(30),
        settle_date        DATE,
        customer           VARCHAR(100),
        plate_no           VARCHAR(20),
        account_type_code  VARCHAR(10),
        account_type       VARCHAR(30),
        parts_income       NUMERIC(12,2) DEFAULT 0,
        accessories_income NUMERIC(12,2) DEFAULT 0,
        boutique_income    NUMERIC(12,2) DEFAULT 0,
        engine_wage        NUMERIC(12,2) DEFAULT 0,
        bodywork_income    NUMERIC(12,2) DEFAULT 0,
        paint_income       NUMERIC(12,2) DEFAULT 0,
        carwash_income     NUMERIC(12,2) DEFAULT 0,
        outsource_income   NUMERIC(12,2) DEFAULT 0,
        addon_income       NUMERIC(12,2) DEFAULT 0,
        total_untaxed      NUMERIC(12,2) DEFAULT 0,
        total_taxed        NUMERIC(12,2) DEFAULT 0,
        parts_cost         NUMERIC(12,2) DEFAULT 0,
        service_advisor    VARCHAR(50),
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 技師績效
    await client.query(`
      CREATE TABLE IF NOT EXISTS tech_performance (
        id              SERIAL PRIMARY KEY,
        period          VARCHAR(6),
        branch          VARCHAR(10),
        tech_name_raw   VARCHAR(50),
        tech_name_clean VARCHAR(50),
        dispatch_date   DATE,
        work_order      VARCHAR(30),
        work_code       VARCHAR(30),
        task_content    VARCHAR(200),
        standard_hours  NUMERIC(8,2) DEFAULT 0,
        wage            NUMERIC(12,2) DEFAULT 0,
        account_type    VARCHAR(30),
        discount        NUMERIC(5,2),
        wage_category   VARCHAR(30),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 零件銷售
    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_sales (
        id                 SERIAL PRIMARY KEY,
        period             VARCHAR(6),
        branch             VARCHAR(10),
        category           VARCHAR(20),
        category_detail    VARCHAR(50),
        order_no           VARCHAR(30),
        work_order         VARCHAR(30),
        part_number        VARCHAR(30),
        part_name          VARCHAR(200),
        part_type          VARCHAR(20),
        category_code      VARCHAR(20),
        function_code      VARCHAR(20),
        sale_qty           NUMERIC(10,2) DEFAULT 0,
        retail_price       NUMERIC(12,2) DEFAULT 0,
        sale_price_untaxed NUMERIC(12,2) DEFAULT 0,
        cost_untaxed       NUMERIC(12,2) DEFAULT 0,
        discount_rate      NUMERIC(5,4),
        department         VARCHAR(20),
        pickup_person      VARCHAR(50),
        sales_person       VARCHAR(50),
        plate_no           VARCHAR(20),
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 業務查詢
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_query (
        id              SERIAL PRIMARY KEY,
        period          VARCHAR(6),
        branch          VARCHAR(10),
        work_order      VARCHAR(30),
        open_time       TIMESTAMPTZ,
        settle_date     DATE,
        plate_no        VARCHAR(20),
        vin             VARCHAR(30),
        status          VARCHAR(20),
        repair_item     VARCHAR(200),
        service_advisor VARCHAR(50),
        assigned_tech   VARCHAR(50),
        repair_tech     VARCHAR(50),
        repair_type     VARCHAR(50),
        car_series      VARCHAR(50),
        car_model       VARCHAR(50),
        model_year      VARCHAR(10),
        owner           VARCHAR(100),
        is_ev           VARCHAR(10),
        mileage_in      INTEGER,
        mileage_out     INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // parts_catalog（零配件比對 — 以零件編號為主鍵，upsert）
    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_catalog (
        part_number   VARCHAR(50) PRIMARY KEY,
        part_name     VARCHAR(200),
        part_category VARCHAR(50),
        part_type     VARCHAR(20),
        category_code VARCHAR(20),
        function_code VARCHAR(20),
        branch        VARCHAR(10),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('[initDB] ✅ 所有表格建立完成');
  } catch (err) {
    console.error('[initDB] ❌ 失敗:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

// ============================================================
// 工具函式
// ============================================================
const pick = (row, ...keys) => {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
};

const num = (val) => {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
};

const parseDate = (val) => {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return null;
};

const detectFileType = (filename, sheetNames) => {
  const fn = filename.toLowerCase();
  if (fn.includes('技師績效') || fn.includes('工資明細')) return 'tech_performance';
  if (fn.includes('維修收入') || fn.includes('收入分類')) return 'repair_income';
  if (fn.includes('零件銷售') || fn.includes('零件明細')) return 'parts_sales';
  if (fn.includes('業務查詢')) return 'business_query';
  if (fn.includes('零配件比對') || fn.includes('零配件對照') || fn.includes('parts_catalog')) return 'parts_catalog';
  const names = (sheetNames || []).join(',');
  if (names.includes('工資明細') || names.includes('技師績效')) return 'tech_performance';
  if (names.includes('維修收入') || names.includes('收入分類')) return 'repair_income';
  if (names.includes('零件銷售') || names.includes('零件明細')) return 'parts_sales';
  if (names.includes('業務查詢')) return 'business_query';
  return null;
};

const detectBranch = (filename) => {
  const fn = filename.toUpperCase();
  if (fn.includes('AMA')) return 'AMA';
  if (fn.includes('AMC')) return 'AMC';
  if (fn.includes('AMD')) return 'AMD';
  return null;
};

const detectPeriod = (filename) => {
  const m = filename.match(/(\d{6})/);
  return m ? m[1] : null;
};

// ============================================================
// 各類解析
// ============================================================
// 備註列過濾（Excel 底部說明行，工單號含中文則跳過）
const isNoteRow = (val) => {
  const s = String(val || '').trim();
  if (!s || s === 'undefined') return true;
  if (/[\u4e00-\u9fff]/.test(s)) return true;
  return false;
};

const parseRepairIncome = (rows, branch, period) => rows
  .filter(r => !isNoteRow(pick(r, '工作單號', '工單號')))
  .map(r => ({
  period, branch,
  work_order: String(pick(r, '工作單號', '工單號')).trim(),
  settle_date: parseDate(pick(r, '結算日期')),
  customer: String(pick(r, '客戶名稱', '客戶')).trim(),
  plate_no: String(pick(r, '車牌號碼', '車牌')).trim(),
  account_type_code: String(pick(r, '帳類代碼')).trim(),
  account_type: String(pick(r, '帳類')).trim(),
  parts_income: num(pick(r, '零件收入')),
  accessories_income: num(pick(r, '配件收入')),
  boutique_income: num(pick(r, '精品收入')),
  engine_wage: num(pick(r, '引擎工資', '工資收入')),
  bodywork_income: num(pick(r, '鈑金收入')),
  paint_income: num(pick(r, '烤漆收入')),
  carwash_income: num(pick(r, '洗車美容收入', '洗車收入')),
  outsource_income: num(pick(r, '外包收入')),
  addon_income: num(pick(r, '附加服務收入', '附加服務')),
  total_untaxed: num(pick(r, '收入合計（未稅）', '收入合計(未稅)', '收入合計')),
  total_taxed: num(pick(r, '收入合計(含稅)', '收入合計（含稅）')),
  parts_cost: num(pick(r, '零件成本（未稅）', '零件成本(未稅)', '零件成本')),
  service_advisor: String(pick(r, '服務顧問', '接待員')).trim(),
}));

const parseTechPerformance = (rows, branch, period) => rows
  .filter(r => !isNoteRow(pick(r, '工作單號', '工單號')))
  .map(r => ({
  period, branch,
  tech_name_raw: String(pick(r, '技師姓名', '姓名')).trim(),
  tech_name_clean: String(pick(r, '技師姓名', '姓名')).trim().replace(/\s+/g, ''),
  dispatch_date: parseDate(pick(r, '出廠日期')),
  work_order: String(pick(r, '工作單號', '工單號')).trim(),
  work_code: String(pick(r, '維修工時代碼', '工時代碼')).trim(),
  task_content: String(pick(r, '作業內容')).trim(),
  standard_hours: num(pick(r, '標準工時')),
  wage: num(pick(r, '工資')),
  account_type: String(pick(r, '帳類')).trim(),
  discount: num(pick(r, '折扣')),
  wage_category: String(pick(r, '工資類別')).trim(),
}));

const parsePartsSales = (rows, branch, period) => rows.map(r => {
  const rowBranch = branch || (() => {
    const b = String(r['據點'] || '').toUpperCase().trim();
    return ['AMA','AMC','AMD'].includes(b) ? b : null;
  })();
  return {
    period, branch: rowBranch,
    category: String(pick(r, '類別')).trim(),
    category_detail: String(pick(r, '類別細節', '類別明細')).trim(),
    order_no: String(pick(r, '結帳單號')).trim(),
    work_order: String(pick(r, '工單號', '工作單號')).trim(),
    part_number: String(pick(r, '零件編號')).trim(),
    part_name: String(pick(r, '零件名稱')).trim(),
    part_type: String(pick(r, 'Paycode', '種類', '零件種類')).trim(),
    category_code: String(pick(r, '零件類別')).trim(),
    function_code: String(pick(r, '功能碼')).trim(),
    sale_qty: num(pick(r, '銷售數量', '數量')),
    retail_price: num(pick(r, '零售價')),
    sale_price_untaxed: num(pick(r, '實際售價(稅前)', '實際售價(未稅)', '實際售價')),
    cost_untaxed: num(pick(r, '成本總價(稅前)', '成本(未稅)', '成本')),
    discount_rate: num(pick(r, '折扣率')),
    department: String(pick(r, '付款部門', '部門')).trim(),
    pickup_person: String(pick(r, '領料人員', '領料人', '接待人員')).trim(),
    sales_person: String(pick(r, '銷售人員', '業務員')).trim(),
    plate_no: String(pick(r, '車牌號碼', '車牌')).trim(),
  };
});

const parseBusinessQuery = (rows, branch, period) => rows.map(r => {
  const rowBranch = branch || (() => {
    const b = String(r['據點'] || '').toUpperCase().trim();
    return ['AMA','AMC','AMD'].includes(b) ? b : null;
  })();
  return {
    period, branch: rowBranch,
    work_order: String(pick(r, '工單號', '工作單號')).trim(),
    settle_date: parseDate(pick(r, '結算日期')),
    plate_no: String(pick(r, '車牌號碼', '車牌')).trim(),
    vin: String(pick(r, '車身號碼', 'VIN')).trim(),
    status: String(pick(r, '工單狀態', '狀態')).trim(),
    repair_item: String(pick(r, '交修項目')).trim(),
    service_advisor: String(pick(r, '服務顧問')).trim(),
    assigned_tech: String(pick(r, '指定技師')).trim(),
    repair_tech: String(pick(r, '維修技師')).trim(),
    repair_type: String(pick(r, '維修類型')).trim(),
    car_series: String(pick(r, '車系')).trim(),
    car_model: String(pick(r, '車型')).trim(),
    model_year: String(pick(r, '年式')).trim(),
    owner: String(pick(r, '車主')).trim(),
    is_ev: String(pick(r, '電車', '油電', '動力')).trim(),
    mileage_in: parseInt(pick(r, '進廠里程')) || null,
    mileage_out: parseInt(pick(r, '出廠里程')) || null,
  };
});

// parsePartsCatalog
const parsePartsCatalog = (rows) => rows
  .filter(r => {
    const pn = String(pick(r, '零件編號', '料號') || '').trim();
    return pn && pn !== 'undefined';
  })
  .map(r => ({
    part_number:   String(pick(r, '零件編號', '料號')).trim(),
    part_name:     String(pick(r, '零件名稱', '品名')).trim(),
    part_category: String(pick(r, '零件類別')).trim(),
    part_type:     String(pick(r, '零件種類', '種類')).trim(),
    category_code: String(pick(r, '零件類別')).trim(),
    function_code: String(pick(r, '功能碼')).trim(),
    branch:        String(pick(r, '據點')).trim() || null,
  }));

// ============================================================
// 批次 INSERT
// ============================================================
const batchInsert = async (client, table, cols, rows) => {
  let total = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = batch.map((row, ri) => {
      const ph = cols.map((col, ci) => {
        values.push(row[col] !== undefined ? row[col] : null);
        return `$${ri * cols.length + ci + 1}`;
      });
      return `(${ph.join(',')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders.join(',')}`,
      values
    );
    total += batch.length;
  }
  return total;
};

// upsertPartsCatalog
const upsertPartsCatalog = async (client, rows) => {
  let count = 0;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const r of batch) {
      await client.query(`
        INSERT INTO parts_catalog (part_number, part_name, part_category, part_type, category_code, function_code, branch, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (part_number) DO UPDATE SET
          part_name=EXCLUDED.part_name, part_category=EXCLUDED.part_category,
          part_type=EXCLUDED.part_type, category_code=EXCLUDED.category_code,
          function_code=EXCLUDED.function_code, branch=EXCLUDED.branch, updated_at=NOW()
      `, [r.part_number, r.part_name, r.part_category, r.part_type, r.category_code, r.function_code, r.branch]);
      count++;
    }
  }
  return count;
};

// ============================================================
// 上傳 API
// ============================================================
app.post('/api/upload', upload.array('files', 8), async (req, res) => {
  const results = [];

  for (const file of req.files) {
    let filename = file.originalname;
    try {
      filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch(e) {}

    try {
      const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
      const fileType = detectFileType(filename, workbook.SheetNames);
      const branch = detectBranch(filename);
      const period = detectPeriod(filename);

      if (!fileType) throw new Error(`無法辨識檔案類型，請確認檔名包含關鍵字（維修收入/技師績效/零件銷售/業務查詢）`);

      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      // 印出前3列欄位名稱供除錯
      if (rawRows.length > 0) {
        console.log(`[${filename}] 欄位: ${Object.keys(rawRows[0]).join(' | ')}`);
      }

      const client = await pool.connect();
      let rowCount = 0;
      try {
        await client.query('BEGIN');

        if (fileType === 'repair_income') {
          if (!branch || !period) throw new Error('維修收入需要據點和期間（從檔名辨識，如 AMA_202501）');
          await client.query('DELETE FROM repair_income WHERE period=$1 AND branch=$2', [period, branch]);
          const rows = parseRepairIncome(rawRows, branch, period);
          rowCount = await batchInsert(client, 'repair_income', [
            'period','branch','work_order','settle_date','customer','plate_no',
            'account_type_code','account_type','parts_income','accessories_income',
            'boutique_income','engine_wage','bodywork_income','paint_income',
            'carwash_income','outsource_income','addon_income','total_untaxed',
            'total_taxed','parts_cost','service_advisor'
          ], rows);
        }

        else if (fileType === 'tech_performance') {
          if (!branch || !period) throw new Error('技師績效需要據點和期間（從檔名辨識）');
          await client.query('DELETE FROM tech_performance WHERE period=$1 AND branch=$2', [period, branch]);
          const rows = parseTechPerformance(rawRows, branch, period);
          rowCount = await batchInsert(client, 'tech_performance', [
            'period','branch','tech_name_raw','tech_name_clean','dispatch_date',
            'work_order','work_code','task_content','standard_hours','wage',
            'account_type','discount','wage_category'
          ], rows);
        }

        else if (fileType === 'parts_sales') {
          if (!period) throw new Error('零件銷售需要期間（從檔名辨識）');
          if (branch) {
            await client.query('DELETE FROM parts_sales WHERE period=$1 AND branch=$2', [period, branch]);
          } else {
            await client.query('DELETE FROM parts_sales WHERE period=$1', [period]);
          }
          const rows = parsePartsSales(rawRows, branch, period);
          rowCount = await batchInsert(client, 'parts_sales', [
            'period','branch','category','category_detail','order_no','work_order',
            'part_number','part_name','part_type','category_code','function_code',
            'sale_qty','retail_price','sale_price_untaxed','cost_untaxed',
            'discount_rate','department','pickup_person','sales_person','plate_no'
          ], rows);
        }

        else if (fileType === 'business_query') {
          if (!period) throw new Error('業務查詢需要期間（從檔名辨識）');
          if (branch) {
            await client.query('DELETE FROM business_query WHERE period=$1 AND branch=$2', [period, branch]);
          } else {
            await client.query('DELETE FROM business_query WHERE period=$1', [period]);
          }
          const rows = parseBusinessQuery(rawRows, branch, period);
          rowCount = await batchInsert(client, 'business_query', [
            'period','branch','work_order','settle_date','plate_no','vin',
            'status','repair_item','service_advisor','assigned_tech','repair_tech',
            'repair_type','car_series','car_model','model_year','owner','is_ev',
            'mileage_in','mileage_out'
          ], rows);
        }

        await client.query(`
          INSERT INTO upload_history (file_name, file_type, branch, period, row_count, status)
          VALUES ($1,$2,$3,$4,$5,'success')
        `, [filename, fileType, branch, period, rowCount]);

        else if (fileType === 'parts_catalog') {
          const rows = parsePartsCatalog(rawRows);
          rowCount = await upsertPartsCatalog(client, rows);
        }

        await client.query('COMMIT');
        results.push({ filename, status: 'success', fileType, branch, period, rowCount });
        console.log(`✅ ${filename} → ${fileType} / ${branch} / ${period} / ${rowCount}筆`);

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

    } catch (err) {
      results.push({ filename, status: 'error', error: err.message });
      console.error(`❌ ${filename}: ${err.message}`);
      try {
        await pool.query(`
          INSERT INTO upload_history (file_name, file_type, status, error_msg)
          VALUES ($1,'unknown','error',$2)
        `, [filename, err.message]);
      } catch(e) {}
    }
  }

  res.json({ results });
});

// ============================================================
// 查詢 API — 確認各表格筆數
// ============================================================
app.get('/api/counts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 'repair_income'   AS 表格, COUNT(*) AS 筆數 FROM repair_income  UNION ALL
      SELECT 'tech_performance',        COUNT(*)          FROM tech_performance UNION ALL
      SELECT 'parts_sales',             COUNT(*)          FROM parts_sales      UNION ALL
      SELECT 'business_query',          COUNT(*)          FROM business_query   UNION ALL
      SELECT 'parts_catalog',           COUNT(*)          FROM parts_catalog   UNION ALL
      SELECT 'upload_history',          COUNT(*)          FROM upload_history
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 查看最新上傳歷史
app.get('/api/history', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ============================================================
// 啟動
// ============================================================
initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB初始化失敗:', err.message);
    process.exit(1);
  });
