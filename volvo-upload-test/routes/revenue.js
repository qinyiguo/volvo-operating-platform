/**
 * routes/revenue.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 四大營收目標 + 業績預估（週次鎖定）。
 *
 * 月目標:
 *   GET    /api/revenue-targets                       一般/鈑烤/延保/有費 月目標
 *   PUT    /api/revenue-targets/batch     (feature:targets)
 *   DELETE /api/revenue-targets           (feature:targets)
 *   POST   /api/upload-revenue-targets            (feature:upload)
 *   POST   /api/upload-revenue-targets-native     (feature:upload)
 *
 * 業績預估（revenue_estimates + revenue_estimate_history）:
 *   GET  /api/revenue-estimates                       各站本月最新預估（即時顯示）
 *   PUT  /api/revenue-estimates/batch     (feature:targets)
 *   GET  /api/revenue-estimates/week-status           各站本週是否已提交
 *   GET  /api/revenue-estimates/history               週次提交歷史
 *   POST /api/revenue-estimates/weekly-submit  (feature:targets) 提交週次預估
 *     每自然週每站最多一次，提交後鎖定寫入 history 表不可覆蓋。
 */
const router = require('express').Router();
const multer = require('multer');
const XLSX   = require('xlsx');
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireAuth);

// ── Week helpers ──
function getCurrentWeekMonday() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000); // Taiwan UTC+8
  const dow = now.getUTCDay();                             // 0=Sun
  const daysFromMon = (dow + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysFromMon);
  return monday.toISOString().slice(0, 10);                // YYYY-MM-DD
}

function getWeekLabel(mondayStr) {
  const mon = new Date(mondayStr + 'T00:00:00Z');
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  const fmt = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${fmt(mon)}-${fmt(sun)}`;
}

// ── 營收目標 CRUD ──
router.get('/revenue-targets', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(`SELECT * FROM revenue_targets ${where} ORDER BY period, branch`, params)).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/revenue-targets/batch', requirePermission('feature:targets'), async (req, res) => {
  const { entries } = req.body;
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

router.delete('/revenue-targets', requirePermission('feature:targets'), async (req, res) => {
  const { branch, period } = req.query;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  try {
    await pool.query(`DELETE FROM revenue_targets WHERE branch=$1 AND period=$2`, [branch, period]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 營收目標 Excel 匯入（範本格式）──
router.post('/upload-revenue-targets', requirePermission('feature:upload'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Excel 無資料列' });

    const numCol = (row, ...keys) => {
      for (const k of keys) { const v = row[k]; const n = parseFloat(v); if (v !== '' && v !== undefined && !isNaN(n)) return n; }
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

// ── 營收目標 Excel 匯入（原生格式）──
router.post('/upload-revenue-targets-native', requirePermission('feature:upload'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const year     = String(req.body.year || '').trim();
  const dataType = String(req.body.dataType || 'target').trim();
  if (!year.match(/^\d{4}$/)) return res.status(400).json({ error: '請指定正確的年份（4位數）' });
  const suffix = dataType === 'last_year' ? '_last_year' : '_target';
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, cellNF: true, cellText: false });
    const SHEET_KWS = ['目標','年度','營收','實績'];
    let sheetName = workbook.SheetNames[0];
    for (const sn of workbook.SheetNames) { if (SHEET_KWS.some(kw => sn.includes(kw))) { sheetName = sn; break; } }
    const sheet = workbook.Sheets[sheetName];
    const raw   = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });

    const BRANCHES    = ['AMA','AMC','AMD'];
    const SECTION_MAP = [
      { kw: ['有效營收','有費營收','有費'], field: 'paid'     },
      { kw: ['鈑烤'],                      field: 'bodywork'  },
      { kw: ['一般營收','一般'],            field: 'general'   },
      { kw: ['延保'],                       field: 'extended'  },
    ];
    const toMonthIndex = (cell) => {
      const s = String(cell ?? '').trim();
      const m1 = s.match(/^([1-9]|1[0-2])月$/);  if (m1) return parseInt(m1[1]);
      const m2 = s.match(/^([1-9]|1[0-2])$/);     if (m2) return parseInt(m2[1]);
      if (typeof cell === 'number' && cell >= 1 && cell <= 12 && Number.isInteger(cell)) return cell;
      return -1;
    };

    const data = {}; let curField = null, monthColIdx = {};
    for (let ri = 0; ri < raw.length; ri++) {
      const row = raw[ri];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
      const rowStr = row.map(c => String(c ?? '')).join('|');
      for (const sm of SECTION_MAP) {
        if (sm.kw.some(kw => rowStr.includes(kw))) {
          const hasMonths = row.filter(c => toMonthIndex(c) > 0).length;
          if (hasMonths < 3) { curField = sm.field; monthColIdx = {}; if (!data[curField]) data[curField] = {}; break; }
        }
      }
      const monthCells = row.map((c, ci) => ({ mo: toMonthIndex(c), ci })).filter(x => x.mo > 0);
      if (monthCells.length >= 6) { monthColIdx = {}; monthCells.forEach(({ mo, ci }) => { monthColIdx[mo] = ci; }); continue; }
      if (!curField || Object.keys(monthColIdx).length === 0) continue;
      const branchRaw     = String(row[0] ?? row[1] ?? '').trim().toUpperCase();
      const matchedBranch = BRANCHES.find(b => branchRaw === b || branchRaw.endsWith(b));
      if (!matchedBranch) continue;
      if (!data[curField][matchedBranch]) data[curField][matchedBranch] = {};
      for (const [mo, ci] of Object.entries(monthColIdx)) {
        const raw_v = row[ci];
        const v     = parseFloat(String(raw_v ?? '').replace(/,/g, ''));
        if (!isNaN(v) && v > 0) data[curField][matchedBranch][parseInt(mo)] = v;
      }
    }

    const entriesMap = {};
    for (const [field, branchData] of Object.entries(data)) {
      for (const [branch, monthData] of Object.entries(branchData)) {
        for (const [mo, valK] of Object.entries(monthData)) {
          const period = `${year}${String(mo).padStart(2,'0')}`;
          const key    = `${branch}_${period}`;
          if (!entriesMap[key]) entriesMap[key] = { branch, period };
          entriesMap[key][`${field}${suffix}`] = Math.round(valK);
        }
      }
    }
    const entries = Object.values(entriesMap);
    if (!entries.length) {
      const detected = Object.keys(data);
      const branchesFound = detected.length > 0 ? Object.keys(data[detected[0]] || {}) : [];
      return res.status(400).json({
        error: `找不到有效資料。已識別區塊：${detected.length ? detected.join('/') : '無'}；找到據點：${branchesFound.length ? branchesFound.join('/') : '無'}。`,
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

// ── 業績預估（即時讀取，供主頁顯示）──
router.get('/revenue-estimates', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(`SELECT * FROM revenue_estimates ${where} ORDER BY branch`, params)).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/revenue-estimates/batch', requirePermission('feature:targets'), async (req, res) => {
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

// ════════════════════════════════════════════
// ── 週次預估 API ──
// ════════════════════════════════════════════

// GET /api/revenue-estimates/week-status?period=YYYYMM
// 回傳本週 week_key 和各據點是否已提交
router.get('/revenue-estimates/week-status', async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  const week_key   = getCurrentWeekMonday();
  const week_label = getWeekLabel(week_key);
  try {
    const r = await pool.query(
      `SELECT * FROM revenue_estimate_history WHERE period=$1 AND week_key=$2`,
      [period, week_key]
    );
    const submissions = {};
    r.rows.forEach(row => { submissions[row.branch] = row; });
    res.json({ week_key, week_label, submissions });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/revenue-estimates/history?period=YYYYMM&branch=AMA
// 取得歷史提交紀錄
router.get('/revenue-estimates/history', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT * FROM revenue_estimate_history ${where} ORDER BY week_key DESC, branch`,
      params
    );
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/revenue-estimates/weekly-submit
// 提交本週預估（每週每據點只能提交一次）
router.post('/revenue-estimates/weekly-submit', requirePermission('feature:targets'), async (req, res) => {
  const { period, entries, note } = req.body;
  if (!period || !Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: '參數不完整' });

  const week_key   = getCurrentWeekMonday();
  const week_label = getWeekLabel(week_key);
  const client     = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    const skipped  = [];

    for (const e of entries) {
      if (!e.branch) continue;

      // 檢查本週是否已提交
      const check = await client.query(
        `SELECT id FROM revenue_estimate_history WHERE period=$1 AND week_key=$2 AND branch=$3`,
        [period, week_key, e.branch]
      );
      if (check.rows.length) { skipped.push(e.branch); continue; }

      // 寫入歷史
      await client.query(`
        INSERT INTO revenue_estimate_history
          (period, week_key, week_label, branch,
           paid_estimate, bodywork_estimate, general_estimate, extended_estimate, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [period, week_key, week_label, e.branch,
          e.paid || null, e.bodywork || null, e.general || null, e.extended || null,
          note || '']);

      // 更新即時預估表（供主頁顯示）
      await client.query(`
        INSERT INTO revenue_estimates
          (branch,period,paid_estimate,bodywork_estimate,general_estimate,extended_estimate,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (branch,period) DO UPDATE SET
          paid_estimate=$3, bodywork_estimate=$4,
          general_estimate=$5, extended_estimate=$6, updated_at=NOW()
      `, [e.branch, period,
          e.paid || null, e.bodywork || null, e.general || null, e.extended || null]);

      inserted.push(e.branch);
    }

    await client.query('COMMIT');
    res.json({ ok: true, week_key, week_label, inserted, skipped });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
