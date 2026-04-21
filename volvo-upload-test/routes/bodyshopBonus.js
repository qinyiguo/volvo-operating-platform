/**
 * routes/bodyshopBonus.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 業務鈑烤取送獎金:申請 → 比對 DMS 資料 → 結算。
 *
 * 申請階段:
 *   GET  /bodyshop-bonus/settings              bonus_rate / 公式設定
 *   PUT  /bodyshop-bonus/settings              (feature:bonus_edit)
 *   POST /bodyshop-bonus/upload                (feature:upload) 申請 Excel
 *   POST /bodyshop-bonus/match                 (feature:bonus_edit)
 *     依車牌比對 repair_income，自動填入結算期 / 金額 / 獎金。
 *   POST /bodyshop-bonus/reset-match           (feature:bonus_edit)
 *
 * 檢視 / 維護:
 *   GET  /bodyshop-bonus/applications          申請列表
 *   GET  /bodyshop-bonus/summary               各期各申請人彙總
 *   GET  /bodyshop-bonus/pending               pending 清單
 *   GET  /bodyshop-bonus/periods               已有資料的期間
 *   PATCH /bodyshop-bonus/applications/:id/rate  (feature:bonus_edit)
 *   PATCH /bodyshop-bonus/applications/:id/note  (feature:bonus_edit)
 *   DELETE /bodyshop-bonus/applications/:id      (feature:bonus_edit)
 */
const router = require('express').Router();
const multer = require('multer');
const XLSX   = require('xlsx');
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

router.use(requireAuth);

const { checkPeriodLock } = require('../lib/bonusPeriodLock');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ══ 正規化車牌 ══
function normalizePlate(raw) {
  if (!raw) return '';
  return String(raw).replace(/[\s\-]/g, '').toUpperCase().trim();
}

// ══ 廠別名稱 → branch 代碼 ══
function factoryToBranch(factoryStr) {
  const s = String(factoryStr || '');
  if (s.includes('士林') || s.includes('AMD')) return 'AMD';
  if (s.includes('仁愛') || s.includes('AMC')) return 'AMC';
  if (s.includes('內湖') || s.includes('AMA')) return 'AMA';
  return null;
}

// ══ 初始化 DB Table ══
async function initTable() {
  try {
    // 主表（一列 = 一筆申請表單）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bodyshop_bonus_applications (
        id               SERIAL PRIMARY KEY,
        app_period       VARCHAR(6)   NOT NULL,
        apply_date       DATE,
        applicant_name   VARCHAR(50),
        emp_id           VARCHAR(30),
        dept_name        VARCHAR(100),
        plate_no_raw     VARCHAR(30),
        plate_no_norm    VARCHAR(20),
        factory_raw      VARCHAR(30),
        branch           VARCHAR(10),
        -- 匹配結果（主列保留整體狀態）
        status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
        work_order       VARCHAR(50),
        repair_type      VARCHAR(50),
        settle_date      DATE,
        income_total     NUMERIC(12,2),
        bonus_rate       NUMERIC(5,4) DEFAULT 0.02,
        bonus_amount     NUMERIC(12,2),
        settled_period   VARCHAR(6),
        note             TEXT DEFAULT '',
        upload_batch     VARCHAR(50),
        -- ★ 一對多：子列指向原始申請，NULL = 原始列
        source_app_id    INTEGER REFERENCES bodyshop_bonus_applications(id) ON DELETE CASCADE,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_period       ON bodyshop_bonus_applications(app_period)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_plate        ON bodyshop_bonus_applications(plate_no_norm)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_status       ON bodyshop_bonus_applications(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_settle       ON bodyshop_bonus_applications(settle_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_source       ON bodyshop_bonus_applications(source_app_id)`);

    // 補欄位（升級舊資料庫用，各自獨立 try-catch 避免一個失敗影響其他）
    try { await pool.query(`ALTER TABLE bodyshop_bonus_applications ADD COLUMN IF NOT EXISTS upload_batch VARCHAR(50)`); } catch(e) {}
    // source_app_id：先加欄位，再加外鍵（自我參照 FK 需分兩步）
    try { await pool.query(`ALTER TABLE bodyshop_bonus_applications ADD COLUMN IF NOT EXISTS source_app_id INTEGER`); } catch(e) {}
    try {
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_bba_source_app') THEN
            ALTER TABLE bodyshop_bonus_applications
              ADD CONSTRAINT fk_bba_source_app
              FOREIGN KEY (source_app_id)
              REFERENCES bodyshop_bonus_applications(id)
              ON DELETE CASCADE;
          END IF;
        END$$
      `);
    } catch(e) { console.warn('[initTable] FK source_app_id:', e.message); }

    // app_settings
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  } catch(e) {
    console.error('[bodyshopBonus initTable]', e.message);
  }
}
initTable();

// ══ 讀取/儲存設定 ══
router.get('/bodyshop-bonus/settings', async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key='bodyshop_bonus_settings'`);
    const defaults = { lookback_days: 30, rate_a: 2, rate_b: 4 };
    res.json(r.rows[0] ? { ...defaults, ...JSON.parse(r.rows[0].value) } : defaults);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/bodyshop-bonus/settings', requirePermission('feature:bodyshop_bonus_edit'), async (req, res) => {
  const { lookback_days, rate_a, rate_b } = req.body;
  const val = JSON.stringify({
    // ★ 0 是合法值，不能用 || 30
    lookback_days: (lookback_days === '' || lookback_days == null) ? 30 : Math.max(0, parseInt(lookback_days) || 0),
    rate_a:        parseFloat(rate_a)  || 2,
    rate_b:        parseFloat(rate_b)  || 4,
  });
  try {
    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES ('bodyshop_bonus_settings', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [val]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 解析 Google Form Excel ══
function parseFormExcel(buffer) {
  const wb  = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  let headerIdx = 0;
  for (let i = 0; i < Math.min(raw.length, 5); i++) {
    if (raw[i].some(c => String(c).includes('申請日期') || String(c).includes('車牌'))) {
      headerIdx = i; break;
    }
  }

  const headers = raw[headerIdx].map(c => String(c || '').trim());
  const col = name => headers.findIndex(h => h.includes(name));

  const fmtDate = v => {
    if (!v) return null;
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
    }
    const s = String(v).trim();
    const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : null;
  };

  const rows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const plateRaw = String(r[col('車牌')] || '').trim();
    if (!plateRaw) continue;

    const applyDateStr = fmtDate(r[col('申請日期')]);
    const factoryRaw   = String(r[col('廠別')] || r[col('進廠')] || '').trim();
    const empId        = String(r[col('員編')] || r[col('員工')] || '').replace(/[^\d]/g, '').trim();
    const name         = String(r[col('姓名')] || '').trim();
    const dept         = String(r[col('申請部門')] || r[col('部門')] || '').trim();

    let appPeriod = '';
    if (applyDateStr) appPeriod = applyDateStr.slice(0,4) + applyDateStr.slice(5,7);

    rows.push({
      app_period:     appPeriod,
      apply_date:     applyDateStr,
      applicant_name: name,
      emp_id:         empId || String(r[col('員編')] || '').trim(),
      dept_name:      dept,
      plate_no_raw:   plateRaw,
      plate_no_norm:  normalizePlate(plateRaw),
      factory_raw:    factoryRaw,
      branch:         factoryToBranch(factoryRaw),
    });
  }
  return rows;
}

// ══ 上傳 Google Form Excel ══
router.post('/bodyshop-bonus/upload', requirePermission('feature:upload_bodyshop'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const batchId = `batch_${Date.now()}`;
  try {
    const rows = parseFormExcel(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: '找不到有效資料' });
    // 鎖定檢查：鈑烤申請屬於原始資料 → 走上傳鎖（次月第一工作日 17:59）
    const { isUploadPeriodLocked, uploadPeriodLockAt } = require('../lib/bonusPeriodLock');
    const lockedRow = req.user?.role === 'super_admin' ? null
      : rows.find(function(r){ return r.app_period && isUploadPeriodLocked(r.app_period); });
    if (lockedRow) {
      const lockAt = uploadPeriodLockAt(lockedRow.app_period);
      return res.status(403).json({
        error: '上傳檔案包含已鎖定期間（' + lockedRow.app_period + '）的申請，無法匯入',
        locked: true,
        lock_at: lockAt && lockAt.toISOString(),
        lock_type: 'upload',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let inserted = 0, skipped = 0;

      for (const r of rows) {
        if (!r.plate_no_norm || !r.app_period) { skipped++; continue; }

        // 避免重複（同車牌+申請日期+申請人），且只比對原始列（source_app_id IS NULL）
        const dup = await client.query(
          `SELECT id FROM bodyshop_bonus_applications
           WHERE plate_no_norm=$1 AND apply_date=$2 AND applicant_name=$3 AND source_app_id IS NULL`,
          [r.plate_no_norm, r.apply_date, r.applicant_name]
        );
        if (dup.rows.length) { skipped++; continue; }

        await client.query(`
          INSERT INTO bodyshop_bonus_applications
            (app_period, apply_date, applicant_name, emp_id, dept_name,
             plate_no_raw, plate_no_norm, factory_raw, branch, status, upload_batch)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
        `, [r.app_period, r.apply_date, r.applicant_name, r.emp_id, r.dept_name,
            r.plate_no_raw, r.plate_no_norm, r.factory_raw, r.branch, batchId]);
        inserted++;
      }

      await client.query('COMMIT');
      res.json({ ok: true, inserted, skipped, total: rows.length, batchId });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 執行匹配（一張申請 → 多張工單，每張工單獨立一列）══
router.post('/bodyshop-bonus/match', requirePermission('feature:bodyshop_bonus_edit'), async (req, res) => {
  const { period } = req.body;
  if (!period) return res.status(400).json({ error: 'period 為必填' });

  try {
    // 讀設定
    const cfgR = await pool.query(`SELECT value FROM app_settings WHERE key='bodyshop_bonus_settings'`);
    const cfg  = cfgR.rows[0] ? JSON.parse(cfgR.rows[0].value) : {};
    const lookbackDays = (cfg.lookback_days === '' || cfg.lookback_days == null) ? 30 : Math.max(0, parseInt(cfg.lookback_days) || 0);
    const defaultRateA = parseFloat(cfg.rate_a ?? 2) / 100;

    // 每次比對都重新處理所有原始申請列（含已結清），確保多張工單都能被抓到
    const appRows = (await pool.query(`
      SELECT * FROM bodyshop_bonus_applications
      WHERE source_app_id IS NULL
      ORDER BY apply_date ASC
    `)).rows;

    let totalApps = appRows.length;
    let matchedApps = 0, settledWOs = 0, notFoundApps = 0, totalWOs = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const app of appRows) {
        const plate  = app.plate_no_norm;
        const branch = app.branch;
        if (!plate) continue;

        // ── Step 1: 查 business_query，取得所有符合的工單 ──
        const bqConds  = [`UPPER(REPLACE(REPLACE(plate_no,' ',''),'-',''))=$1`];
        const bqParams = [plate];
        let idx = 2;

        if (branch) { bqConds.push(`branch=$${idx++}`); bqParams.push(branch); }

        // 時間範圍：申請日期後的工單全部納入 + 往前回溯 lookbackDays 天
        if (app.apply_date) {
          if (lookbackDays > 0) {
            // 申請日期往前 lookbackDays 天 ~ 未來（無上限）
            bqConds.push(`open_time >= ($${idx++}::date - interval '${lookbackDays} days')`);
          } else {
            // lookbackDays = 0：只抓申請日期當天及之後的工單
            bqConds.push(`open_time >= $${idx++}::date`);
          }
          bqParams.push(app.apply_date);
        }

        // 帳類：鈑烤/事故/保險
        bqConds.push(`(
          repair_type ILIKE '%鈑%' OR repair_type ILIKE '%噴%' OR
          repair_type ILIKE '%保險%' OR repair_type ILIKE '%事故%' OR
          repair_type ILIKE '%鈑烤%' OR repair_type ILIKE '%鈑金%'
        )`);

        // ★ 申請日期後的工單排前面，再依 open_time DESC；不限筆數（取全部）
        const orderClause = app.apply_date
          ? `ORDER BY (open_time >= $${idx++}::date) DESC, open_time DESC`
          : `ORDER BY open_time DESC`;
        if (app.apply_date) bqParams.push(app.apply_date);

        const bqRes = await client.query(
          `SELECT work_order, branch, repair_type, open_time
           FROM business_query WHERE ${bqConds.join(' AND ')} ${orderClause}`,
          bqParams
        );

        if (!bqRes.rows.length) {
          // 找不到任何工單
          await client.query(
            `UPDATE bodyshop_bonus_applications SET status='not_found', updated_at=NOW() WHERE id=$1`,
            [app.id]
          );
          notFoundApps++;
          continue;
        }

        matchedApps++;

        // ── Step 2: 對每張工單查 repair_income，各自計算獎金 ──
        // 先刪除此申請的舊子列（重新比對）
        await client.query(
          `DELETE FROM bodyshop_bonus_applications WHERE source_app_id=$1`,
          [app.id]
        );

        const woResults = [];
        for (const bq of bqRes.rows) {
          const riRes = await client.query(`
            SELECT work_order, branch, clear_date,
                   COALESCE(total_taxed, total_untaxed) AS income_total
            FROM repair_income
            WHERE work_order=$1 AND branch=$2 AND clear_date IS NOT NULL
            LIMIT 1
          `, [bq.work_order, bq.branch]);

          if (riRes.rows.length) {
            const ri = riRes.rows[0];
            const income = parseFloat(ri.income_total || 0);
            const rate   = parseFloat(app.bonus_rate || defaultRateA);
            const bonus  = Math.min(income * rate, 20000);

            // settled_period 依結清日期月份
            const sd = ri.clear_date instanceof Date ? ri.clear_date : new Date(ri.clear_date);
            const settledPeriod = sd.getFullYear() + String(sd.getMonth()+1).padStart(2,'0');

            woResults.push({
              status:         'settled',
              work_order:     bq.work_order,
              branch:         bq.branch,
              repair_type:    bq.repair_type,
              settle_date:    ri.clear_date,
              income_total:   income,
              bonus_rate:     rate,
              bonus_amount:   bonus,
              settled_period: settledPeriod,
            });
          } else {
            // 有工單但未結清
            woResults.push({
              status:      'matched_pending',
              work_order:  bq.work_order,
              branch:      bq.branch,
              repair_type: bq.repair_type,
              settle_date:  null,
              income_total: null,
              bonus_rate:   parseFloat(app.bonus_rate || defaultRateA),
              bonus_amount: null,
              settled_period: null,
            });
          }
        }

        totalWOs += woResults.length;

        if (woResults.length === 0) {
          // 不應發生，但保護性處理
          await client.query(
            `UPDATE bodyshop_bonus_applications SET status='not_found', updated_at=NOW() WHERE id=$1`,
            [app.id]
          );
          continue;
        }

        // 原始列用第一筆工單結果更新（作為代表狀態）
        const first = woResults[0];
        const overallStatus = woResults.some(w => w.status === 'settled')
          ? 'settled'
          : woResults.some(w => w.status === 'matched_pending')
            ? 'matched_pending'
            : 'not_found';

        await client.query(`
          UPDATE bodyshop_bonus_applications SET
            status=$1, work_order=$2, branch=$3, repair_type=$4,
            settle_date=$5, income_total=$6, bonus_rate=$7, bonus_amount=$8,
            settled_period=$9, updated_at=NOW()
          WHERE id=$10
        `, [first.status, first.work_order, first.branch, first.repair_type,
            first.settle_date, first.income_total, first.bonus_rate, first.bonus_amount,
            first.settled_period, app.id]);

        if (first.status === 'settled') settledWOs++;

        // 第 2 筆起：INSERT 子列
        for (let i = 1; i < woResults.length; i++) {
          const wo = woResults[i];
          await client.query(`
            INSERT INTO bodyshop_bonus_applications (
              app_period, apply_date, applicant_name, emp_id, dept_name,
              plate_no_raw, plate_no_norm, factory_raw, branch,
              status, work_order, repair_type, settle_date,
              income_total, bonus_rate, bonus_amount, settled_period,
              source_app_id, upload_batch
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          `, [
            app.app_period, app.apply_date, app.applicant_name, app.emp_id, app.dept_name,
            app.plate_no_raw, app.plate_no_norm, app.factory_raw, wo.branch,
            wo.status, wo.work_order, wo.repair_type, wo.settle_date,
            wo.income_total, wo.bonus_rate, wo.bonus_amount, wo.settled_period,
            app.id, app.upload_batch,
          ]);
          if (wo.status === 'settled') settledWOs++;
        }
      }

      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    res.json({ ok: true, total: totalApps, matched: matchedApps, settled: settledWOs, notFound: notFoundApps, work_orders: totalWOs, period });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 重置比對結果（清子列，原始列回 pending）══
router.post('/bodyshop-bonus/reset-match', requirePermission('feature:bodyshop_bonus_edit'), async (req, res) => {
  const { app_period, branch } = req.body;
  if (app_period && checkPeriodLock(app_period, res, req)) return;
  try {
    const conds  = [`source_app_id IS NULL`];
    const params = [];
    let idx = 1;
    if (app_period) { conds.push(`app_period=$${idx++}`); params.push(app_period); }
    if (branch)     { conds.push(`(branch=$${idx++} OR factory_raw ILIKE $${idx++})`); params.push(branch, '%'+branch+'%'); }

    // 子列依 CASCADE 自動刪除，只需重置原始列
    const r = await pool.query(`
      UPDATE bodyshop_bonus_applications SET
        status='pending',
        work_order=NULL, repair_type=NULL, settle_date=NULL,
        income_total=NULL, bonus_amount=NULL, settled_period=NULL,
        updated_at=NOW()
      WHERE ${conds.join(' AND ')}
      RETURNING id
    `, params);

    // 手動清子列（若 CASCADE 未生效）
    await pool.query(`
      DELETE FROM bodyshop_bonus_applications
      WHERE source_app_id IN (
        SELECT id FROM bodyshop_bonus_applications WHERE ${conds.join(' AND ')}
      )
    `, params);

    res.json({ ok: true, reset: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 查詢申請清單（含子列，每張工單一列）══
router.get('/bodyshop-bonus/applications', async (req, res) => {
  const { period, status, branch, page = 1, limit = 500 } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;

    // period 篩選：原始列用 app_period，子列繼承原始列的 app_period
    if (period) { conds.push(`app_period=$${idx++}`); params.push(period); }
    if (status) { conds.push(`status=$${idx++}`);     params.push(status); }
    if (branch) { conds.push(`branch=$${idx++}`);     params.push(branch); }

    const where  = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const offset = (parseInt(page)-1) * parseInt(limit);

    const r = await pool.query(
      `SELECT *,
        CASE WHEN source_app_id IS NULL THEN '原始' ELSE '追加' END AS row_type
       FROM bodyshop_bonus_applications ${where}
       ORDER BY applicant_name, plate_no_norm, apply_date DESC, id ASC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, parseInt(limit), offset]
    );
    const cnt = await pool.query(
      `SELECT COUNT(*) AS total FROM bodyshop_bonus_applications ${where}`, params
    );
    res.json({ rows: r.rows, total: parseInt(cnt.rows[0].total) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 獎金彙總：依結清日期月份（settle_date），含所有子列 ══
router.get('/bodyshop-bonus/summary', async (req, res) => {
  const { settled_period, branch } = req.query;
  if (!settled_period) return res.status(400).json({ error: 'settled_period 為必填' });
  try {
    const periodDate = `${settled_period.slice(0,4)}-${settled_period.slice(4,6)}-01`;

    const conds  = [
      `status='settled'`,
      `DATE_TRUNC('month', settle_date) = DATE_TRUNC('month', $1::date)`,
    ];
    const params = [periodDate];
    let idx = 2;
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }

    // 主查：每人彙總，包含原始列和子列（JOIN 取申請人資訊）
    const r = await pool.query(`
      SELECT
        applicant_name, emp_id, dept_name,
        branch,
        COUNT(*) AS work_order_count,
        SUM(income_total) AS total_income,
        SUM(bonus_amount) AS total_bonus,
        array_agg(plate_no_raw  ORDER BY settle_date, id) AS plates,
        array_agg(work_order    ORDER BY settle_date, id) AS work_orders,
        array_agg(bonus_amount  ORDER BY settle_date, id) AS bonuses,
        array_agg(income_total  ORDER BY settle_date, id) AS incomes,
        array_agg(bonus_rate    ORDER BY settle_date, id) AS rates,
        array_agg(settle_date::text ORDER BY settle_date, id) AS settle_dates,
        array_agg(apply_date::text  ORDER BY settle_date, id) AS apply_dates
      FROM bodyshop_bonus_applications
      WHERE ${conds.join(' AND ')}
      GROUP BY applicant_name, emp_id, dept_name, branch
      ORDER BY total_bonus DESC
    `, params);

    // 待結清件數
    const pendingRes = await pool.query(`
      SELECT applicant_name, emp_id, COUNT(*) AS pending_count
      FROM bodyshop_bonus_applications
      WHERE status IN ('matched_pending','pending','not_found')
        AND source_app_id IS NULL
      GROUP BY applicant_name, emp_id
    `);
    const pendingMap = {};
    pendingRes.rows.forEach(p => {
      pendingMap[p.emp_id || p.applicant_name] = parseInt(p.pending_count);
    });

    res.json({ rows: r.rows, pendingMap, settled_period });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 待結清清單（只看原始列）══
router.get('/bodyshop-bonus/pending', async (req, res) => {
  const { branch } = req.query;
  try {
    const conds  = [`status IN ('matched_pending','pending','not_found')`, `source_app_id IS NULL`];
    const params = [];
    if (branch) { conds.push(`branch=$1`); params.push(branch); }
    const r = await pool.query(`
      SELECT *, EXTRACT(EPOCH FROM NOW() - created_at)/86400 AS days_pending
      FROM bodyshop_bonus_applications
      WHERE ${conds.join(' AND ')}
      ORDER BY apply_date ASC
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 修改獎金比率（支援子列）══
router.patch('/bodyshop-bonus/applications/:id/rate', requirePermission('feature:bodyshop_bonus_edit'), async (req, res) => {
  const { bonus_rate } = req.body;
  try {
    const app = (await pool.query(
      `SELECT * FROM bodyshop_bonus_applications WHERE id=$1`, [req.params.id]
    )).rows[0];
    if (!app) return res.status(404).json({ error: '找不到記錄' });
    if (app.app_period && checkPeriodLock(app.app_period, res, req)) return;

    const rate = parseFloat(bonus_rate);
    if (isNaN(rate) || rate <= 0 || rate > 1)
      return res.status(400).json({ error: '比率必須介於 0~1' });

    let bonusAmt = app.bonus_amount;
    if (app.status === 'settled' && app.income_total) {
      bonusAmt = Math.min(parseFloat(app.income_total) * rate, 20000);
    }

    await pool.query(
      `UPDATE bodyshop_bonus_applications SET bonus_rate=$1, bonus_amount=$2, updated_at=NOW() WHERE id=$3`,
      [rate, bonusAmt, req.params.id]
    );
    res.json({ ok: true, bonus_amount: bonusAmt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 修改備註 ══
router.patch('/bodyshop-bonus/applications/:id/note', requirePermission('feature:bodyshop_bonus_edit'), async (req, res) => {
  const { note } = req.body;
  try {
    await pool.query(
      `UPDATE bodyshop_bonus_applications SET note=$1, updated_at=NOW() WHERE id=$2`,
      [note || '', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 刪除記錄（若為原始列，子列 CASCADE 自動刪除）══
router.delete('/bodyshop-bonus/applications/:id', requirePermission('feature:bodyshop_bonus_edit'), async (req, res) => {
  try {
    // 先讀 app_period 做鎖定檢查
    const r = await pool.query('SELECT app_period FROM bodyshop_bonus_applications WHERE id=$1', [req.params.id]);
    const p = r.rows[0]?.app_period;
    if (p && checkPeriodLock(p, res, req)) return;
    await pool.query(`DELETE FROM bodyshop_bonus_applications WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 已有資料的期間清單 ══
router.get('/bodyshop-bonus/periods', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT app_period FROM bodyshop_bonus_applications
      WHERE source_app_id IS NULL
      ORDER BY app_period DESC
    `);
    res.json(r.rows.map(r => r.app_period));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
