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

    const bqCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'business_query' AND column_name = 'work_order'
    `);
    if (bqCheck.rows.length === 0) {
      console.log('[initDB] business_query 缺少 work_order，DROP 重建...');
      await client.query(`DROP TABLE IF EXISTS business_query`);
      await client.query(`
        CREATE TABLE business_query (
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
    }

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

    // ── SA 銷售設定表 ──────────────────────────────────────────────
    // filters 欄位為 JSONB 陣列，每個元素：
    //   { type: 'category_code' | 'function_code' | 'part_number', value: '...' }
    await client.query(`
      CREATE TABLE IF NOT EXISTS sa_sales_config (
        id           SERIAL PRIMARY KEY,
        config_name  VARCHAR(100) NOT NULL,
        description  TEXT,
        filters      JSONB NOT NULL DEFAULT '[]',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 系統設定表 ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // 預設管理員密碼（只在第一次建立時插入）
    await client.query(`
      INSERT INTO app_settings (key, value)
      VALUES ('settings_password', 'admin1234')
      ON CONFLICT (key) DO NOTHING
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

const parseDateTime = (val) => {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val) ? null : val.toISOString();
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[\s T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:${(sec||'00')}+08:00`;
  }
  const dm = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (dm) return `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}T00:00:00+08:00`;
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
    const b = String(r['據點代碼'] || r['據點'] || r['點'] || r['分店'] || '').toUpperCase().trim();
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
    const b = String(r['據點代碼'] || r['據點'] || r['點'] || r['分店'] || '').toUpperCase().trim();
    return ['AMA','AMC','AMD'].includes(b) ? b : null;
  })();
  return {
    period, branch: rowBranch,
    work_order: String(pick(r, '工單號', '工作單號')).trim(),
    open_time: parseDateTime(pick(r, '工單開單時間', '開單時間', '開工時間', '進廠時間', '開立時間', '開單日期', '接車時間')),
    settle_date: parseDate(pick(r, '結算日期')),
    plate_no: String(pick(r, '車牌號碼', '車牌號', '車牌')).trim(),
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
            'period','branch','work_order','open_time','settle_date','plate_no','vin',
            'status','repair_item','service_advisor','assigned_tech','repair_tech',
            'repair_type','car_series','car_model','model_year','owner','is_ev',
            'mileage_in','mileage_out'
          ], rows);
        }

        else if (fileType === 'parts_catalog') {
          const rows = parsePartsCatalog(rawRows);
          rowCount = await upsertPartsCatalog(client, rows);
        }

        await client.query(`
          INSERT INTO upload_history (file_name, file_type, branch, period, row_count, status)
          VALUES ($1,$2,$3,$4,$5,'success')
        `, [filename, fileType, branch, period, rowCount]);

        await client.query('COMMIT');
        results.push({ filename, status: 'success', fileType, branch, period, rowCount });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

    } catch (err) {
      results.push({ filename, status: 'error', error: err.message });
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
// SA 銷售設定 API
// ============================================================

// 列出所有設定
app.get('/api/sa-config', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, config_name, description, filters, created_at, updated_at
       FROM sa_sales_config ORDER BY id`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 新增設定
app.post('/api/sa-config', async (req, res) => {
  const { config_name, description, filters } = req.body;
  if (!config_name) return res.status(400).json({ error: '名稱為必填' });
  if (!Array.isArray(filters) || filters.length === 0)
    return res.status(400).json({ error: '至少需要一個篩選條件' });
  try {
    const r = await pool.query(
      `INSERT INTO sa_sales_config (config_name, description, filters)
       VALUES ($1, $2, $3) RETURNING *`,
      [config_name.trim(), description || '', JSON.stringify(filters)]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新設定
app.put('/api/sa-config/:id', async (req, res) => {
  const { config_name, description, filters } = req.body;
  if (!config_name) return res.status(400).json({ error: '名稱為必填' });
  if (!Array.isArray(filters) || filters.length === 0)
    return res.status(400).json({ error: '至少需要一個篩選條件' });
  try {
    const r = await pool.query(
      `UPDATE sa_sales_config
       SET config_name=$1, description=$2, filters=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [config_name.trim(), description || '', JSON.stringify(filters), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '找不到設定' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 刪除設定
app.delete('/api/sa-config/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM sa_sales_config WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// parts_catalog 查詢（供前端自動完成）
// GET /api/sa-config/parts-lookup?type=category_code&q=AB
app.get('/api/sa-config/parts-lookup', async (req, res) => {
  const { type, q } = req.query;
  const allowed = ['category_code', 'function_code', 'part_number'];
  if (!allowed.includes(type)) return res.status(400).json({ error: '無效的 type' });

  try {
    const search = `%${(q || '').trim()}%`;
    let sql, params;

    if (type === 'part_number') {
      sql = `
        SELECT part_number AS value, part_name AS label, category_code, function_code
        FROM parts_catalog
        WHERE part_number ILIKE $1 OR part_name ILIKE $1
        ORDER BY part_number
        LIMIT 30
      `;
      params = [search];
    } else {
      // category_code 或 function_code：回傳不重複的值與其覆蓋零件數
      sql = `
        SELECT ${type} AS value,
               COUNT(*) AS part_count,
               STRING_AGG(DISTINCT part_name, '、' ORDER BY part_name) FILTER (WHERE part_name != '') AS sample_names
        FROM parts_catalog
        WHERE ${type} ILIKE $1 AND ${type} != ''
        GROUP BY ${type}
        ORDER BY part_count DESC
        LIMIT 30
      `;
      params = [search];
    }

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SA 銷售統計 API
// GET /api/stats/sa-sales?config_id=1&period=202501&branch=AMA
// ============================================================
app.get('/api/stats/sa-sales', async (req, res) => {
  const { config_id, period, branch } = req.query;
  if (!config_id) return res.status(400).json({ error: '請指定 config_id' });

  try {
    // 取設定
    const cfgRow = await pool.query(`SELECT * FROM sa_sales_config WHERE id=$1`, [config_id]);
    if (!cfgRow.rows.length) return res.status(404).json({ error: '找不到設定' });
    const cfg = cfgRow.rows[0];
    const filters = cfg.filters; // [{type, value}, ...]

    if (!filters.length) return res.json({ config: cfg, bySA: [], byPart: [], totals: {} });

    // 把 filters 拆成三類
    const catCodes  = filters.filter(f => f.type === 'category_code').map(f => f.value);
    const funcCodes = filters.filter(f => f.type === 'function_code').map(f => f.value);
    const partNums  = filters.filter(f => f.type === 'part_number').map(f => f.value);

    // 動態組 WHERE
    const conds = [];
    const params = [];
    let idx = 1;

    if (period)  { conds.push(`ps.period = $${idx++}`); params.push(period); }
    if (branch)  { conds.push(`ps.branch = $${idx++}`); params.push(branch); }

    // 零件篩選：同類型取 OR，不同類型之間取 AND
    // 例：category_code=93 AND function_code=1832
    //     或只用 part_number IN (...)
    if (catCodes.length)  { conds.push(`ps.category_code = ANY($${idx++})`); params.push(catCodes); }
    if (funcCodes.length) { conds.push(`ps.function_code  = ANY($${idx++})`); params.push(funcCodes); }
    if (partNums.length)  { conds.push(`ps.part_number    = ANY($${idx++})`); params.push(partNums); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // ── SA 彙總（以 sales_person 為主） ──
    const bySA = await pool.query(`
      SELECT
        ps.branch,
        COALESCE(NULLIF(ps.sales_person,''), '（未知）') AS sa_name,
        COUNT(DISTINCT ps.order_no)       AS order_count,
        SUM(ps.sale_qty)                  AS total_qty,
        SUM(ps.sale_price_untaxed)        AS total_sales,
        SUM(ps.cost_untaxed)              AS total_cost,
        SUM(ps.sale_price_untaxed)
          - SUM(ps.cost_untaxed)          AS gross_profit
      FROM parts_sales ps
      ${where}
      GROUP BY ps.branch, sa_name
      ORDER BY total_sales DESC
    `, params);

    // ── 零件明細彙總（Top 50） ──
    const byPart = await pool.query(`
      SELECT
        ps.part_number,
        ps.part_name,
        ps.category_code,
        ps.function_code,
        ps.part_type,
        COUNT(DISTINCT ps.order_no)  AS order_count,
        SUM(ps.sale_qty)             AS total_qty,
        SUM(ps.sale_price_untaxed)   AS total_sales,
        SUM(ps.cost_untaxed)         AS total_cost
      FROM parts_sales ps
      ${where}
      GROUP BY ps.part_number, ps.part_name, ps.category_code, ps.function_code, ps.part_type
      ORDER BY total_sales DESC
      LIMIT 50
    `, params);

    // ── 期間趨勢（此設定條件下各月份） ──
    // 用同樣的零件篩選，但忽略 period 條件
    const trendConds = [];
    const trendParams = [];
    let tidx = 1;
    if (branch) { trendConds.push(`ps.branch = $${tidx++}`); trendParams.push(branch); }
    // 趨勢也用 AND 邏輯（同主查詢）
    if (catCodes.length)  { trendConds.push(`ps.category_code = ANY($${tidx++})`); trendParams.push(catCodes); }
    if (funcCodes.length) { trendConds.push(`ps.function_code  = ANY($${tidx++})`); trendParams.push(funcCodes); }
    if (partNums.length)  { trendConds.push(`ps.part_number    = ANY($${tidx++})`); trendParams.push(partNums); }
    const trendWhere = trendConds.length ? 'WHERE ' + trendConds.join(' AND ') : '';

    const trend = await pool.query(`
      SELECT
        ps.period,
        ps.branch,
        SUM(ps.sale_qty)           AS total_qty,
        SUM(ps.sale_price_untaxed) AS total_sales
      FROM parts_sales ps
      ${trendWhere}
      GROUP BY ps.period, ps.branch
      ORDER BY ps.period, ps.branch
    `, trendParams);

    // ── 合計 ──
    const totals = {
      total_qty:    bySA.rows.reduce((s, r) => s + parseFloat(r.total_qty   || 0), 0),
      total_sales:  bySA.rows.reduce((s, r) => s + parseFloat(r.total_sales || 0), 0),
      total_cost:   bySA.rows.reduce((s, r) => s + parseFloat(r.total_cost  || 0), 0),
      gross_profit: bySA.rows.reduce((s, r) => s + parseFloat(r.gross_profit|| 0), 0),
      sa_count:     bySA.rows.length,
    };

    res.json({ config: cfg, bySA: bySA.rows, byPart: byPart.rows, trend: trend.rows, totals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 查詢 API
// ============================================================
app.get('/api/counts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 'repair_income'   AS 表格, COUNT(*) AS 筆數 FROM repair_income  UNION ALL
      SELECT 'tech_performance',        COUNT(*)          FROM tech_performance UNION ALL
      SELECT 'parts_sales',             COUNT(*)          FROM parts_sales      UNION ALL
      SELECT 'business_query',          COUNT(*)          FROM business_query   UNION ALL
      SELECT 'parts_catalog',           COUNT(*)          FROM parts_catalog    UNION ALL
      SELECT 'upload_history',          COUNT(*)          FROM upload_history
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/history', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ============================================================
// 統計 API（原有）
// ============================================================
app.get('/api/stats/repair', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conditions = []; const params = []; let idx = 1;
    if (period) { conditions.push(`period = $${idx++}`); params.push(period); }
    if (branch) { conditions.push(`branch = $${idx++}`); params.push(branch); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const summary = await pool.query(`
      SELECT branch, account_type, COUNT(*) AS work_order_count,
        SUM(total_untaxed) AS total_untaxed, SUM(parts_income) AS parts_income,
        SUM(accessories_income) AS accessories_income, SUM(boutique_income) AS boutique_income,
        SUM(engine_wage) AS engine_wage, SUM(bodywork_income + paint_income) AS bodywork_income,
        SUM(parts_cost) AS parts_cost
      FROM repair_income ${where}
      GROUP BY branch, account_type ORDER BY branch, total_untaxed DESC
    `, params);

    const bySA = await pool.query(`
      SELECT branch, service_advisor, COUNT(DISTINCT work_order) AS car_count,
        SUM(total_untaxed) AS total_untaxed, SUM(engine_wage) AS engine_wage,
        SUM(parts_income) AS parts_income
      FROM repair_income ${where}
      GROUP BY branch, service_advisor
      HAVING service_advisor IS NOT NULL AND service_advisor != ''
      ORDER BY total_untaxed DESC
    `, params);

    const totals = await pool.query(`
      SELECT branch, COUNT(DISTINCT work_order) AS car_count,
        SUM(total_untaxed) AS total_untaxed, SUM(engine_wage) AS engine_wage,
        SUM(parts_income) AS parts_income, SUM(accessories_income) AS accessories_income,
        SUM(boutique_income) AS boutique_income,
        SUM(bodywork_income + paint_income) AS bodywork_income,
        SUM(parts_cost) AS parts_cost
      FROM repair_income ${where}
      GROUP BY branch ORDER BY branch
    `, params);

    res.json({ summary: summary.rows, bySA: bySA.rows, totals: totals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/tech', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conditions = []; const params = []; let idx = 1;
    if (period) { conditions.push(`period = $${idx++}`); params.push(period); }
    if (branch) { conditions.push(`branch = $${idx++}`); params.push(branch); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const ranking = await pool.query(`
      SELECT branch, tech_name_clean, COUNT(DISTINCT work_order) AS car_count,
        SUM(standard_hours) AS total_hours, SUM(wage) AS total_wage,
        SUM(CASE WHEN wage_category ILIKE '%美容%' THEN wage ELSE 0 END) AS beauty_wage,
        SUM(CASE WHEN wage_category NOT ILIKE '%美容%' THEN wage ELSE 0 END) AS net_wage
      FROM tech_performance ${where}
      GROUP BY branch, tech_name_clean ORDER BY total_wage DESC
    `, params);

    res.json({ ranking: ranking.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/parts', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conditions = []; const params = []; let idx = 1;
    if (period) { conditions.push(`period = $${idx++}`); params.push(period); }
    if (branch) { conditions.push(`branch = $${idx++}`); params.push(branch); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const byType = await pool.query(`
      SELECT branch, part_type, COUNT(*) AS count,
        SUM(sale_qty) AS total_qty, SUM(sale_price_untaxed) AS total_sales,
        SUM(cost_untaxed) AS total_cost
      FROM parts_sales ${where}
      GROUP BY branch, part_type ORDER BY branch, total_sales DESC
    `, params);

    const topParts = await pool.query(`
      SELECT part_number, part_name, part_type,
        SUM(sale_qty) AS total_qty, SUM(sale_price_untaxed) AS total_sales
      FROM parts_sales ${where}
      GROUP BY part_number, part_name, part_type
      ORDER BY total_sales DESC LIMIT 20
    `, params);

    res.json({ byType: byType.rows, topParts: topParts.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/trend', async (req, res) => {
  try {
    const { branch } = req.query;
    const params = branch ? [branch] : [];
    const branchCond = branch ? 'AND branch = $1' : '';

    const trend = await pool.query(`
      SELECT period, branch, COUNT(DISTINCT work_order) AS car_count,
        SUM(total_untaxed) AS total_untaxed, SUM(engine_wage) AS engine_wage,
        SUM(parts_income) AS parts_income
      FROM repair_income WHERE 1=1 ${branchCond}
      GROUP BY period, branch ORDER BY period, branch
    `, params);

    res.json({ trend: trend.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/daily', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const colRows = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'business_query'
    `);
    const cols = colRows.rows.map(r => r.column_name);
    const dateCol   = cols.find(c => ['open_time','進廠時間','開單時間','開立時間','接車時間'].includes(c)) || 'open_time';
    const typeCol   = cols.find(c => ['repair_type','維修類型'].includes(c));
    const branchCol = cols.find(c => ['branch','據點','分店'].includes(c)) || 'branch';
    const periodCol = cols.find(c => ['period','期間'].includes(c)) || 'period';

    const conditions = [`"${dateCol}" IS NOT NULL`];
    if (typeCol) conditions.push(`"${typeCol}" NOT ILIKE '%PDI%'`);
    const params = []; let idx = 1;
    if (period) { conditions.push(`"${periodCol}" = $${idx++}`); params.push(period); }
    if (branch) { conditions.push(`"${branchCol}" = $${idx++}`); params.push(branch); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const daily = await pool.query(`
      SELECT "${dateCol}"::date AS arrive_date, "${branchCol}" AS branch, COUNT(*) AS car_count
      FROM business_query ${where}
      GROUP BY "${dateCol}"::date, "${branchCol}" ORDER BY arrive_date, "${branchCol}"
    `, params);

    const summary = await pool.query(`
      SELECT "${branchCol}" AS branch,
        SUM(daily_cnt) AS total_cars,
        COUNT(DISTINCT "${dateCol}"::date) AS working_days,
        ROUND(SUM(daily_cnt)::numeric / NULLIF(COUNT(DISTINCT "${dateCol}"::date),0),1) AS daily_avg,
        MAX(daily_cnt) AS max_day, MIN(daily_cnt) AS min_day
      FROM (
        SELECT "${branchCol}", "${dateCol}"::date, COUNT(*) AS daily_cnt
        FROM business_query ${where} GROUP BY "${branchCol}", "${dateCol}"::date
      ) sub
      GROUP BY "${branchCol}" ORDER BY "${branchCol}"
    `, params);

    res.json({ daily: daily.rows, summary: summary.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug/columns', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'business_query' ORDER BY ordinal_position
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/periods', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT period FROM repair_income
      UNION SELECT DISTINCT period FROM tech_performance
      UNION SELECT DISTINCT period FROM parts_sales
      ORDER BY period DESC
    `);
    res.json(r.rows.map(r => r.period));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SA 銷售矩陣 API
// GET /api/stats/sa-sales-matrix?period=202501&branch=AMA
// ============================================================
app.get('/api/stats/sa-sales-matrix', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const cfgRows = await pool.query(
      `SELECT id, config_name, filters FROM sa_sales_config ORDER BY id`
    );
    const configs = cfgRows.rows;
    if (!configs.length) return res.json({ configs: [], rows: [], colTotals: {} });

    const saMap = {};

    for (const cfg of configs) {
      const filters = cfg.filters || [];
      const catCodes  = filters.filter(f => f.type === 'category_code').map(f => f.value);
      const funcCodes = filters.filter(f => f.type === 'function_code').map(f => f.value);
      const partNums  = filters.filter(f => f.type === 'part_number').map(f => f.value);
      if (!catCodes.length && !funcCodes.length && !partNums.length) continue;

      const conds = [];
      const params = [];
      let idx = 1;
      if (period) { conds.push(`period = $${idx++}`); params.push(period); }
      if (branch) { conds.push(`branch = $${idx++}`); params.push(branch); }
      if (catCodes.length)  { conds.push(`category_code = ANY($${idx++})`); params.push(catCodes); }
      if (funcCodes.length) { conds.push(`function_code  = ANY($${idx++})`); params.push(funcCodes); }
      if (partNums.length)  { conds.push(`part_number    = ANY($${idx++})`); params.push(partNums); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const r = await pool.query(`
        SELECT
          branch,
          COALESCE(NULLIF(sales_person,''), '（未知）') AS sa_name,
          SUM(sale_qty)           AS qty,
          SUM(sale_price_untaxed) AS sales
        FROM parts_sales ${where}
        GROUP BY branch, sa_name
      `, params);

      for (const row of r.rows) {
        const key = `${row.branch}|||${row.sa_name}`;
        if (!saMap[key]) saMap[key] = { branch: row.branch, sa_name: row.sa_name, configs: {} };
        saMap[key].configs[cfg.id] = {
          qty:   parseFloat(row.qty   || 0),
          sales: parseFloat(row.sales || 0),
        };
      }
    }

    const rows = Object.values(saMap).sort((a, b) => {
      if (a.branch !== b.branch) return a.branch < b.branch ? -1 : 1;
      const sumA = Object.values(a.configs).reduce((s, c) => s + c.sales, 0);
      const sumB = Object.values(b.configs).reduce((s, c) => s + c.sales, 0);
      return sumB - sumA;
    });

    const colTotals = {};
    for (const cfg of configs) {
      colTotals[cfg.id] = rows.reduce((s, row) => {
        const c = row.configs[cfg.id] || { qty: 0, sales: 0 };
        return { qty: s.qty + c.qty, sales: s.sales + c.sales };
      }, { qty: 0, sales: 0 });
    }

    res.json({ configs, rows, colTotals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 密碼驗證 API
// ============================================================
const crypto = require('crypto');
const SESSION_TOKENS = new Set();

// helper — 從 DB 取目前密碼
async function getSettingsPassword() {
  const r = await pool.query("SELECT value FROM app_settings WHERE key='settings_password'");
  return r.rows[0]?.value || 'admin1234';
}

// POST /api/auth/settings  { password }  → { token }
app.post('/api/auth/settings', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '請輸入密碼' });
  const correct = await getSettingsPassword();
  if (password !== correct) return res.status(401).json({ error: '密碼錯誤' });
  const token = crypto.randomBytes(24).toString('hex');
  SESSION_TOKENS.add(token);
  setTimeout(() => SESSION_TOKENS.delete(token), 8 * 60 * 60 * 1000); // 8h
  res.json({ token });
});

// GET /api/auth/settings/check?token=...
app.get('/api/auth/settings/check', (req, res) => {
  const token = req.query.token;
  res.json({ valid: !!(token && SESSION_TOKENS.has(token)) });
});

// PUT /api/auth/settings/password  { token, currentPassword, newPassword }
app.put('/api/auth/settings/password', async (req, res) => {
  const { token, currentPassword, newPassword } = req.body;
  if (!token || !SESSION_TOKENS.has(token))
    return res.status(401).json({ error: '未驗證，請重新登入' });
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: '新密碼至少需要 4 個字元' });
  const correct = await getSettingsPassword();
  if (currentPassword !== correct)
    return res.status(401).json({ error: '目前密碼不正確' });
  await pool.query(
    "UPDATE app_settings SET value=$1 WHERE key='settings_password'",
    [newPassword]
  );
  // 清除所有現有 session，強迫重新登入
  SESSION_TOKENS.clear();
  res.json({ ok: true });
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
