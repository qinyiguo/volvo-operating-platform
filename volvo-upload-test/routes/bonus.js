const router = require('express').Router();
const multer = require('multer');
const XLSX   = require('xlsx');
const pool   = require('../db/pool');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════
function lastMonth(period) {
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4));
  if (m === 1) return `${y - 1}12`;
  return `${y}${String(m - 1).padStart(2, '0')}`;
}

// 'YYYYMM' → '2026-03-01'
function periodStart(period) {
  return `${period.slice(0,4)}-${period.slice(4,6)}-01`;
}

// 標準過濾：排除「本月前離職」與「計時人員」
// 回傳 { cond, param, nextIdx }，cond 以 AND 開頭
function activeFilter(period, startIdx) {
  return {
    cond: `
      AND (
        status != '離職'
        OR (resign_date IS NOT NULL AND resign_date >= $${startIdx}::date)
      )
      AND COALESCE(job_category, '') NOT ILIKE '%計時%'
      AND COALESCE(job_title,    '') NOT ILIKE '%計時%'
    `,
    param: periodStart(period),
    nextIdx: startIdx + 1,
  };
}

// ══════════════════════════════════════════════
// 人員名冊 — 上傳解析
// ══════════════════════════════════════════════
function parseRosterExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });

  let headerIdx = 3;
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    if (raw[i].some(c => String(c || '').includes('員工編號'))) { headerIdx = i; break; }
  }
  const headers = raw[headerIdx].map(c => String(c || '').trim());
  const col = name => headers.indexOf(name);

  const fmtDate = v => {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : null;
  };

  const rows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const empId = String(r[col('員工編號')] || '').trim();
    if (!empId) continue;
    const status = String(r[col('在職狀態')] || '').trim();
    if (!status) continue;
    rows.push({
      emp_id:             empId,
      emp_name:           String(r[col('中文姓名')]     || '').trim(),
      dept_code:          String(r[col('部門代碼')]     || '').trim(),
      dept_name:          String(r[col('部門中文名稱')] || '').trim(),
      job_title:          String(r[col('職務中文名稱')] || '').trim(),
      status,
      hire_date:          fmtDate(r[col('到職日期')]),
      resign_date:        fmtDate(r[col('離職日期')]),
      unpaid_leave_date:  fmtDate(r[col('留職停薪日')]),
      mgr1:               String(r[col('一階主管')]     || '').trim(),
      mgr2:               String(r[col('二階主管')]     || '').trim(),
      job_category:       String(r[col('職種名稱')]     || '').trim(),
      job_class:          String(r[col('職類名稱')]     || '').trim(),
    });
  }
  return rows;
}

function inferFactory(deptCode) {
  if (!deptCode) return null;
  const code = String(deptCode);
  if (code.startsWith('051')) return 'AMA';
  if (code.startsWith('053')) return 'AMD';
  if (code.startsWith('054')) return 'AMC';
  if (code.startsWith('055')) return '聯合';
  if (code.startsWith('056') || code.startsWith('061')) return '鈑烤';
  if (code.startsWith('057') || code.startsWith('07'))  return '零件';
  return null;
}

// ── 上傳人員資料 ──
router.post('/bonus/upload-roster', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const period = String(req.body.period || '').trim();
  if (!period.match(/^\d{6}$/)) return res.status(400).json({ error: '請指定期間（YYYYMM）' });
  try {
    const rows = parseRosterExcel(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: '找不到有效資料列' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM staff_roster WHERE period=$1', [period]);
      let count = 0;
      for (const r of rows) {
        await client.query(`
          INSERT INTO staff_roster
            (period,emp_id,emp_name,dept_code,dept_name,job_title,status,
             hire_date,resign_date,unpaid_leave_date,mgr1,mgr2,
             factory,job_category,job_class)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (period,emp_id) DO UPDATE SET
            emp_name=EXCLUDED.emp_name, dept_code=EXCLUDED.dept_code,
            dept_name=EXCLUDED.dept_name, job_title=EXCLUDED.job_title,
            status=EXCLUDED.status, hire_date=EXCLUDED.hire_date,
            resign_date=EXCLUDED.resign_date, unpaid_leave_date=EXCLUDED.unpaid_leave_date,
            mgr1=EXCLUDED.mgr1, mgr2=EXCLUDED.mgr2, factory=EXCLUDED.factory,
            job_category=EXCLUDED.job_category, job_class=EXCLUDED.job_class,
            updated_at=NOW()
        `, [
          period, r.emp_id, r.emp_name, r.dept_code, r.dept_name, r.job_title, r.status,
          r.hire_date, r.resign_date, r.unpaid_leave_date, r.mgr1, r.mgr2,
          inferFactory(r.dept_code), r.job_category, r.job_class,
        ]);
        count++;
      }
      await client.query('COMMIT');
      res.json({ ok: true, count, period });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得人員名冊（已過濾：排除本月前離職、排除計時）──
router.get('/bonus/roster', async (req, res) => {
  const { period, factory, status, dept_code } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const f = activeFilter(period, 2);
    const p = [period, f.param]; let idx = f.nextIdx;
    let extra = '';
    if (factory)   { extra += ` AND factory=$${idx++}`;   p.push(factory); }
    if (status)    { extra += ` AND status=$${idx++}`;    p.push(status); }
    if (dept_code) { extra += ` AND dept_code=$${idx++}`; p.push(dept_code); }
    const r = await pool.query(
      `SELECT * FROM staff_roster WHERE period=$1 ${f.cond} ${extra} ORDER BY dept_code, emp_id`, p
    );
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 手動調整員工廠別 ──
router.patch('/bonus/roster/:period/:emp_id', async (req, res) => {
  const { period, emp_id } = req.params;
  const { factory } = req.body;
  try {
    await pool.query(`UPDATE staff_roster SET factory=$1, updated_at=NOW() WHERE period=$2 AND emp_id=$3`,
      [factory || null, period, emp_id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得人員名冊期間清單 ──
router.get('/bonus/roster-periods', async (req, res) => {
  try {
    const r = await pool.query(`SELECT DISTINCT period FROM staff_roster ORDER BY period DESC`);
    res.json(r.rows.map(r => r.period));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得人員名冊摘要 ──
router.get('/bonus/roster-summary', async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  const prevPeriod = lastMonth(period);
  const f = activeFilter(period, 2);
  try {
    const summary = await pool.query(`
      SELECT dept_code, dept_name, factory, status, COUNT(*) AS cnt
      FROM staff_roster WHERE period=$1 ${f.cond}
      GROUP BY dept_code, dept_name, factory, status ORDER BY dept_code, status
    `, [period, f.param]);

    const resignLastMonth = await pool.query(`
      SELECT emp_id, emp_name, dept_name, factory, resign_date, mgr1
      FROM staff_roster
      WHERE period=$1 AND status='離職' AND resign_date IS NOT NULL
        AND TO_CHAR(resign_date,'YYYYMM')=$2
      ORDER BY dept_code, resign_date
    `, [period, prevPeriod]);

    const newHiresLastMonth = await pool.query(`
      SELECT emp_id, emp_name, dept_name, factory, hire_date, job_title, mgr1
      FROM staff_roster
      WHERE period=$1 AND hire_date IS NOT NULL
        AND TO_CHAR(hire_date,'YYYYMM')=$2
        AND COALESCE(job_category,'') NOT ILIKE '%計時%'
        AND COALESCE(job_title,'') NOT ILIKE '%計時%'
      ORDER BY dept_code, hire_date
    `, [period, prevPeriod]);

    const unpaid = await pool.query(`
      SELECT emp_id, emp_name, dept_name, factory, unpaid_leave_date, mgr1
      FROM staff_roster WHERE period=$1 AND status='留職停薪'
        AND COALESCE(job_category,'') NOT ILIKE '%計時%'
        AND COALESCE(job_title,'') NOT ILIKE '%計時%'
      ORDER BY dept_code
    `, [period]);

    res.json({
      summary: summary.rows,
      resignLastMonth: resignLastMonth.rows,
      newHiresLastMonth: newHiresLastMonth.rows,
      unpaidLeave: unpaid.rows,
      prevPeriod,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// 獎金指標設定 CRUD（含 target_dept_codes）
// ══════════════════════════════════════════════
router.get('/bonus/metrics', async (req, res) => {
  try {
    res.json((await pool.query(`SELECT * FROM bonus_metrics ORDER BY sort_order, id`)).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/bonus/metrics', async (req, res) => {
  const { metric_name, description, scope_type, scope_value,
          metric_source, filters, stat_field, unit, sort_order,
          bonus_rule, target_dept_codes } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(`
      INSERT INTO bonus_metrics
        (metric_name,description,scope_type,scope_value,metric_source,
         filters,stat_field,unit,sort_order,target_dept_codes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [metric_name.trim(), description||'', scope_type||'person', scope_value||'',
        metric_source||'manual', JSON.stringify(filters||[]),
        stat_field||'amount', unit||'', sort_order||0,
        JSON.stringify(target_dept_codes||[])]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/bonus/metrics/:id', async (req, res) => {
  const { metric_name, description, scope_type, scope_value,
          metric_source, filters, stat_field, unit, sort_order,
          bonus_rule, target_dept_codes } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(`
      UPDATE bonus_metrics SET
        metric_name=$1, description=$2, scope_type=$3, scope_value=$4,
        metric_source=$5, filters=$6, stat_field=$7, unit=$8, sort_order=$9,
        target_dept_codes=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [metric_name.trim(), description||'', scope_type||'person', scope_value||'',
        metric_source||'manual', JSON.stringify(filters||[]),
        stat_field||'amount', unit||'', sort_order||0,
        JSON.stringify(target_dept_codes||[]), req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: '找不到指標' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bonus/metrics/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM bonus_targets WHERE metric_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM bonus_metrics WHERE id=$1`,        [req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// 獎金目標設定
// ══════════════════════════════════════════════
router.get('/bonus/targets', async (req, res) => {
  const { metric_id, period, emp_id, dept_code } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (metric_id) { conds.push(`metric_id=$${idx++}`); params.push(metric_id); }
    if (period)    { conds.push(`period=$${idx++}`);    params.push(period); }
    if (emp_id)    { conds.push(`emp_id=$${idx++}`);    params.push(emp_id); }
    if (dept_code) { conds.push(`dept_code=$${idx++}`); params.push(dept_code); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(
      `SELECT bt.*, bm.metric_name, bm.scope_type, bm.unit
       FROM bonus_targets bt
       JOIN bonus_metrics bm ON bm.id=bt.metric_id
       ${where} ORDER BY bt.metric_id, bt.emp_id, bt.dept_code`, params
    )).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/bonus/targets/batch', async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: '無資料' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (!e.metric_id || !e.period) continue;
      await client.query(`
        INSERT INTO bonus_targets
          (metric_id,emp_id,dept_code,period,target_value,last_year_value,bonus_rule,note,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (metric_id, COALESCE(emp_id,''), COALESCE(dept_code,''), period) DO UPDATE SET
          target_value=$5, last_year_value=$6, bonus_rule=$7, note=$8, updated_at=NOW()
      `, [e.metric_id, e.emp_id||null, e.dept_code||null, e.period,
          e.target_value||null, e.last_year_value||null,
          JSON.stringify(e.bonus_rule||{}), e.note||'']);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

router.delete('/bonus/targets/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM bonus_targets WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// 獎金進度計算
// ══════════════════════════════════════════════
router.get('/bonus/progress', async (req, res) => {
  const { period, factory } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const metrics = (await pool.query(`SELECT * FROM bonus_metrics ORDER BY sort_order, id`)).rows;
    const targets = (await pool.query(`SELECT * FROM bonus_targets WHERE period=$1`, [period])).rows;
    const results = [];
    for (const m of metrics) {
      let actual = null;
      if (m.metric_source !== 'manual') {
        const filters = m.filters || [];
        try {
          if (m.metric_source === 'repair_income') {
            const acTypes = filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const branchF = factory && ['AMA','AMC','AMD'].includes(factory) ? factory : null;
            const conds = [`period=$1`]; const p = [period]; let idx=2;
            if (branchF) { conds.push(`branch=$${idx++}`); p.push(branchF); }
            if (acTypes.length) { conds.push(`account_type=ANY($${idx++})`); p.push(acTypes); }
            const fld = m.stat_field==='count' ? 'COUNT(DISTINCT work_order)' : 'SUM(total_untaxed)';
            actual = parseFloat((await pool.query(`SELECT COALESCE(${fld},0) AS v FROM repair_income WHERE ${conds.join(' AND ')}`, p)).rows[0]?.v || 0);
          } else if (m.metric_source === 'tech_wage') {
            const branchF = factory && ['AMA','AMC','AMD'].includes(factory) ? factory : null;
            const conds = [`period=$1`]; const p = [period]; let idx=2;
            if (branchF) { conds.push(`branch=$${idx++}`); p.push(branchF); }
            const workCodes = filters.filter(f=>f.type==='work_code').map(f=>f.value);
            for (const wc of workCodes) {
              if (wc.includes('-')) { const [fr,to]=wc.split('-'); conds.push(`work_code BETWEEN $${idx++} AND $${idx++}`); p.push(fr.trim(),to.trim()); }
              else { conds.push(`work_code=$${idx++}`); p.push(wc); }
            }
            const fld = m.stat_field==='amount' ? 'SUM(wage)' : m.stat_field==='hours' ? 'SUM(standard_hours)' : 'COUNT(DISTINCT work_order)';
            actual = parseFloat((await pool.query(`SELECT COALESCE(${fld},0) AS v FROM tech_performance WHERE ${conds.join(' AND ')}`, p)).rows[0]?.v || 0);
          } else if (m.metric_source === 'parts_sales') {
            const branchF = factory && ['AMA','AMC','AMD'].includes(factory) ? factory : null;
            const conds = [`period=$1`]; const p = [period]; let idx=2;
            if (branchF) { conds.push(`branch=$${idx++}`); p.push(branchF); }
            const cc=filters.filter(f=>f.type==='category_code').map(f=>f.value);
            const pt=filters.filter(f=>f.type==='part_type').map(f=>f.value);
            if (cc.length) { conds.push(`category_code=ANY($${idx++})`); p.push(cc); }
            if (pt.length) { conds.push(`part_type=ANY($${idx++})`); p.push(pt); }
            const fld = m.stat_field==='qty' ? 'SUM(sale_qty)' : m.stat_field==='count' ? 'COUNT(*)' : 'SUM(sale_price_untaxed)';
            actual = parseFloat((await pool.query(`SELECT COALESCE(${fld},0) AS v FROM parts_sales WHERE ${conds.join(' AND ')}`, p)).rows[0]?.v || 0);
          }
        } catch(e) { actual = null; }
      }
      const myTargets = targets.filter(t => t.metric_id === m.id);
      results.push({ metric: m, targets: myTargets, actual });
    }
    res.json({ results, period });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 可設定目標的人員/部門清單（已過濾計時+舊離職，支援 dept_codes 篩選）──
router.get('/bonus/scope-members', async (req, res) => {
  const { period, scope_type, factory, dept_codes } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  const deptCodesArr = dept_codes
    ? dept_codes.split(',').map(s=>s.trim()).filter(Boolean)
    : [];
  const f = activeFilter(period, 2);
  try {
    const p = [period, f.param]; let idx = f.nextIdx;
    let extra = '';
    if (factory)             { extra += ` AND factory=$${idx++}`;           p.push(factory); }
    if (deptCodesArr.length) { extra += ` AND dept_code=ANY($${idx++})`;    p.push(deptCodesArr); }

    if (scope_type === 'dept') {
      const r = await pool.query(`
        SELECT DISTINCT dept_code, dept_name, factory
        FROM staff_roster WHERE period=$1 ${f.cond} ${extra}
        ORDER BY dept_code
      `, p);
      res.json(r.rows);
    } else {
      const r = await pool.query(`
        SELECT emp_id, emp_name, dept_code, dept_name, factory, job_title, mgr1
        FROM staff_roster WHERE period=$1 ${f.cond} ${extra}
        ORDER BY dept_code, emp_id
      `, p);
      res.json(r.rows);
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得部門清單（供指標設定 Modal 選擇套用對象）──
router.get('/bonus/departments', async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  const f = activeFilter(period, 2);
  try {
    const r = await pool.query(`
      SELECT DISTINCT dept_code, dept_name, factory
      FROM staff_roster WHERE period=$1 ${f.cond}
      ORDER BY factory NULLS LAST, dept_code
    `, [period, f.param]);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
