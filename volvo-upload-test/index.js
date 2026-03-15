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
        id SERIAL PRIMARY KEY, file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(50), branch VARCHAR(10), period VARCHAR(6),
        row_count INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'success',
        error_msg TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS repair_income (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        work_order VARCHAR(30), settle_date DATE, customer VARCHAR(100), plate_no VARCHAR(20),
        account_type_code VARCHAR(10), account_type VARCHAR(30),
        parts_income NUMERIC(12,2) DEFAULT 0, accessories_income NUMERIC(12,2) DEFAULT 0,
        boutique_income NUMERIC(12,2) DEFAULT 0, engine_wage NUMERIC(12,2) DEFAULT 0,
        bodywork_income NUMERIC(12,2) DEFAULT 0, paint_income NUMERIC(12,2) DEFAULT 0,
        carwash_income NUMERIC(12,2) DEFAULT 0, outsource_income NUMERIC(12,2) DEFAULT 0,
        addon_income NUMERIC(12,2) DEFAULT 0, total_untaxed NUMERIC(12,2) DEFAULT 0,
        total_taxed NUMERIC(12,2) DEFAULT 0, parts_cost NUMERIC(12,2) DEFAULT 0,
        service_advisor VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tech_performance (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        tech_name_raw VARCHAR(50), tech_name_clean VARCHAR(50), dispatch_date DATE,
        work_order VARCHAR(30), work_code VARCHAR(30), task_content VARCHAR(200),
        standard_hours NUMERIC(8,2) DEFAULT 0, wage NUMERIC(12,2) DEFAULT 0,
        account_type VARCHAR(30), discount NUMERIC(5,2), wage_category VARCHAR(30),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_sales (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        category VARCHAR(20), category_detail VARCHAR(50), order_no VARCHAR(30),
        work_order VARCHAR(30), part_number VARCHAR(30), part_name VARCHAR(200),
        part_type VARCHAR(20), category_code VARCHAR(20), function_code VARCHAR(20),
        sale_qty NUMERIC(10,2) DEFAULT 0, retail_price NUMERIC(12,2) DEFAULT 0,
        sale_price_untaxed NUMERIC(12,2) DEFAULT 0, cost_untaxed NUMERIC(12,2) DEFAULT 0,
        discount_rate NUMERIC(5,4), department VARCHAR(20), pickup_person VARCHAR(50),
        sales_person VARCHAR(50), plate_no VARCHAR(20), created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS business_query (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        work_order VARCHAR(30), open_time TIMESTAMPTZ, settle_date DATE,
        plate_no VARCHAR(20), vin VARCHAR(30), status VARCHAR(20), repair_item VARCHAR(200),
        service_advisor VARCHAR(50), assigned_tech VARCHAR(50), repair_tech VARCHAR(50),
        repair_type VARCHAR(50), car_series VARCHAR(50), car_model VARCHAR(50),
        model_year VARCHAR(10), owner VARCHAR(100), is_ev VARCHAR(10),
        mileage_in INTEGER, mileage_out INTEGER, created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    const bqCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='business_query' AND column_name='work_order'`
    );
    if (!bqCheck.rows.length) {
      await client.query(`DROP TABLE IF EXISTS business_query`);
      await client.query(`
        CREATE TABLE business_query (
          id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
          work_order VARCHAR(30), open_time TIMESTAMPTZ, settle_date DATE,
          plate_no VARCHAR(20), vin VARCHAR(30), status VARCHAR(20), repair_item VARCHAR(200),
          service_advisor VARCHAR(50), assigned_tech VARCHAR(50), repair_tech VARCHAR(50),
          repair_type VARCHAR(50), car_series VARCHAR(50), car_model VARCHAR(50),
          model_year VARCHAR(10), owner VARCHAR(100), is_ev VARCHAR(10),
          mileage_in INTEGER, mileage_out INTEGER, created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_catalog (
        part_number VARCHAR(50) PRIMARY KEY, part_name VARCHAR(200),
        part_category VARCHAR(50), part_type VARCHAR(20), category_code VARCHAR(20),
        function_code VARCHAR(20), branch VARCHAR(10), updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sa_sales_config (
        id SERIAL PRIMARY KEY, config_name VARCHAR(100) NOT NULL,
        description TEXT, filters JSONB NOT NULL DEFAULT '[]',
        stat_method VARCHAR(20) NOT NULL DEFAULT 'amount',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`ALTER TABLE sa_sales_config ADD COLUMN IF NOT EXISTS stat_method VARCHAR(20) NOT NULL DEFAULT 'amount'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL)`);
    await client.query(`
      INSERT INTO app_settings (key, value) VALUES ('settings_password','admin1234')
      ON CONFLICT (key) DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS income_config (
        id SERIAL PRIMARY KEY, config_key VARCHAR(50) NOT NULL UNIQUE,
        config_value TEXT NOT NULL, description TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`
      INSERT INTO income_config (config_key, config_value, description)
      VALUES ('external_sales_category','外賣','外賣收入對應 parts_sales.category 值')
      ON CONFLICT (config_key) DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS working_days_config (
        id         SERIAL PRIMARY KEY,
        branch     VARCHAR(10) NOT NULL,
        period     VARCHAR(6)  NOT NULL,
        work_dates JSONB       NOT NULL DEFAULT '[]',
        note       TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (branch, period)
      )`);

    // ── 業績指標 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_metrics (
        id          SERIAL PRIMARY KEY,
        metric_name VARCHAR(100) NOT NULL,
        description TEXT    DEFAULT '',
        metric_type VARCHAR(20) NOT NULL DEFAULT 'repair_income',
        filters     JSONB   NOT NULL DEFAULT '[]',
        stat_field  VARCHAR(20) NOT NULL DEFAULT 'amount',
        unit        VARCHAR(20) DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )`);

    // ── 業績目標 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_targets (
        id              SERIAL PRIMARY KEY,
        metric_id       INTEGER NOT NULL,
        branch          VARCHAR(10) NOT NULL,
        period          VARCHAR(6)  NOT NULL,
        target_value    NUMERIC(15,2),
        last_year_value NUMERIC(15,2),
        note            TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(metric_id, branch, period)
      )`);

    // ── 四大營收目標（有費/鈑烤/一般/延保）──
    await client.query(`
      CREATE TABLE IF NOT EXISTS revenue_targets (
        id              SERIAL PRIMARY KEY,
        branch          VARCHAR(10)  NOT NULL,
        period          VARCHAR(6)   NOT NULL,
        paid_target     NUMERIC(15,2),
        paid_last_year  NUMERIC(15,2),
        bodywork_target     NUMERIC(15,2),
        bodywork_last_year  NUMERIC(15,2),
        general_target  NUMERIC(15,2),
        general_last_year   NUMERIC(15,2),
        extended_target NUMERIC(15,2),
        extended_last_year  NUMERIC(15,2),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(branch, period)
      )`);

    // ── 業績預估（各據點主管輸入本月預估）──
    await client.query(`
      CREATE TABLE IF NOT EXISTS revenue_estimates (
        id              SERIAL PRIMARY KEY,
        branch          VARCHAR(10)  NOT NULL,
        period          VARCHAR(6)   NOT NULL,
        paid_estimate     NUMERIC(15,2),
        bodywork_estimate NUMERIC(15,2),
        general_estimate  NUMERIC(15,2),
        extended_estimate NUMERIC(15,2),
        note            TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(branch, period)
      )`);

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

// ============================================================
// 各類解析
// ============================================================
const isNoteRow = v => { const s = String(v||'').trim(); return !s||s==='undefined'||/[\u4e00-\u9fff]/.test(s); };

const parseRepairIncome = (rows, branch, period) => rows
  .filter(r => !isNoteRow(pick(r,'工作單號','工單號')))
  .map(r => ({
    period, branch,
    work_order: String(pick(r,'工作單號','工單號')).trim(),
    settle_date: parseDate(pick(r,'結算日期')),
    customer: String(pick(r,'客戶名稱','客戶')).trim(),
    plate_no: String(pick(r,'車牌號碼','車牌')).trim(),
    account_type_code: String(pick(r,'帳類代碼')).trim(),
    account_type: String(pick(r,'帳類')).trim(),
    parts_income: num(pick(r,'零件收入')),
    accessories_income: num(pick(r,'配件收入')),
    boutique_income: num(pick(r,'精品收入')),
    engine_wage: num(pick(r,'引擎工資','工資收入')),
    bodywork_income: num(pick(r,'鈑金收入')),
    paint_income: num(pick(r,'烤漆收入')),
    carwash_income: num(pick(r,'洗車美容收入','洗車收入')),
    outsource_income: num(pick(r,'外包收入')),
    addon_income: num(pick(r,'附加服務收入','附加服務')),
    total_untaxed: num(pick(r,'收入合計（未稅）','收入合計(未稅)','收入合計')),
    total_taxed: num(pick(r,'收入合計(含稅)','收入合計（含稅）')),
    parts_cost: num(pick(r,'零件成本（未稅）','零件成本(未稅)','零件成本')),
    service_advisor: String(pick(r,'服務顧問','接待員')).trim(),
  }));

const parseTechPerformance = (rows, branch, period) => rows
  .filter(r => !isNoteRow(pick(r,'工作單號','工單號')))
  .map(r => ({
    period, branch,
    tech_name_raw: String(pick(r,'技師姓名','姓名')).trim(),
    tech_name_clean: String(pick(r,'技師姓名','姓名')).trim().replace(/\s+/g,''),
    dispatch_date: parseDate(pick(r,'出廠日期')),
    work_order: String(pick(r,'工作單號','工單號')).trim(),
    work_code: String(pick(r,'維修工時代碼','工時代碼')).trim(),
    task_content: String(pick(r,'作業內容')).trim(),
    standard_hours: num(pick(r,'標準工時')),
    wage: num(pick(r,'工資')),
    account_type: String(pick(r,'帳類')).trim(),
    discount: num(pick(r,'折扣')),
    wage_category: String(pick(r,'工資類別')).trim(),
  }));

const parsePartsSales = (rows, branch, period) => rows.map(r => {
  const rowBranch = branch || (() => {
    const b = String(r['據點代碼']||r['據點']||r['點']||r['分店']||'').toUpperCase().trim();
    return ['AMA','AMC','AMD'].includes(b) ? b : null;
  })();
  return {
    period, branch: rowBranch,
    category: String(pick(r,'類別')).trim(),
    category_detail: String(pick(r,'類別細節','類別明細')).trim(),
    order_no: String(pick(r,'結帳單號')).trim(),
    work_order: String(pick(r,'工單號','工作單號')).trim(),
    part_number: String(pick(r,'零件編號')).trim(),
    part_name: String(pick(r,'零件名稱')).trim(),
    part_type: String(pick(r,'Paycode','種類','零件種類')).trim(),
    category_code: String(pick(r,'零件類別')).trim(),
    function_code: String(pick(r,'功能碼')).trim(),
    sale_qty: num(pick(r,'銷售數量','數量')),
    retail_price: num(pick(r,'零售價')),
    sale_price_untaxed: num(pick(r,'實際售價(稅前)','實際售價(未稅)','實際售價')),
    cost_untaxed: num(pick(r,'成本總價(稅前)','成本(未稅)','成本')),
    discount_rate: num(pick(r,'折扣率')),
    department: String(pick(r,'付款部門','部門')).trim(),
    pickup_person: String(pick(r,'領料人員','領料人','接待人員')).trim(),
    sales_person: String(pick(r,'銷售人員','業務員')).trim(),
    plate_no: String(pick(r,'車牌號碼','車牌')).trim(),
  };
});

const parseBusinessQuery = (rows, branch, period) => rows.map(r => {
  const rowBranch = branch || (() => {
    const b = String(r['據點代碼']||r['據點']||r['點']||r['分店']||'').toUpperCase().trim();
    return ['AMA','AMC','AMD'].includes(b) ? b : null;
  })();
  return {
    period, branch: rowBranch,
    work_order: String(pick(r,'工單號','工作單號')).trim(),
    open_time: parseDateTime(pick(r,'工單開單時間','開單時間','開工時間','進廠時間','開立時間','開單日期','接車時間')),
    settle_date: parseDate(pick(r,'結算日期')),
    plate_no: String(pick(r,'車牌號碼','車牌號','車牌')).trim(),
    vin: String(pick(r,'車身號碼','VIN')).trim(),
    status: String(pick(r,'工單狀態','狀態')).trim(),
    repair_item: String(pick(r,'交修項目')).trim(),
    service_advisor: String(pick(r,'服務顧問')).trim(),
    assigned_tech: String(pick(r,'指定技師')).trim(),
    repair_tech: String(pick(r,'維修技師')).trim(),
    repair_type: String(pick(r,'維修類型')).trim(),
    car_series: String(pick(r,'車系')).trim(),
    car_model: String(pick(r,'車型')).trim(),
    model_year: String(pick(r,'年式')).trim(),
    owner: String(pick(r,'車主')).trim(),
    is_ev: String(pick(r,'電車','油電','動力')).trim(),
    mileage_in: parseInt(pick(r,'進廠里程'))||null,
    mileage_out: parseInt(pick(r,'出廠里程'))||null,
  };
});

const parsePartsCatalog = (rows) => rows
  .filter(r => { const p=String(pick(r,'零件編號','料號')||'').trim(); return p&&p!=='undefined'; })
  .map(r => ({
    part_number: String(pick(r,'零件編號','料號')).trim(),
    part_name: String(pick(r,'零件名稱','品名')).trim(),
    part_category: String(pick(r,'零件類別')).trim(),
    part_type: String(pick(r,'零件種類','種類')).trim(),
    category_code: String(pick(r,'零件類別')).trim(),
    function_code: String(pick(r,'功能碼')).trim(),
    branch: String(pick(r,'據點')).trim()||null,
  }));

// ============================================================
// 批次 INSERT
// ============================================================
const batchInsert = async (client, table, cols, rows) => {
  let total = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i+BATCH);
    const values = [];
    const ph = batch.map((row, ri) =>
      '(' + cols.map((col, ci) => { values.push(row[col]??null); return `$${ri*cols.length+ci+1}`; }).join(',') + ')'
    );
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')}`, values);
    total += batch.length;
  }
  return total;
};

const upsertPartsCatalog = async (client, rows) => {
  let count = 0;
  for (let i = 0; i < rows.length; i += 200) {
    for (const r of rows.slice(i, i+200)) {
      await client.query(`
        INSERT INTO parts_catalog (part_number,part_name,part_category,part_type,category_code,function_code,branch,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (part_number) DO UPDATE SET
          part_name=EXCLUDED.part_name,part_category=EXCLUDED.part_category,
          part_type=EXCLUDED.part_type,category_code=EXCLUDED.category_code,
          function_code=EXCLUDED.function_code,branch=EXCLUDED.branch,updated_at=NOW()
      `, [r.part_number,r.part_name,r.part_category,r.part_type,r.category_code,r.function_code,r.branch]);
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
    try { filename = Buffer.from(file.originalname,'latin1').toString('utf8'); } catch(e) {}
    try {
      const workbook = XLSX.read(file.buffer, { type:'buffer', cellDates:true });
      const fileType = detectFileType(filename, workbook.SheetNames);
      const branch = detectBranch(filename);
      const period = detectPeriod(filename);
      if (!fileType) throw new Error('無法辨識檔案類型，請確認檔名包含關鍵字（維修收入/技師績效/零件銷售/業務查詢）');
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
      if (rawRows.length > 0) console.log(`[${filename}] 欄位: ${Object.keys(rawRows[0]).join(' | ')}`);
      const client = await pool.connect();
      let rowCount = 0;
      try {
        await client.query('BEGIN');
        if (fileType === 'repair_income') {
          if (!branch||!period) throw new Error('維修收入需要據點和期間');
          await client.query('DELETE FROM repair_income WHERE period=$1 AND branch=$2',[period,branch]);
          rowCount = await batchInsert(client,'repair_income',
            ['period','branch','work_order','settle_date','customer','plate_no','account_type_code','account_type',
             'parts_income','accessories_income','boutique_income','engine_wage','bodywork_income','paint_income',
             'carwash_income','outsource_income','addon_income','total_untaxed','total_taxed','parts_cost','service_advisor'],
            parseRepairIncome(rawRows,branch,period));
        } else if (fileType === 'tech_performance') {
          if (!branch||!period) throw new Error('技師績效需要據點和期間');
          await client.query('DELETE FROM tech_performance WHERE period=$1 AND branch=$2',[period,branch]);
          rowCount = await batchInsert(client,'tech_performance',
            ['period','branch','tech_name_raw','tech_name_clean','dispatch_date','work_order','work_code',
             'task_content','standard_hours','wage','account_type','discount','wage_category'],
            parseTechPerformance(rawRows,branch,period));
        } else if (fileType === 'parts_sales') {
          if (!period) throw new Error('零件銷售需要期間');
          branch ? await client.query('DELETE FROM parts_sales WHERE period=$1 AND branch=$2',[period,branch])
                 : await client.query('DELETE FROM parts_sales WHERE period=$1',[period]);
          rowCount = await batchInsert(client,'parts_sales',
            ['period','branch','category','category_detail','order_no','work_order','part_number','part_name',
             'part_type','category_code','function_code','sale_qty','retail_price','sale_price_untaxed',
             'cost_untaxed','discount_rate','department','pickup_person','sales_person','plate_no'],
            parsePartsSales(rawRows,branch,period));
        } else if (fileType === 'business_query') {
          if (!period) throw new Error('業務查詢需要期間');
          branch ? await client.query('DELETE FROM business_query WHERE period=$1 AND branch=$2',[period,branch])
                 : await client.query('DELETE FROM business_query WHERE period=$1',[period]);
          rowCount = await batchInsert(client,'business_query',
            ['period','branch','work_order','open_time','settle_date','plate_no','vin','status','repair_item',
             'service_advisor','assigned_tech','repair_tech','repair_type','car_series','car_model',
             'model_year','owner','is_ev','mileage_in','mileage_out'],
            parseBusinessQuery(rawRows,branch,period));
        } else if (fileType === 'parts_catalog') {
          rowCount = await upsertPartsCatalog(client, parsePartsCatalog(rawRows));
        }
        await client.query(
          `INSERT INTO upload_history (file_name,file_type,branch,period,row_count,status) VALUES ($1,$2,$3,$4,$5,'success')`,
          [filename,fileType,branch,period,rowCount]);
        await client.query('COMMIT');
        results.push({ filename, status:'success', fileType, branch, period, rowCount });
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    } catch (err) {
      results.push({ filename, status:'error', error:err.message });
      try { await pool.query(`INSERT INTO upload_history (file_name,file_type,status,error_msg) VALUES ($1,'unknown','error',$2)`,[filename,err.message]); } catch(e) {}
    }
  }
  res.json({ results });
});

// ============================================================
// SA 銷售設定 API
// ============================================================
app.get('/api/sa-config', async (req, res) => {
  try { res.json((await pool.query(`SELECT id,config_name,description,filters,stat_method,created_at,updated_at FROM sa_sales_config ORDER BY id`)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/sa-config', async (req, res) => {
  const { config_name, description, filters, stat_method } = req.body;
  if (!config_name) return res.status(400).json({ error:'名稱為必填' });
  if (!Array.isArray(filters)||!filters.length) return res.status(400).json({ error:'至少需要一個篩選條件' });
  const method = ['amount','quantity','count'].includes(stat_method) ? stat_method : 'amount';
  try { res.json((await pool.query(`INSERT INTO sa_sales_config (config_name,description,filters,stat_method) VALUES ($1,$2,$3,$4) RETURNING *`,[config_name.trim(),description||'',JSON.stringify(filters),method])).rows[0]); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/sa-config/:id', async (req, res) => {
  const { config_name, description, filters, stat_method } = req.body;
  if (!config_name) return res.status(400).json({ error:'名稱為必填' });
  if (!Array.isArray(filters)||!filters.length) return res.status(400).json({ error:'至少需要一個篩選條件' });
  const method = ['amount','quantity','count'].includes(stat_method) ? stat_method : 'amount';
  try {
    const r = await pool.query(`UPDATE sa_sales_config SET config_name=$1,description=$2,filters=$3,stat_method=$4,updated_at=NOW() WHERE id=$5 RETURNING *`,[config_name.trim(),description||'',JSON.stringify(filters),method,req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error:'找不到設定' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/sa-config/:id', async (req, res) => {
  try { await pool.query(`DELETE FROM sa_sales_config WHERE id=$1`,[req.params.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/sa-config/parts-lookup', async (req, res) => {
  const { type, q } = req.query;
  if (!['category_code','function_code','part_number'].includes(type)) return res.status(400).json({ error:'無效的 type' });
  try {
    const search = `%${(q||'').trim()}%`;
    let sql, params;
    if (type === 'part_number') {
      sql = `SELECT part_number AS value, part_name AS label, category_code, function_code FROM parts_catalog WHERE part_number ILIKE $1 OR part_name ILIKE $1 ORDER BY part_number LIMIT 30`;
      params = [search];
    } else {
      sql = `SELECT ${type} AS value, COUNT(*) AS part_count, STRING_AGG(DISTINCT part_name,'、' ORDER BY part_name) FILTER (WHERE part_name!='') AS sample_names FROM parts_catalog WHERE ${type} ILIKE $1 AND ${type}!='' GROUP BY ${type} ORDER BY part_count DESC LIMIT 30`;
      params = [search];
    }
    res.json((await pool.query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 收入設定 API
// ============================================================
app.get('/api/income-config', async (req, res) => {
  try {
    const r = await pool.query(`SELECT config_key, config_value, description FROM income_config ORDER BY id`);
    const map = {}; r.rows.forEach(row => { map[row.config_key] = row.config_value; });
    res.json({ rows: r.rows, map });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/income-config/:key', async (req, res) => {
  const { value } = req.body;
  if (!value) return res.status(400).json({ error:'值為必填' });
  try { await pool.query(`UPDATE income_config SET config_value=$1,updated_at=NOW() WHERE config_key=$2`,[value.trim(),req.params.key]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 工作天數設定 API
// ============================================================
app.get('/api/working-days', async (req, res) => {
  const { branch, period } = req.query;
  try {
    if (branch && period) {
      const r = await pool.query(
        `SELECT branch, period, work_dates, note, updated_at FROM working_days_config WHERE branch=$1 AND period=$2`,
        [branch, period]
      );
      res.json(r.rows[0] || { branch, period, work_dates: [], note: '' });
    } else {
      const r = await pool.query(
        `SELECT branch, period, work_dates, note, updated_at FROM working_days_config ORDER BY period DESC, branch`
      );
      res.json(r.rows);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/working-days', async (req, res) => {
  const { branch, period, work_dates, note } = req.body;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  if (!Array.isArray(work_dates)) return res.status(400).json({ error: 'work_dates 必須為陣列' });
  try {
    await pool.query(
      `INSERT INTO working_days_config (branch, period, work_dates, note, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (branch, period) DO UPDATE SET work_dates=$3, note=$4, updated_at=NOW()`,
      [branch, period, JSON.stringify(work_dates), note || '']
    );
    res.json({ ok: true, count: work_dates.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/working-days', async (req, res) => {
  const { branch, period } = req.query;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  try {
    await pool.query(`DELETE FROM working_days_config WHERE branch=$1 AND period=$2`, [branch, period]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 查詢 API
// ============================================================
app.get('/api/counts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 'repair_income' AS 表格,COUNT(*) AS 筆數 FROM repair_income UNION ALL
      SELECT 'tech_performance',COUNT(*) FROM tech_performance UNION ALL
      SELECT 'parts_sales',COUNT(*) FROM parts_sales UNION ALL
      SELECT 'business_query',COUNT(*) FROM business_query UNION ALL
      SELECT 'parts_catalog',COUNT(*) FROM parts_catalog UNION ALL
      SELECT 'upload_history',COUNT(*) FROM upload_history`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/history', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'ok', db:'connected' }); }
  catch (err) { res.status(500).json({ status:'error', error:err.message }); }
});

// ============================================================
// 統計 API — 維修收入
// ============================================================
app.get('/api/stats/repair', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [summary, bySA, totals] = await Promise.all([
      pool.query(`SELECT branch,account_type,COUNT(*) AS work_order_count,SUM(total_untaxed) AS total_untaxed,SUM(parts_income) AS parts_income,SUM(accessories_income) AS accessories_income,SUM(boutique_income) AS boutique_income,SUM(engine_wage) AS engine_wage,SUM(bodywork_income+paint_income) AS bodywork_income,SUM(parts_cost) AS parts_cost FROM repair_income ${where} GROUP BY branch,account_type ORDER BY branch,total_untaxed DESC`,params),
      pool.query(`SELECT branch,service_advisor,COUNT(DISTINCT work_order) AS car_count,SUM(total_untaxed) AS total_untaxed,SUM(engine_wage) AS engine_wage,SUM(parts_income) AS parts_income FROM repair_income ${where} GROUP BY branch,service_advisor HAVING service_advisor IS NOT NULL AND service_advisor!='' ORDER BY total_untaxed DESC`,params),
      pool.query(`SELECT branch,COUNT(DISTINCT work_order) AS car_count,SUM(total_untaxed) AS total_untaxed,SUM(engine_wage) AS engine_wage,SUM(parts_income) AS parts_income,SUM(accessories_income) AS accessories_income,SUM(boutique_income) AS boutique_income,SUM(bodywork_income+paint_income) AS bodywork_income,SUM(parts_cost) AS parts_cost FROM repair_income ${where} GROUP BY branch ORDER BY branch`,params),
    ]);
    res.json({ summary:summary.rows, bySA:bySA.rows, totals:totals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 統計 API — 收入分類明細
// ============================================================
app.get('/api/stats/income-summary', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';

    const cfgRow = await pool.query(`SELECT config_value FROM income_config WHERE config_key='external_sales_category'`);
    const externalCategory = cfgRow.rows[0]?.config_value || '外賣';

    const byType = await pool.query(`
      SELECT branch, account_type,
        COUNT(DISTINCT work_order)              AS car_count,
        SUM(total_untaxed)                      AS total_untaxed,
        ROUND(SUM(engine_wage)/1.05)            AS engine_wage_nt,
        ROUND(SUM(parts_income)/1.05)           AS parts_income_nt,
        ROUND(SUM(accessories_income)/1.05)     AS accessories_income_nt,
        ROUND(SUM(boutique_income)/1.05)        AS boutique_income_nt,
        ROUND(SUM(bodywork_income)/1.05)        AS bodywork_income_nt,
        ROUND(SUM(paint_income)/1.05)           AS paint_income_nt,
        ROUND(SUM(carwash_income)/1.05)         AS carwash_income_nt,
        ROUND(SUM(outsource_income)/1.05)       AS outsource_income_nt,
        ROUND(SUM(addon_income)/1.05)           AS addon_income_nt,
        SUM(parts_cost)                         AS parts_cost_nt
      FROM repair_income ${where}
      GROUP BY branch, account_type
      ORDER BY branch,
        CASE WHEN account_type ILIKE '%一般%' THEN 1 WHEN account_type ILIKE '%保險%' THEN 2
             WHEN account_type ILIKE '%延保%' THEN 3 WHEN account_type ILIKE '%票%'   THEN 4
             WHEN account_type ILIKE '%內結%' THEN 5 WHEN account_type ILIKE '%保固%' THEN 6
             WHEN account_type ILIKE '%VSA%' OR account_type ILIKE '%vsa%' THEN 7
             WHEN account_type ILIKE '%善意%' THEN 8 ELSE 9 END,
        total_untaxed DESC
    `, params);

    const extConds = []; const extParams = []; let eidx = 1;
    if (period) { extConds.push(`period=$${eidx++}`); extParams.push(period); }
    if (branch) { extConds.push(`branch=$${eidx++}`); extParams.push(branch); }
    extConds.push(`category=$${eidx++}`); extParams.push(externalCategory);

    const externalSales = await pool.query(`
      SELECT branch, COUNT(DISTINCT order_no) AS order_count,
        SUM(sale_qty) AS total_qty, SUM(sale_price_untaxed) AS total_sales, SUM(cost_untaxed) AS total_cost
      FROM parts_sales WHERE ${extConds.join(' AND ')}
      GROUP BY branch ORDER BY branch
    `, extParams);

    const techConds = []; const techParams = []; let tidx = 1;
    if (period) { techConds.push(`period=$${tidx++}`); techParams.push(period); }
    if (branch) { techConds.push(`branch=$${tidx++}`); techParams.push(branch); }
    const techWhere = techConds.length ? 'WHERE '+techConds.join(' AND ') : '';

    const techByType = await pool.query(`
      SELECT branch, account_type, COUNT(DISTINCT work_order) AS car_count,
        SUM(wage) AS total_wage, SUM(standard_hours) AS total_hours
      FROM tech_performance ${techWhere}
      GROUP BY branch, account_type
    `, techParams);

    res.json({ byType:byType.rows, externalSales:externalSales.rows, techByType:techByType.rows, externalCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 統計 API — 技師工資 / 零件銷售 / 月份趨勢
// ============================================================
app.get('/api/stats/tech', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const r = await pool.query(`
      SELECT branch,tech_name_clean,COUNT(DISTINCT work_order) AS car_count,
        SUM(standard_hours) AS total_hours,SUM(wage) AS total_wage,
        SUM(CASE WHEN wage_category ILIKE '%美容%' THEN wage ELSE 0 END) AS beauty_wage,
        SUM(CASE WHEN wage_category NOT ILIKE '%美容%' THEN wage ELSE 0 END) AS net_wage
      FROM tech_performance ${where} GROUP BY branch,tech_name_clean ORDER BY total_wage DESC
    `, params);
    res.json({ ranking: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/parts', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [byType, topParts] = await Promise.all([
      pool.query(`SELECT branch,part_type,COUNT(*) AS count,SUM(sale_qty) AS total_qty,SUM(sale_price_untaxed) AS total_sales,SUM(cost_untaxed) AS total_cost FROM parts_sales ${where} GROUP BY branch,part_type ORDER BY branch,total_sales DESC`,params),
      pool.query(`SELECT part_number,part_name,part_type,SUM(sale_qty) AS total_qty,SUM(sale_price_untaxed) AS total_sales FROM parts_sales ${where} GROUP BY part_number,part_name,part_type ORDER BY total_sales DESC LIMIT 20`,params),
    ]);
    res.json({ byType:byType.rows, topParts:topParts.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/trend', async (req, res) => {
  try {
    const { branch } = req.query;
    const params = branch ? [branch] : [];
    const bc = branch ? 'AND branch=$1' : '';
    const r = await pool.query(`SELECT period,branch,COUNT(DISTINCT work_order) AS car_count,SUM(total_untaxed) AS total_untaxed,SUM(engine_wage) AS engine_wage,SUM(parts_income) AS parts_income FROM repair_income WHERE 1=1 ${bc} GROUP BY period,branch ORDER BY period,branch`,params);
    res.json({ trend: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 統計 API — 每日進廠台數
// ============================================================
app.get('/api/stats/daily', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const colRows = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='business_query'`);
    const cols = colRows.rows.map(r => r.column_name);
    const dateCol   = cols.find(c => ['open_time','進廠時間','開單時間','開立時間','接車時間'].includes(c)) || 'open_time';
    const typeCol   = cols.find(c => ['repair_type','維修類型'].includes(c));
    const branchCol = cols.find(c => ['branch','據點','分店'].includes(c)) || 'branch';
    const periodCol = cols.find(c => ['period','期間'].includes(c)) || 'period';

    const conditions = [`"${dateCol}" IS NOT NULL`];
    if (typeCol) conditions.push(`"${typeCol}" NOT ILIKE '%PDI%'`);
    const params = []; let idx = 1;
    if (period) { conditions.push(`"${periodCol}"=$${idx++}`); params.push(period); }
    if (branch) { conditions.push(`"${branchCol}"=$${idx++}`); params.push(branch); }
    const where = 'WHERE '+conditions.join(' AND ');

    const [daily, autoSummary] = await Promise.all([
      pool.query(`SELECT "${dateCol}"::date AS arrive_date,"${branchCol}" AS branch,COUNT(*) AS car_count FROM business_query ${where} GROUP BY "${dateCol}"::date,"${branchCol}" ORDER BY arrive_date,"${branchCol}"`,params),
      pool.query(`SELECT "${branchCol}" AS branch,SUM(daily_cnt) AS total_cars,COUNT(DISTINCT "${dateCol}"::date) AS auto_working_days,MAX(daily_cnt) AS max_day,MIN(daily_cnt) AS min_day FROM (SELECT "${branchCol}","${dateCol}"::date,COUNT(*) AS daily_cnt FROM business_query ${where} GROUP BY "${branchCol}","${dateCol}"::date) sub GROUP BY "${branchCol}" ORDER BY "${branchCol}"`,params),
    ]);

    const wdMap = {};
    if (period) {
      for (const row of autoSummary.rows) {
        const wdRow = await pool.query(
          `SELECT work_dates FROM working_days_config WHERE branch=$1 AND period=$2`,
          [row.branch, period]
        );
        if (wdRow.rows.length && wdRow.rows[0].work_dates) {
          wdMap[row.branch] = wdRow.rows[0].work_dates;
        }
      }
    }

    const summary = autoSummary.rows.map(r => {
      const configured = wdMap[r.branch] || null;
      const configuredDays = configured ? configured.length : null;
      const workingDays    = configuredDays !== null ? configuredDays : parseInt(r.auto_working_days || 0);
      const totalCars      = parseInt(r.total_cars || 0);
      return {
        branch: r.branch,
        total_cars: totalCars,
        working_days: workingDays,
        auto_working_days: parseInt(r.auto_working_days || 0),
        configured_working_days: configuredDays,
        daily_avg: workingDays > 0 ? (totalCars / workingDays).toFixed(1) : '0',
        max_day: r.max_day,
        min_day: r.min_day,
      };
    });

    res.json({ daily: daily.rows, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug/columns', async (req, res) => {
  try { res.json((await pool.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='business_query' ORDER BY ordinal_position`)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/periods', async (req, res) => {
  try {
    // DB 中實際有資料的期間
    const r = await pool.query(`
      SELECT DISTINCT period FROM repair_income
      UNION SELECT DISTINCT period FROM tech_performance
      UNION SELECT DISTINCT period FROM parts_sales
      UNION SELECT DISTINCT period FROM revenue_targets
      ORDER BY period DESC`);
    const dbPeriods = new Set(r.rows.map(r => r.period));

    // 補全：今年 + 去年 的全部 12 個月
    const now = new Date();
    const extraPeriods = new Set();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
      for (let m = 12; m >= 1; m--) {
        extraPeriods.add(`${y}${String(m).padStart(2,'0')}`);
      }
    }
    // 合併並排序（DB資料優先保留，extra補充沒出現的）
    const allPeriods = [...new Set([...dbPeriods, ...extraPeriods])].sort().reverse();
    res.json(allPeriods);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SA 銷售矩陣 API
// ============================================================
app.get('/api/stats/sa-sales-matrix', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const configs = (await pool.query(`SELECT id,config_name,filters,stat_method FROM sa_sales_config ORDER BY id`)).rows;
    if (!configs.length) return res.json({ configs:[], rows:[], colTotals:{} });
    const saMap = {};
    for (const cfg of configs) {
      const filters = cfg.filters||[];
      const catCodes = filters.filter(f=>f.type==='category_code').map(f=>f.value);
      const funcCodes = filters.filter(f=>f.type==='function_code').map(f=>f.value);
      const partNums = filters.filter(f=>f.type==='part_number').map(f=>f.value);
      const partTypes = filters.filter(f=>f.type==='part_type').map(f=>f.value);
      if (!catCodes.length&&!funcCodes.length&&!partNums.length&&!partTypes.length) continue;
      const conds=[]; const params=[]; let idx=1;
      if (period) { conds.push(`period=$${idx++}`); params.push(period); }
      if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
      if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); params.push(catCodes); }
      if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`);  params.push(funcCodes); }
      if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);    params.push(partNums); }
      if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);      params.push(partTypes); }
      const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
      const r = await pool.query(`SELECT branch,COALESCE(NULLIF(sales_person,''),'（未知）') AS sa_name,SUM(sale_qty) AS qty,SUM(sale_price_untaxed) AS sales,COUNT(*) AS cnt FROM parts_sales ${where} GROUP BY branch,sa_name`,params);
      for (const row of r.rows) {
        const key = `${row.branch}|||${row.sa_name}`;
        if (!saMap[key]) saMap[key] = { branch:row.branch, sa_name:row.sa_name, configs:{} };
        saMap[key].configs[cfg.id] = { qty:parseFloat(row.qty||0), sales:parseFloat(row.sales||0), cnt:parseInt(row.cnt||0) };
      }
    }
    const rows = Object.values(saMap).sort((a,b) => {
      if (a.branch!==b.branch) return a.branch<b.branch?-1:1;
      return Object.values(b.configs).reduce((s,c)=>s+c.sales,0) - Object.values(a.configs).reduce((s,c)=>s+c.sales,0);
    });
    const colTotals = {};
    for (const cfg of configs) {
      colTotals[cfg.id] = rows.reduce((s,row) => { const c=row.configs[cfg.id]||{qty:0,sales:0,cnt:0}; return {qty:s.qty+c.qty,sales:s.sales+c.sales,cnt:s.cnt+c.cnt}; },{qty:0,sales:0,cnt:0});
    }
    res.json({ configs, rows, colTotals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 精品 & 配件銷售分析 API
// ============================================================
app.get('/api/stats/boutique-accessories', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const params = []; let idx = 1;
    const conds = [`pc.part_type IN ('精品','配件')`];
    if (period) { conds.push(`ps.period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`ps.branch=$${idx++}`); params.push(branch); }
    const where = conds.join(' AND ');

    const r = await pool.query(`
      SELECT
        ps.branch,
        COALESCE(NULLIF(ps.sales_person,''), '（未知）')  AS sales_person,
        pc.part_type                                       AS part_type,
        COALESCE(NULLIF(ps.part_type,''), '（未分類）')   AS account_type,
        SUM(ps.sale_price_untaxed)  AS total_sales,
        SUM(ps.cost_untaxed)        AS total_cost,
        SUM(ps.sale_qty)            AS total_qty,
        COUNT(*)                    AS cnt
      FROM parts_sales ps
      INNER JOIN parts_catalog pc ON ps.part_number = pc.part_number
      WHERE ${where}
      GROUP BY ps.branch, ps.sales_person, pc.part_type, ps.part_type
      ORDER BY ps.branch, pc.part_type, SUM(ps.sale_price_untaxed) DESC
    `, params);

    const kpi = await pool.query(`
      SELECT
        ps.branch,
        pc.part_type                AS part_type,
        SUM(ps.sale_price_untaxed)  AS total_sales,
        SUM(ps.cost_untaxed)        AS total_cost,
        SUM(ps.sale_qty)            AS total_qty,
        COUNT(DISTINCT ps.order_no) AS order_count
      FROM parts_sales ps
      INNER JOIN parts_catalog pc ON ps.part_number = pc.part_number
      WHERE ${where}
      GROUP BY ps.branch, pc.part_type
      ORDER BY ps.branch, pc.part_type
    `, params);

    res.json({ rows: r.rows, kpi: kpi.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 業績指標 API (CRUD)
// ============================================================
app.get('/api/performance-metrics', async (req, res) => {
  try {
    res.json((await pool.query(`SELECT * FROM performance_metrics ORDER BY sort_order, id`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/performance-metrics', async (req, res) => {
  const { metric_name, description, metric_type, filters, stat_field, unit, sort_order } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(
      `INSERT INTO performance_metrics (metric_name,description,metric_type,filters,stat_field,unit,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [metric_name.trim(), description||'', metric_type||'repair_income',
       JSON.stringify(filters||[]), stat_field||'amount', unit||'', sort_order||0]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/performance-metrics/:id', async (req, res) => {
  const { metric_name, description, metric_type, filters, stat_field, unit, sort_order } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(
      `UPDATE performance_metrics SET metric_name=$1,description=$2,metric_type=$3,
       filters=$4,stat_field=$5,unit=$6,sort_order=$7 WHERE id=$8 RETURNING *`,
      [metric_name.trim(), description||'', metric_type||'repair_income',
       JSON.stringify(filters||[]), stat_field||'amount', unit||'', sort_order||0, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '找不到指標' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/performance-metrics/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM performance_targets WHERE metric_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM performance_metrics WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 業績目標 API
// ============================================================
app.get('/api/performance-targets', async (req, res) => {
  const { metric_id, period } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (metric_id) { conds.push(`metric_id=$${idx++}`); params.push(metric_id); }
    if (period)    { conds.push(`period=$${idx++}`);    params.push(period); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(`SELECT * FROM performance_targets ${where} ORDER BY branch`, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/performance-targets/batch', async (req, res) => {
  const { metric_id, period, entries } = req.body;
  if (!metric_id || !period || !Array.isArray(entries)) return res.status(400).json({ error: '參數不完整' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      await client.query(
        `INSERT INTO performance_targets (metric_id,branch,period,target_value,last_year_value,note,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (metric_id,branch,period) DO UPDATE SET
           target_value=$4, last_year_value=$5, note=$6, updated_at=NOW()`,
        [metric_id, e.branch, period, e.target_value||null, e.last_year_value||null, e.note||'']
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ============================================================
// 營收目標 API
// ============================================================
app.get('/api/revenue-targets', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(`SELECT * FROM revenue_targets ${where} ORDER BY period, branch`, params)).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/revenue-targets/batch', async (req, res) => {
  const { entries } = req.body; // [{branch, period, paid_target, paid_last_year, ...}]
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: '無資料' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (!e.branch || !e.period) continue;
      await client.query(`
        INSERT INTO revenue_targets (branch,period,paid_target,paid_last_year,bodywork_target,bodywork_last_year,general_target,general_last_year,extended_target,extended_last_year,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (branch,period) DO UPDATE SET
          paid_target=$3,paid_last_year=$4,bodywork_target=$5,bodywork_last_year=$6,
          general_target=$7,general_last_year=$8,extended_target=$9,extended_last_year=$10,updated_at=NOW()
      `, [e.branch, e.period,
          e.paid_target||null, e.paid_last_year||null,
          e.bodywork_target||null, e.bodywork_last_year||null,
          e.general_target||null, e.general_last_year||null,
          e.extended_target||null, e.extended_last_year||null]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: entries.length });
  } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.delete('/api/revenue-targets', async (req, res) => {
  const { branch, period } = req.query;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  try {
    await pool.query(`DELETE FROM revenue_targets WHERE branch=$1 AND period=$2`, [branch, period]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 解析營收目標 Excel
app.post('/api/upload-revenue-targets', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Excel 無資料列' });

    const numCol = (row, ...keys) => {
      for (const k of keys) {
        const v = row[k]; const n = parseFloat(v);
        if (v !== '' && v !== undefined && !isNaN(n)) return n;
      }
      return null;
    };

    const entries = [];
    for (const row of rows) {
      const branch = String(row['據點']||row['Branch']||'').trim().toUpperCase();
      const period = String(row['期間']||row['Period']||'').trim().replace(/\D/g,'');
      if (!['AMA','AMC','AMD'].includes(branch) || period.length !== 6) continue;
      entries.push({
        branch, period,
        paid_target:        numCol(row,'有費營收_目標','有費目標'),
        paid_last_year:     numCol(row,'有費營收_去年','有費去年'),
        bodywork_target:    numCol(row,'鈑烤營收_目標','鈑烤目標'),
        bodywork_last_year: numCol(row,'鈑烤營收_去年','鈑烤去年'),
        general_target:     numCol(row,'一般營收_目標','一般目標'),
        general_last_year:  numCol(row,'一般營收_去年','一般去年'),
        extended_target:    numCol(row,'延保營收_目標','延保目標'),
        extended_last_year: numCol(row,'延保營收_去年','延保去年'),
      });
    }
    if (!entries.length) return res.status(400).json({ error: '找不到有效資料列，請確認欄位名稱與格式' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of entries) {
        await client.query(`
          INSERT INTO revenue_targets (branch,period,paid_target,paid_last_year,bodywork_target,bodywork_last_year,general_target,general_last_year,extended_target,extended_last_year,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (branch,period) DO UPDATE SET
            paid_target=$3,paid_last_year=$4,bodywork_target=$5,bodywork_last_year=$6,
            general_target=$7,general_last_year=$8,extended_target=$9,extended_last_year=$10,updated_at=NOW()
        `, [e.branch,e.period,e.paid_target,e.paid_last_year,e.bodywork_target,e.bodywork_last_year,e.general_target,e.general_last_year,e.extended_target,e.extended_last_year]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, count: entries.length, entries });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 解析「橫式分區」原生目標 Excel（每月各據點，K 為單位）
app.post('/api/upload-revenue-targets-native', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const year = String(req.body.year || '').trim();
  const dataType = String(req.body.dataType || 'target').trim(); // 'target' or 'last_year'
  if (!year.match(/^\d{4}$/)) return res.status(400).json({ error: '請指定正確的年份（4位數）' });
  const suffix = dataType === 'last_year' ? '_last_year' : '_target';
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, cellNF: true, cellText: false });
    // 嘗試找含目標資料的工作表（優先找含關鍵字的）
    const SHEET_KWS = ['目標','年度','營收','實績'];
    let sheetName = workbook.SheetNames[0];
    for (const sn of workbook.SheetNames) {
      if (SHEET_KWS.some(kw => sn.includes(kw))) { sheetName = sn; break; }
    }
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });

    const BRANCHES = ['AMA','AMC','AMD'];
    const SECTION_MAP = [
      { kw: ['有效營收','有費營收','有費'], field: 'paid'     },
      { kw: ['鈑烤'],                      field: 'bodywork'  },
      { kw: ['一般營收','一般'],            field: 'general'   },
      { kw: ['延保'],                       field: 'extended'  },
    ];

    // 月份識別：支援「1月」「2月」文字、純數字1-12、「Jan」等多種格式
    const toMonthIndex = (cell) => {
      const s = String(cell ?? '').trim();
      // 「1月」～「12月」
      const m1 = s.match(/^([1-9]|1[0-2])月$/);
      if (m1) return parseInt(m1[1]);
      // 純數字 1-12（需排除大數字以免誤判）
      const m2 = s.match(/^([1-9]|1[0-2])$/);
      if (m2) return parseInt(m2[1]);
      // 數字型態
      if (typeof cell === 'number' && cell >= 1 && cell <= 12 && Number.isInteger(cell)) return cell;
      return -1;
    };

    const data = {};
    let curField = null;
    let monthColIdx = {}; // { month_1based: col_index }
    const debugRows = [];

    for (let ri = 0; ri < raw.length; ri++) {
      const row = raw[ri];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
      const rowStr = row.map(c => String(c ?? '')).join('|');

      // 偵測區塊標題（不能同時是月份 header 行）
      for (const sm of SECTION_MAP) {
        if (sm.kw.some(kw => rowStr.includes(kw))) {
          // 排除：這行本身就是月份 header 行
          const hasMonths = row.filter(c => toMonthIndex(c) > 0).length;
          if (hasMonths < 3) {
            curField = sm.field;
            monthColIdx = {};
            if (!data[curField]) data[curField] = {};
            break;
          }
        }
      }

      // 偵測月份 header 行（含 6 個以上月份數值）
      const monthCells = row.map((c, ci) => ({ mo: toMonthIndex(c), ci })).filter(x => x.mo > 0);
      if (monthCells.length >= 6) {
        monthColIdx = {};
        monthCells.forEach(({ mo, ci }) => { monthColIdx[mo] = ci; });
        continue;
      }

      if (!curField || Object.keys(monthColIdx).length === 0) continue;

      // 偵測據點資料行
      const branchRaw = String(row[0] ?? row[1] ?? '').trim().toUpperCase();
      const matchedBranch = BRANCHES.find(b => branchRaw === b || branchRaw.endsWith(b));
      if (!matchedBranch) continue;

      if (!data[curField][matchedBranch]) data[curField][matchedBranch] = {};
      for (const [mo, ci] of Object.entries(monthColIdx)) {
        const raw_v = row[ci];
        const v = parseFloat(String(raw_v ?? '').replace(/,/g, ''));
        if (!isNaN(v) && v > 0) data[curField][matchedBranch][parseInt(mo)] = v;
      }
    }
    const entriesMap = {};
    for (const [field, branchData] of Object.entries(data)) {
      for (const [branch, monthData] of Object.entries(branchData)) {
        for (const [mo, valK] of Object.entries(monthData)) {
          const period = `${year}${String(mo).padStart(2,'0')}`;
          const key = `${branch}_${period}`;
          if (!entriesMap[key]) entriesMap[key] = { branch, period };
          entriesMap[key][`${field}${suffix}`] = Math.round(valK); // 值已是元，不乘1000
        }
      }
    }
    const entries = Object.values(entriesMap);
    if (!entries.length) {
      // 診斷：回傳偵測到的欄位資訊協助排錯
      const detected = Object.keys(data);
      const branchesFound = detected.length > 0
        ? Object.keys(data[detected[0]] || {})
        : [];
      return res.status(400).json({
        error: `找不到有效資料。已識別區塊：${detected.length ? detected.join('/') : '無'}；找到據點：${branchesFound.length ? branchesFound.join('/') : '無'}。請確認格式（AMA/AMC/AMD 及月份欄 1月～12月 或數字 1～12）`,
        debug: { detectedFields: detected, sheetName, totalRows: raw.length }
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of entries) {
        if (dataType === 'last_year') {
          await client.query(`
            INSERT INTO revenue_targets (branch,period,paid_last_year,bodywork_last_year,general_last_year,extended_last_year,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,NOW())
            ON CONFLICT (branch,period) DO UPDATE SET
              paid_last_year    = COALESCE($3, revenue_targets.paid_last_year),
              bodywork_last_year= COALESCE($4, revenue_targets.bodywork_last_year),
              general_last_year = COALESCE($5, revenue_targets.general_last_year),
              extended_last_year= COALESCE($6, revenue_targets.extended_last_year),
              updated_at=NOW()
          `, [e.branch, e.period, e.paid_last_year||null, e.bodywork_last_year||null, e.general_last_year||null, e.extended_last_year||null]);
        } else {
          await client.query(`
            INSERT INTO revenue_targets (branch,period,paid_target,bodywork_target,general_target,extended_target,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,NOW())
            ON CONFLICT (branch,period) DO UPDATE SET
              paid_target    = COALESCE($3, revenue_targets.paid_target),
              bodywork_target= COALESCE($4, revenue_targets.bodywork_target),
              general_target = COALESCE($5, revenue_targets.general_target),
              extended_target= COALESCE($6, revenue_targets.extended_target),
              updated_at=NOW()
          `, [e.branch, e.period, e.paid_target||null, e.bodywork_target||null, e.general_target||null, e.extended_target||null]);
        }
      }
      await client.query('COMMIT');
      const summary = {};
      entries.forEach(e => { if (!summary[e.period]) summary[e.period] = []; summary[e.period].push(e.branch); });
      const FIELD_LABEL = { paid:'有費營收', bodywork:'鈑烤營收', general:'一般營收', extended:'延保營收' };
      res.json({ ok:true, count:entries.length, year, dataType, summary, fields:Object.keys(data).map(f=>FIELD_LABEL[f]||f) });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 業績預估 API
// ============================================================
app.get('/api/revenue-estimates', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(`SELECT * FROM revenue_estimates ${where} ORDER BY branch`, params)).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/revenue-estimates/batch', async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: '無資料' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (!e.branch || !e.period) continue;
      await client.query(`
        INSERT INTO revenue_estimates (branch,period,paid_estimate,bodywork_estimate,general_estimate,extended_estimate,note,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (branch,period) DO UPDATE SET
          paid_estimate=$3, bodywork_estimate=$4, general_estimate=$5,
          extended_estimate=$6, note=$7, updated_at=NOW()
      `, [e.branch, e.period,
          e.paid_estimate||null, e.bodywork_estimate||null,
          e.general_estimate||null, e.extended_estimate||null,
          e.note||'']);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// ============================================================
// 收入明細分解 API
// ============================================================
app.get('/api/stats/income-breakdown', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const branchCond = branch ? ` AND branch=$${idx++}` : '';
    if (branch) params.push(branch);

    // ── 維修收入：各帳類 + 鈑烤判斷 ──
    const riRes = await pool.query(`
      SELECT
        branch,
        account_type,
        SUM(total_untaxed)  AS total,
        SUM(CASE WHEN COALESCE(bodywork_income,0) > 0 OR COALESCE(paint_income,0) > 0
                 THEN total_untaxed ELSE 0 END) AS with_bodywork,
        SUM(CASE WHEN COALESCE(bodywork_income,0) = 0 AND COALESCE(paint_income,0) = 0
                 THEN total_untaxed ELSE 0 END) AS without_bodywork
      FROM repair_income
      WHERE period=$1${branchCond}
      GROUP BY branch, account_type
    `, params);

    // ── 外賣收入（零件銷售） ──
    const cfgRow = await pool.query(`SELECT config_value FROM income_config WHERE config_key='external_sales_category'`);
    const externalCategory = cfgRow.rows[0]?.config_value || '外賣';
    const extParams = [period, externalCategory]; let eidx = 3;
    const extBranchCond = branch ? ` AND branch=$${eidx++}` : '';
    if (branch) extParams.push(branch);
    const extRes = await pool.query(`
      SELECT branch, SUM(sale_price_untaxed) AS ext_sales
      FROM parts_sales
      WHERE period=$1 AND category=$2${extBranchCond}
      GROUP BY branch
    `, extParams);
    const extMap = {};
    extRes.rows.forEach(r => { extMap[r.branch] = parseFloat(r.ext_sales || 0); });

    // ── 彙整各據點 ──
    const BRANCHES = branch ? [branch] : ['AMA','AMC','AMD'];
    const result = {};

    BRANCHES.forEach(br => {
      const rows = riRes.rows.filter(r => r.branch === br);
      const byType = {};
      rows.forEach(r => { byType[r.account_type] = r; });

      // 輔助：找帳類（模糊比對）
      const findType = (kw) => rows.find(r => r.account_type?.includes(kw));
      const sumType  = (kw) => parseFloat(findType(kw)?.total || 0);

      const ins     = findType('保險');
      const gen     = findType('一般');
      const ext_row = findType('延保');
      const vou     = findType('票');

      const bodywork_insurance = parseFloat(ins?.total || 0);        // 保險帳類全部視為鈑烤
      const bodywork_self      = parseFloat(gen?.with_bodywork || 0); // 一般帳類中含鈑金/烤漆的工單
      const bodywork_total     = bodywork_insurance + bodywork_self;

      const extended           = parseFloat(ext_row?.total || 0);
      const general_no_bw      = parseFloat(gen?.without_bodywork || 0); // 一般去掉鈑烤工單
      const voucher            = parseFloat(vou?.total || 0);
      const external           = extMap[br] || 0;

      // 一般營收 = 一般(非鈑烤) + 票劵 + 外賣
      const general_total = general_no_bw + voucher + external;

      // 有費營收 = 一般營收 + 保險鈑烤 + 延保
      const paid_total = general_total + bodywork_insurance + extended;

      // 其他帳類（內結/保固/VSA/善意）
      const OTHER_KWS = ['內結','保固','VSA','vsa','善意'];
      const other_rows = rows.filter(r => OTHER_KWS.some(k => r.account_type?.toLowerCase().includes(k.toLowerCase())));
      const other_total = other_rows.reduce((s, r) => s + parseFloat(r.total || 0), 0);

      // 全部營收 = paid_total + 其他帳類（外賣已含在 general_total）
      const all_total = paid_total + other_total;

      result[br] = {
        bodywork_self,
        bodywork_insurance,
        bodywork_total,
        extended,
        general_no_bw,
        voucher,
        external,
        general_total,
        paid_total,
        other_total,
        all_total,
        // 細節（其他帳類明細）
        other_detail: other_rows.map(r => ({ account_type: r.account_type, total: parseFloat(r.total || 0) })),
      };
    });

    res.json({ branches: result, externalCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 解析「橫式分區」零配精品銷售目標 Excel
app.post('/api/upload-performance-targets-native', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const year = String(req.body.year || '').trim();
  const dataType = String(req.body.dataType || 'target').trim();
  if (!year.match(/^\d{4}$/)) return res.status(400).json({ error: '請指定正確的年份' });
  const valueField = dataType === 'last_year' ? 'last_year_value' : 'target_value';

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, cellNF: true, cellText: false });
    const SHEET_KWS = ['目標','年度','銷售','實績'];
    let sheetName = workbook.SheetNames[0];
    for (const sn of workbook.SheetNames) {
      if (SHEET_KWS.some(kw => sn.includes(kw))) { sheetName = sn; break; }
    }
    const sheet = workbook.Sheets[sheetName];

    // 讀取時保留格式資訊
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });

    const BRANCHES = ['AMA','AMC','AMD'];
    const toMonthIndex = (cell) => {
      if (typeof cell === 'number' && cell >= 1 && cell <= 12 && Number.isInteger(cell)) return cell;
      const s = String(cell ?? '').trim();
      const m = s.match(/^([1-9]|1[0-2])月?$/);
      return m ? parseInt(m[1]) : -1;
    };

    // 區塊標題 → 清理出指標名稱
    const cleanTitle = (title) => {
      return String(title)
        .replace(/銷售目標|目標|銷售|（k）|\(k\)|\(K\)|\（K\）/gi, '')
        .replace(/\s+/g, '').trim();
    };

    // 偵測儲存格格式是否為「K顯示」（trailing comma pattern）
    const isKFormat = (cell) => {
      if (!cell) return false;
      const addr = cell.toString();
      const c = sheet[addr];
      if (!c) return false;
      const fmt = c.z || '';
      // trailing comma pattern in number format = divide by 1000 for display
      return /,[ _]/.test(fmt) || fmt.endsWith(',');
    };

    // 取得 sheet 中某行某列的格式
    const getCellFormat = (rowIdx, colIdx) => {
      const cols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const col = colIdx < 26 ? cols[colIdx] : 'A' + cols[colIdx - 26];
      const addr = `${col}${rowIdx + 1}`;
      const c = sheet[addr];
      return c ? (c.z || '') : '';
    };

    const data = {}; // { metricName: { isK, branches: { branch: { month: value } } } }
    let curName = null;
    let curIsK = false;
    let monthColIdx = {};

    for (let ri = 0; ri < raw.length; ri++) {
      const row = raw[ri];
      if (!row || row.every(c => c === '' || c === null)) continue;
      const rowStr = row.map(c => String(c ?? '')).join('|');

      // 偵測月份 header 行
      const monthCells = row.map((c, ci) => ({ mo: toMonthIndex(c), ci })).filter(x => x.mo > 0);
      if (monthCells.length >= 6) {
        monthColIdx = {};
        monthCells.forEach(({ mo, ci }) => { monthColIdx[mo] = ci; });
        continue;
      }

      // 偵測區塊標題
      const firstCell = row[0];
      if (firstCell && typeof firstCell === 'string' && row[1] === '' && row[2] === '') {
        const cleaned = cleanTitle(firstCell);
        if (cleaned.length >= 2) {
          curName = cleaned;
          curIsK = firstCell.toLowerCase().includes('(k)') || firstCell.includes('（k）') || firstCell.includes('（K）');
          monthColIdx = {};
          if (!data[curName]) data[curName] = { isK: curIsK, branches: {} };
          continue;
        }
      }

      if (!curName || Object.keys(monthColIdx).length === 0) continue;

      // 據點資料行
      const branchRaw = String(row[0] ?? '').trim().toUpperCase();
      const matchedBranch = BRANCHES.find(b => branchRaw === b || branchRaw.endsWith(b));
      if (!matchedBranch) continue;

      // 偵測第一個資料欄的格式，判斷是否為K格式
      const firstDataCol = Object.values(monthColIdx)[0];
      const fmt = getCellFormat(ri, firstDataCol);
      const isKByFmt = /,[ _]/.test(fmt) || /,\)/.test(fmt) || fmt.endsWith(',');
      data[curName].isK = curIsK || isKByFmt;

      if (!data[curName].branches[matchedBranch]) data[curName].branches[matchedBranch] = {};
      for (const [mo, ci] of Object.entries(monthColIdx)) {
        const v = parseFloat(String(row[ci] ?? '').replace(/,/g, ''));
        if (!isNaN(v) && v > 0) data[curName].branches[matchedBranch][parseInt(mo)] = v;
      }
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: '找不到任何區塊資料，請確認格式（需有標題列＋月份列＋AMA/AMC/AMD資料列）' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 載入所有 SA 銷售設定，用來比對名稱複製篩選條件
      const saConfigs = (await client.query(`SELECT config_name, filters, stat_method FROM sa_sales_config`)).rows;
      const findSaConfig = (metricName) => {
        // 完整比對
        let match = saConfigs.find(c => c.config_name === metricName);
        if (match) return match;
        // 包含比對（SA名稱包含指標名稱，或指標名稱包含SA名稱）
        match = saConfigs.find(c =>
          c.config_name.includes(metricName) || metricName.includes(c.config_name)
        );
        return match || null;
      };

      // 自動建立不存在的指標（優先從 SA 設定複製篩選條件）
      const createdMetrics = [];
      const createdFromSA = [];
      const metricIdMap = {};
      for (const [name] of Object.entries(data)) {
        const existing = await client.query(
          `SELECT id FROM performance_metrics WHERE metric_name=$1`, [name]
        );
        if (existing.rows.length) {
          metricIdMap[name] = existing.rows[0].id;
        } else {
          // 嘗試從 SA 設定複製篩選條件
          const saMatch = findSaConfig(name);
          const filters = saMatch ? JSON.stringify(saMatch.filters) : '[]';
          const statField = saMatch
            ? (saMatch.stat_method === 'quantity' ? 'qty' : saMatch.stat_method === 'count' ? 'count' : 'amount')
            : 'amount';
          const ins = await client.query(
            `INSERT INTO performance_metrics (metric_name, description, metric_type, filters, stat_field, unit)
             VALUES ($1, '', 'parts', $2, $3, '') RETURNING id`,
            [name, filters, statField]
          );
          metricIdMap[name] = ins.rows[0].id;
          createdMetrics.push(name);
          if (saMatch) createdFromSA.push({ name, saName: saMatch.config_name });
        }
      }

      // 寫入目標
      let count = 0;
      for (const [name, info] of Object.entries(data)) {
        const metricId = metricIdMap[name];
        for (const [branch, monthData] of Object.entries(info.branches)) {
          for (const [mo, val] of Object.entries(monthData)) {
            const period = `${year}${String(mo).padStart(2,'0')}`;
            // K格式的值需 ×1000 換算成元
            const storedVal = info.isK ? Math.round(val * 1000) : Math.round(val);
            await client.query(`
              INSERT INTO performance_targets (metric_id,branch,period,${valueField},updated_at)
              VALUES ($1,$2,$3,$4,NOW())
              ON CONFLICT (metric_id,branch,period) DO UPDATE SET ${valueField}=$4, updated_at=NOW()
            `, [metricId, branch, period, storedVal]);
            count++;
          }
        }
      }

      await client.query('COMMIT');
      res.json({
        ok: true, count, year, dataType,
        metrics: Object.keys(data).map(n => ({ name: n, isK: data[n].isK })),
        created: createdMetrics,
        createdFromSA,
        existing: Object.keys(data).filter(n => !createdMetrics.includes(n)),
      });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 業績統計 API
// ============================================================
app.get('/api/stats/performance', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const metrics = (await pool.query(`SELECT * FROM performance_metrics ORDER BY sort_order, id`)).rows;
    if (!metrics.length) return res.json({ metrics: [], results: [] });

    const BRANCHES = branch ? [branch] : ['AMA','AMC','AMD'];
    const tRes = await pool.query(
      `SELECT * FROM performance_targets WHERE period=$1${branch ? ' AND branch=$2' : ''}`,
      branch ? [period, branch] : [period]
    );
    const tMap = {};
    tRes.rows.forEach(t => { tMap[`${t.metric_id}|||${t.branch}`] = t; });

    const results = [];
    for (const metric of metrics) {
      const filters = metric.filters || [];
      const mr = { metric_id: metric.id, branches: {} };

      for (const br of BRANCHES) {
        let actual = 0;
        try {
          if (metric.metric_type === 'repair_income') {
            // 維修收入：sum(total_untaxed)，可篩帳類
            const acTypes = filters.filter(f => f.type === 'account_type').map(f => f.value);
            const q = acTypes.length
              ? `SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE period=$1 AND branch=$2 AND account_type=ANY($3)`
              : `SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE period=$1 AND branch=$2`;
            actual = parseFloat((await pool.query(q, acTypes.length ? [period, br, acTypes] : [period, br])).rows[0]?.v || 0);

          } else if (metric.metric_type === 'parts') {
            // 零件銷售：依篩選條件
            const cc = filters.filter(f=>f.type==='category_code').map(f=>f.value);
            const fc = filters.filter(f=>f.type==='function_code').map(f=>f.value);
            const pn = filters.filter(f=>f.type==='part_number').map(f=>f.value);
            const pt = filters.filter(f=>f.type==='part_type').map(f=>f.value);
            const c = [`period=$1`,`branch=$2`]; const p = [period, br]; let i = 3;
            if (cc.length) { c.push(`category_code=ANY($${i++})`); p.push(cc); }
            if (fc.length) { c.push(`function_code=ANY($${i++})`); p.push(fc); }
            if (pn.length) { c.push(`part_number=ANY($${i++})`);   p.push(pn); }
            if (pt.length) { c.push(`part_type=ANY($${i++})`);     p.push(pt); }
            const fld = metric.stat_field === 'qty'   ? 'SUM(sale_qty)'
                      : metric.stat_field === 'count' ? 'COUNT(*)'
                      : 'SUM(sale_price_untaxed)';
            actual = parseFloat((await pool.query(
              `SELECT COALESCE(${fld},0) as v FROM parts_sales WHERE ${c.join(' AND ')}`, p
            )).rows[0]?.v || 0);

          } else if (metric.metric_type === 'boutique') {
            // 精品/配件：JOIN parts_catalog，可篩品項類型及帳類
            const bt = filters.filter(f=>f.type==='boutique_type').map(f=>f.value);
            const ac = filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const c = [`ps.period=$1`,`ps.branch=$2`]; const p = [period, br]; let i = 3;
            if (bt.length) { c.push(`pc.part_type=ANY($${i++})`); p.push(bt); }
            else            { c.push(`pc.part_type IN ('精品','配件')`); }
            if (ac.length) { c.push(`ps.part_type=ANY($${i++})`); p.push(ac); }
            actual = parseFloat((await pool.query(
              `SELECT COALESCE(SUM(ps.sale_price_untaxed),0) as v
               FROM parts_sales ps JOIN parts_catalog pc ON ps.part_number=pc.part_number
               WHERE ${c.join(' AND ')}`, p
            )).rows[0]?.v || 0);

          } else if (metric.metric_type === 'repair_subfield') {
            // 維修收入子欄位，三種模式：
            //   sum      : SUM(col1+col2+...) — 直接加總子欄位數值
            //   wo_has   : 找出 col1>0 OR col2>0 的工單，SUM(total_untaxed) — 自費鈑烤
            //   wo_exclude: 找出 col1=0 AND col2=0 的工單，SUM(total_untaxed) — 一般扣鈑烤
            const VALID_COLS = new Set([
              'bodywork_income','paint_income','engine_wage','parts_income',
              'accessories_income','boutique_income','carwash_income',
              'outsource_income','addon_income','total_untaxed','parts_cost'
            ]);
            const acTypes  = filters.filter(f => f.type === 'account_type').map(f => f.value);
            const subfields = filters.filter(f => f.type === 'subfield' && VALID_COLS.has(f.value)).map(f => f.value);
            const woMode   = filters.find(f => f.type === 'wo_mode')?.value || 'sum';
            if (!subfields.length) {
              actual = 0;
            } else {
              const p = [period, br]; let i = 3;
              let where = 'period=$1 AND branch=$2';
              if (acTypes.length) { where += ` AND account_type=ANY($${i++})`; p.push(acTypes); }
              let q;
              if (woMode === 'wo_has') {
                // 含鈑金/烤漆的工單 → 加總整張工單金額（自費鈑烤）
                const hasCond = subfields.map(c => `COALESCE(${c},0) > 0`).join(' OR ');
                q = `SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE ${where} AND (${hasCond})`;
              } else if (woMode === 'wo_exclude') {
                // 不含鈑金/烤漆的工單 → 加總整張工單金額（一般收入扣鈑烤）
                const excCond = subfields.map(c => `COALESCE(${c},0) = 0`).join(' AND ');
                q = `SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE ${where} AND (${excCond})`;
              } else {
                // 直接加總子欄位數值
                const sumExpr = subfields.map(c => `COALESCE(${c},0)`).join(' + ');
                q = `SELECT COALESCE(SUM(${sumExpr}),0) as v FROM repair_income WHERE ${where}`;
              }
              actual = parseFloat((await pool.query(q, p)).rows[0]?.v || 0);
            }
          }
        } catch(e) { actual = 0; }

        const t  = tMap[`${metric.id}|||${br}`] || {};
        const tv = parseFloat(t.target_value    || 0);
        const ly = parseFloat(t.last_year_value || 0);
        mr.branches[br] = {
          actual,
          target:       tv || null,
          last_year:    ly || null,
          achieve_rate: tv > 0 ? (actual / tv * 100) : null,
          yoy_growth:   ly > 0 ? ((actual - ly) / ly * 100) : null,
        };
      }
      results.push(mr);
    }
    res.json({ metrics, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 密碼驗證 API
// ============================================================
const crypto = require('crypto');
const SESSION_TOKENS = new Set();
async function getSettingsPassword() {
  const r = await pool.query("SELECT value FROM app_settings WHERE key='settings_password'");
  return r.rows[0]?.value || 'admin1234';
}
app.post('/api/auth/settings', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error:'請輸入密碼' });
  if (password !== await getSettingsPassword()) return res.status(401).json({ error:'密碼錯誤' });
  const token = crypto.randomBytes(24).toString('hex');
  SESSION_TOKENS.add(token);
  setTimeout(() => SESSION_TOKENS.delete(token), 8*60*60*1000);
  res.json({ token });
});
app.get('/api/auth/settings/check', (req, res) => res.json({ valid: !!(req.query.token && SESSION_TOKENS.has(req.query.token)) }));
app.put('/api/auth/settings/password', async (req, res) => {
  const { token, currentPassword, newPassword } = req.body;
  if (!token||!SESSION_TOKENS.has(token)) return res.status(401).json({ error:'未驗證，請重新登入' });
  if (!newPassword||newPassword.length<4) return res.status(400).json({ error:'新密碼至少需要 4 個字元' });
  if (currentPassword !== await getSettingsPassword()) return res.status(401).json({ error:'目前密碼不正確' });
  await pool.query("UPDATE app_settings SET value=$1 WHERE key='settings_password'",[newPassword]);
  SESSION_TOKENS.clear();
  res.json({ ok:true });
});

// ============================================================
// 啟動
// ============================================================
initDatabase()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => { console.error('DB初始化失敗:', err.message); process.exit(1); });
