const router = require('express').Router();
const multer = require('multer');
const XLSX   = require('xlsx');
const pool   = require('../db/pool');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ══ 正規化車牌（移除空白、破折號，轉大寫）══
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

// ══ 初始化 DB Table（啟動時自動建立）══
async function initTable() {
  try {
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
        -- 匹配結果
        status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
        work_order       VARCHAR(50),
        repair_type      VARCHAR(50),
        settle_date      DATE,
        income_total     NUMERIC(12,2),
        bonus_rate       NUMERIC(5,4) DEFAULT 0.02,
        bonus_amount     NUMERIC(12,2),
        settled_period   VARCHAR(6),
        -- 後續追蹤
        note             TEXT DEFAULT '',
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_period    ON bodyshop_bonus_applications(app_period)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_plate     ON bodyshop_bonus_applications(plate_no_norm)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_status    ON bodyshop_bonus_applications(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bba_settle    ON bodyshop_bonus_applications(settle_date)`);
    await pool.query(`ALTER TABLE bodyshop_bonus_applications ADD COLUMN IF NOT EXISTS upload_batch VARCHAR(50)`);

    // ★ 確保 app_settings 表存在（含唯一索引）
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

router.put('/bodyshop-bonus/settings', async (req, res) => {
  const { lookback_days, rate_a, rate_b } = req.body;
  const val = JSON.stringify({
    lookback_days: parseInt(lookback_days) >= 0 ? parseInt(lookback_days) : 30,
    rate_a:        parseFloat(rate_a)      || 2,
    rate_b:        parseFloat(rate_b)      || 4,
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
  const col = name => {
    const idx = headers.findIndex(h => h.includes(name));
    return idx >= 0 ? idx : -1;
  };

  const fmtDate = v => {
    if (!v) return null;
    if (v instanceof Date) {
      const y = v.getFullYear();
      const m = String(v.getMonth()+1).padStart(2,'0');
      const d = String(v.getDate()).padStart(2,'0');
      return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    const m2 = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m2 ? `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}` : null;
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
    if (applyDateStr) {
      appPeriod = applyDateStr.slice(0,4) + applyDateStr.slice(5,7);
    }

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
router.post('/bodyshop-bonus/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const batchId = `batch_${Date.now()}`;
  try {
    const rows = parseFormExcel(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: '找不到有效資料' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let inserted = 0, skipped = 0;

      for (const r of rows) {
        if (!r.plate_no_norm || !r.app_period) { skipped++; continue; }

        const dup = await client.query(
          `SELECT id FROM bodyshop_bonus_applications
           WHERE plate_no_norm=$1 AND apply_date=$2 AND applicant_name=$3`,
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

// ══ 執行匹配 ══
// ★ 優先抓「申請日期後」開立的工單；往前回溯天數依設定；結清日期月份決定獎金所屬月份
router.post('/bodyshop-bonus/match', async (req, res) => {
  const { period } = req.body;
  if (!period) return res.status(400).json({ error: 'period 為必填' });

  try {
    // 讀取設定
    const cfgR = await pool.query(`SELECT value FROM app_settings WHERE key='bodyshop_bonus_settings'`);
    const cfg  = cfgR.rows[0] ? JSON.parse(cfgR.rows[0].value) : {};
    const lookbackDays  = parseInt(cfg.lookback_days ?? 30);
    const defaultRateA  = parseFloat(cfg.rate_a ?? 2) / 100;

    const appRows = (await pool.query(`
      SELECT * FROM bodyshop_bonus_applications
      WHERE status IN ('pending', 'matched_pending', 'not_found')
      ORDER BY apply_date ASC
    `)).rows;

    let matched = 0, settled = 0, notFound = 0;

    for (const app of appRows) {
      const plate  = app.plate_no_norm;
      const branch = app.branch;
      if (!plate) continue;

      // ── Step 1: 查 business_query ──
      // ★ 申請日期前 lookbackDays 天到現在，都納入；ORDER BY 優先申請日期後的工單
      const bqConds  = [`UPPER(REPLACE(REPLACE(plate_no,' ',''),'-',''))=$1`];
      const bqParams = [plate];
      let idx = 2;

      if (branch) { bqConds.push(`branch=$${idx++}`); bqParams.push(branch); }

      if (app.apply_date) {
        // 往前回溯 lookbackDays 天（申請日期後的工單不受此限，全部納入）
        bqConds.push(`open_time >= ($${idx++}::date - interval '${lookbackDays} days')`);
        bqParams.push(app.apply_date);
      }

      // 帳類：鈑烤相關
      bqConds.push(`(
        repair_type ILIKE '%鈑%' OR repair_type ILIKE '%噴%' OR
        repair_type ILIKE '%保險%' OR repair_type ILIKE '%事故%' OR
        repair_type ILIKE '%鈑烤%' OR repair_type ILIKE '%鈑金%'
      )`);

      // ★ 優先排序：申請日期後的工單排前面，次以 open_time DESC
      // 申請日期後的 open_time >= apply_date → 排序值 0（先顯示）
      const applyDateForSort = app.apply_date || new Date().toISOString().slice(0,10);
      const orderClause = app.apply_date
        ? `ORDER BY (open_time >= $${idx++}::date) DESC, open_time DESC LIMIT 10`
        : `ORDER BY open_time DESC LIMIT 10`;
      if (app.apply_date) bqParams.push(applyDateForSort);

      const bqRes = await pool.query(
        `SELECT work_order, branch, repair_type, settle_date, open_time
         FROM business_query WHERE ${bqConds.join(' AND ')} ${orderClause}`,
        bqParams
      );

      if (!bqRes.rows.length) {
        await pool.query(
          `UPDATE bodyshop_bonus_applications SET status='not_found', updated_at=NOW() WHERE id=$1`,
          [app.id]
        );
        notFound++;
        continue;
      }

      matched++;
      let bestWorkOrder  = null;
      let bestBranch     = null;
      let bestRepairType = null;
      let incomeTotal    = null;
      let settleDate     = null;
      let isSettled      = false;

      // ── Step 2: 查 repair_income 是否結清 ──
      for (const bq of bqRes.rows) {
        const riRes = await pool.query(`
          SELECT work_order, branch, clear_date,
                 COALESCE(total_taxed, total_untaxed) AS income_total
          FROM repair_income
          WHERE work_order=$1 AND branch=$2 AND clear_date IS NOT NULL
          LIMIT 1
        `, [bq.work_order, bq.branch]);

        if (riRes.rows.length) {
          isSettled      = true;
          bestWorkOrder  = bq.work_order;
          bestBranch     = bq.branch;
          bestRepairType = bq.repair_type;
          settleDate     = riRes.rows[0].clear_date;
          incomeTotal    = parseFloat(riRes.rows[0].income_total || 0);
          break;
        } else {
          if (!bestWorkOrder) {
            bestWorkOrder  = bq.work_order;
            bestBranch     = bq.branch;
            bestRepairType = bq.repair_type;
          }
        }
      }

      if (isSettled) {
        const rate     = parseFloat(app.bonus_rate || defaultRateA);
        const bonusAmt = Math.min(incomeTotal * rate, 20000);

        // ★ settled_period 依結清日期月份決定（而非執行比對的當月）
        const sd = settleDate instanceof Date ? settleDate : new Date(settleDate);
        const settledPeriod = sd.getFullYear() + String(sd.getMonth()+1).padStart(2,'0');

        await pool.query(`
          UPDATE bodyshop_bonus_applications SET
            status='settled', work_order=$1, branch=$2, repair_type=$3,
            settle_date=$4, income_total=$5, bonus_amount=$6,
            settled_period=$7, updated_at=NOW()
          WHERE id=$8
        `, [bestWorkOrder, bestBranch, bestRepairType,
            settleDate, incomeTotal, bonusAmt,
            settledPeriod, app.id]);
        settled++;
      } else if (bestWorkOrder) {
        await pool.query(`
          UPDATE bodyshop_bonus_applications SET
            status='matched_pending', work_order=$1, branch=$2,
            repair_type=$3, updated_at=NOW()
          WHERE id=$4
        `, [bestWorkOrder, bestBranch, bestRepairType, app.id]);
      }
    }

    res.json({ ok: true, total: appRows.length, matched, settled, notFound, period });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ ★ 重置已結清記錄（讓舊的錯誤比對結果可重新比對）══
// POST /bodyshop-bonus/reset-match  body: { app_period?, branch? }
// 將指定期間/廠別的 settled/matched_pending 記錄重置為 pending
router.post('/bodyshop-bonus/reset-match', async (req, res) => {
  const { app_period, branch } = req.body;
  try {
    const conds  = [`status IN ('settled','matched_pending','not_found')`];
    const params = [];
    let idx = 1;
    if (app_period) { conds.push(`app_period=$${idx++}`); params.push(app_period); }
    if (branch)     { conds.push(`branch=$${idx++}`);     params.push(branch); }

    const r = await pool.query(`
      UPDATE bodyshop_bonus_applications SET
        status='pending',
        work_order=NULL, repair_type=NULL, settle_date=NULL,
        income_total=NULL, bonus_amount=NULL, settled_period=NULL,
        updated_at=NOW()
      WHERE ${conds.join(' AND ')}
      RETURNING id
    `, params);

    res.json({ ok: true, reset: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 查詢申請清單 ══
router.get('/bodyshop-bonus/applications', async (req, res) => {
  const { period, status, branch, page = 1, limit = 200 } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`app_period=$${idx++}`); params.push(period); }
    if (status) { conds.push(`status=$${idx++}`);     params.push(status); }
    if (branch) { conds.push(`branch=$${idx++}`);     params.push(branch); }
    const where  = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const offset = (parseInt(page)-1) * parseInt(limit);
    const r = await pool.query(
      `SELECT * FROM bodyshop_bonus_applications ${where}
       ORDER BY apply_date DESC, id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, parseInt(limit), offset]
    );
    const cnt = await pool.query(
      `SELECT COUNT(*) AS total FROM bodyshop_bonus_applications ${where}`, params
    );
    res.json({ rows: r.rows, total: parseInt(cnt.rows[0].total) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ ★ 獎金彙總：依結清日期（settle_date）月份過濾，而非 settled_period ══
router.get('/bodyshop-bonus/summary', async (req, res) => {
  const { settled_period, branch } = req.query;
  if (!settled_period) return res.status(400).json({ error: 'settled_period 為必填' });
  try {
    // settled_period 格式 "YYYYMM" → 轉成該月份範圍
    const periodDate = `${settled_period.slice(0,4)}-${settled_period.slice(4,6)}-01`;

    const conds  = [
      `status='settled'`,
      `DATE_TRUNC('month', settle_date) = DATE_TRUNC('month', $1::date)`,
    ];
    const params = [periodDate];
    let idx = 2;
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }

    const r = await pool.query(`
      SELECT
        applicant_name, emp_id, dept_name,
        branch,
        COUNT(*) AS work_order_count,
        SUM(income_total) AS total_income,
        SUM(bonus_amount) AS total_bonus,
        array_agg(plate_no_raw  ORDER BY settle_date) AS plates,
        array_agg(work_order    ORDER BY settle_date) AS work_orders,
        array_agg(bonus_amount  ORDER BY settle_date) AS bonuses,
        array_agg(income_total  ORDER BY settle_date) AS incomes,
        array_agg(bonus_rate    ORDER BY settle_date) AS rates,
        array_agg(settle_date::text ORDER BY settle_date) AS settle_dates
      FROM bodyshop_bonus_applications
      WHERE ${conds.join(' AND ')}
      GROUP BY applicant_name, emp_id, dept_name, branch
      ORDER BY total_bonus DESC
    `, params);

    // 待結清件數（全部未結清，不限期間）
    const pendingRes = await pool.query(`
      SELECT applicant_name, emp_id, COUNT(*) AS pending_count
      FROM bodyshop_bonus_applications
      WHERE status IN ('matched_pending','pending','not_found')
      GROUP BY applicant_name, emp_id
    `);
    const pendingMap = {};
    pendingRes.rows.forEach(p => {
      pendingMap[p.emp_id || p.applicant_name] = parseInt(p.pending_count);
    });

    res.json({ rows: r.rows, pendingMap, settled_period });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 所有待結清清單 ══
router.get('/bodyshop-bonus/pending', async (req, res) => {
  const { branch } = req.query;
  try {
    const conds  = [`status IN ('matched_pending','pending','not_found')`];
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

// ══ 修改獎金比率 ══
router.patch('/bodyshop-bonus/applications/:id/rate', async (req, res) => {
  const { bonus_rate } = req.body;
  try {
    const app = (await pool.query(
      `SELECT * FROM bodyshop_bonus_applications WHERE id=$1`, [req.params.id]
    )).rows[0];
    if (!app) return res.status(404).json({ error: '找不到記錄' });

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
router.patch('/bodyshop-bonus/applications/:id/note', async (req, res) => {
  const { note } = req.body;
  try {
    await pool.query(
      `UPDATE bodyshop_bonus_applications SET note=$1, updated_at=NOW() WHERE id=$2`,
      [note || '', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 刪除單筆記錄 ══
router.delete('/bodyshop-bonus/applications/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM bodyshop_bonus_applications WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ 取得已有資料的期間清單 ══
router.get('/bodyshop-bonus/periods', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT app_period FROM bodyshop_bonus_applications
      ORDER BY app_period DESC
    `);
    res.json(r.rows.map(r => r.app_period));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
