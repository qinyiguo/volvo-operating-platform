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
function periodStart(period) {
  return `${period.slice(0,4)}-${period.slice(4,6)}-01`;
}
function activeFilter(period, startIdx) {
  // 包含範圍：在職、留職停薪、以及「本月或上個月離職」的人員
  // 計算上個月第一天
  const y = parseInt(period.slice(0,4)), m = parseInt(period.slice(4));
  const prevMonthStart = m === 1
    ? `${y-1}-12-01`
    : `${y}-${String(m-1).padStart(2,'0')}-01`;
  return {
    cond: `
      AND (
        status != '離職'
        OR (resign_date IS NOT NULL AND resign_date >= $${startIdx}::date)
      )
      AND COALESCE(job_category, '') NOT ILIKE '%計時%'
      AND COALESCE(job_title,    '') NOT ILIKE '%計時%'
    `,
    param: prevMonthStart,   // ← 改為上個月1日，包含上個月離職者
    nextIdx: startIdx + 1,
  };
}

function inferFactory(deptCode) {
  if (!deptCode) return '售後服務處';
  const code = String(deptCode);
  if (code.startsWith('051')) return 'AMA';
  if (code.startsWith('053')) return 'AMC';
  if (code.startsWith('054')) return 'AMD';
  if (code.startsWith('055')) return '鈑烤';       // 鈑烤廠（原本錯誤是'聯合'）
  if (code.startsWith('056') || code.startsWith('061')) return '聯合';  // 聯合服務中心（原本錯誤是'鈑烤'）
  if (code.startsWith('057') || code.startsWith('07'))  return '零件';
  return '售後服務處';
}

// ── 計算 performance_metrics 實際值 ──
async function computePerfActual(metric, period, branch) {
  const filters = metric.filters || [];
  const BRANCHES = branch && ['AMA','AMC','AMD'].includes(branch) ? [branch] : ['AMA','AMC','AMD'];
  let total = 0;
  for (const br of BRANCHES) {
    let actual = 0;
    try {
      if (metric.metric_type === 'repair_income') {
        const acTypes = filters.filter(f=>f.type==='account_type').map(f=>f.value);
        const c = [`period=$1`,`branch=$2`]; const p = [period, br]; let i = 3;
        if (acTypes.length) { c.push(`account_type=ANY($${i++})`); p.push(acTypes); }
        const r = await pool.query(`SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE ${c.join(' AND ')}`, p);
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'parts') {
        const cc=filters.filter(f=>f.type==='category_code').map(f=>f.value);
        const fc=filters.filter(f=>f.type==='function_code').map(f=>f.value);
        const pn=filters.filter(f=>f.type==='part_number').map(f=>f.value);
        const pt=filters.filter(f=>f.type==='part_type').map(f=>f.value);
        const c=[`period=$1`,`branch=$2`]; const p=[period,br]; let i=3;
        if (cc.length){c.push(`category_code=ANY($${i++})`);p.push(cc);}
        if (fc.length){c.push(`function_code=ANY($${i++})`);p.push(fc);}
        if (pn.length){c.push(`part_number=ANY($${i++})`);p.push(pn);}
        if (pt.length){c.push(`part_type=ANY($${i++})`);p.push(pt);}
        const fld = metric.stat_field==='qty'?'SUM(sale_qty)':metric.stat_field==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
        const r = await pool.query(`SELECT COALESCE(${fld},0) as v FROM parts_sales WHERE ${c.join(' AND ')}`, p);
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'tech_wage') {
        const workCodes=filters.filter(f=>f.type==='work_code');
        const acTypes=filters.filter(f=>f.type==='account_type').map(f=>f.value);
        const c=[`period=$1`,`branch=$2`]; const p=[period,br]; let i=3;
        if (acTypes.length){c.push(`account_type=ANY($${i++})`);p.push(acTypes);}
        if (workCodes.length) {
          const wcs=workCodes.map(f=>{
            if(f.value.includes('-')){const[from,to]=f.value.split('-');return{type:'range',from:from.trim(),to:to.trim()};}
            return{type:'exact',value:f.value};
          });
          for (const wc of wcs) {
            if(wc.type==='range'){c.push(`work_code BETWEEN $${i++} AND $${i++}`);p.push(wc.from,wc.to);}
            else{c.push(`work_code=$${i++}`);p.push(wc.value);}
          }
        }
        const statExpr=metric.stat_field==='amount'?'SUM(wage)':metric.stat_field==='hours'?'SUM(standard_hours)':'COUNT(DISTINCT work_order)';
        const r = await pool.query(`SELECT COALESCE(${statExpr},0) as v FROM tech_performance WHERE ${c.join(' AND ')}`, p);
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'boutique') {
        const bt=filters.filter(f=>f.type==='boutique_type').map(f=>f.value);
        const ac=filters.filter(f=>f.type==='account_type').map(f=>f.value);
        const c=[`ps.period=$1`,`ps.branch=$2`]; const p=[period,br]; let i=3;
        if (bt.length){c.push(`pc.part_type=ANY($${i++})`);p.push(bt);}
        else{c.push(`pc.part_type IN ('精品','配件')`);}
        if (ac.length){c.push(`ps.part_type=ANY($${i++})`);p.push(ac);}
        const r = await pool.query(`SELECT COALESCE(SUM(ps.sale_price_untaxed),0) as v FROM parts_sales ps JOIN parts_catalog pc ON ps.part_number=pc.part_number WHERE ${c.join(' AND ')}`, p);
        actual = parseFloat(r.rows[0]?.v || 0);
      }
    } catch(e) {}
    total += actual;
  }
  return total;
}

// ── 計算營收目標實際值（有費/鈑烤/一般/延保）──
async function computeRevenueActual(period, branch, revType) {
  const cfgRow = await pool.query(`SELECT config_value FROM income_config WHERE config_key='external_sales_category'`);
  const extCat = cfgRow.rows[0]?.config_value || '外賣';
  const BRANCHES = branch && ['AMA','AMC','AMD'].includes(branch) ? [branch] : ['AMA','AMC','AMD'];

  let paid=0, bodywork=0, general=0, extended=0;

  for (const br of BRANCHES) {
    const riRes = await pool.query(`
      SELECT account_type, SUM(total_untaxed) AS total,
        SUM(CASE WHEN COALESCE(bodywork_income,0)>0 OR COALESCE(paint_income,0)>0
             THEN total_untaxed ELSE 0 END) AS with_bw,
        SUM(CASE WHEN COALESCE(bodywork_income,0)=0 AND COALESCE(paint_income,0)=0
             THEN total_untaxed ELSE 0 END) AS without_bw
      FROM repair_income WHERE period=$1 AND branch=$2
      GROUP BY account_type
    `, [period, br]);

    const extRes = await pool.query(`
      SELECT COALESCE(SUM(sale_price_untaxed),0) AS ext
      FROM parts_sales WHERE period=$1 AND branch=$2 AND category=$3
    `, [period, br, extCat]);

    const ext = parseFloat(extRes.rows[0]?.ext || 0);
    const findType = kw => riRes.rows.find(r => r.account_type?.includes(kw));
    const gen  = findType('一般');
    const ins  = findType('保險');
    const extW = findType('延保');
    const vou  = findType('票');

    const bw_ins   = parseFloat(ins?.total    || 0);
    const bw_self  = parseFloat(gen?.with_bw  || 0);
    const bw_tot   = bw_ins + bw_self;
    const ext_rev  = parseFloat(extW?.total   || 0);
    const gen_nobw = parseFloat(gen?.without_bw || 0);
    const vou_tot  = parseFloat(vou?.total    || 0);
    const gen_tot  = gen_nobw + vou_tot + ext;
    const paid_tot = gen_tot + bw_tot + ext_rev;

    paid     += paid_tot;
    bodywork += bw_tot;
    general  += gen_tot;
    extended += ext_rev;
  }

  const map = { paid, bodywork, general, extended };
  return map[revType] || 0;
}

// ── 取得營收目標值 ──
async function getRevenueTarget(period, branch, revType) {
  const BRANCHES = branch && ['AMA','AMC','AMD'].includes(branch) ? [branch] : ['AMA','AMC','AMD'];
  const colMap = { paid:'paid_target', bodywork:'bodywork_target', general:'general_target', extended:'extended_target' };
  const col = colMap[revType] || 'paid_target';
  let total = 0;
  for (const br of BRANCHES) {
    const r = await pool.query(`SELECT COALESCE(${col},0) AS v FROM revenue_targets WHERE period=$1 AND branch=$2`, [period, br]);
    total += parseFloat(r.rows[0]?.v || 0);
  }
  return total;
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
      emp_id: empId,
      emp_name: String(r[col('中文姓名')] || '').trim(),
      dept_code: String(r[col('部門代碼')] || '').trim(),
      dept_name: String(r[col('部門中文名稱')] || '').trim(),
      job_title: String(r[col('職務中文名稱')] || '').trim(),
      status,
      hire_date: fmtDate(r[col('到職日期')]),
      resign_date: fmtDate(r[col('離職日期')]),
      unpaid_leave_date: fmtDate(r[col('留職停薪日')]),
      mgr1: String(r[col('一階主管')] || '').trim(),
      mgr2: String(r[col('二階主管')] || '').trim(),
      job_category: String(r[col('職種名稱')] || '').trim(),
      job_class: String(r[col('職類名稱')] || '').trim(),
    });
  }
  return rows;
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
        `, [period, r.emp_id, r.emp_name, r.dept_code, r.dept_name, r.job_title, r.status,
            r.hire_date, r.resign_date, r.unpaid_leave_date, r.mgr1, r.mgr2,
            inferFactory(r.dept_code), r.job_category, r.job_class]);
        count++;
      }
      await client.query('COMMIT');
      res.json({ ok: true, count, period });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得人員名冊（已過濾）──
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

// ── 手動調整員工廠別＋部門 ──
router.patch('/bonus/roster/:period/:emp_id', async (req, res) => {
  const { period, emp_id } = req.params;
  const { factory, dept_code, dept_name } = req.body;
  try {
    const p = [factory || null];
    const sets = ['factory=$1', 'updated_at=NOW()'];
    let n = 2;
    if (dept_code !== undefined) { sets.push(`dept_code=$${n++}`); p.push(dept_code || null); }
    if (dept_name !== undefined) { sets.push(`dept_name=$${n++}`); p.push(dept_name || null); }
    p.push(period, emp_id);
    await pool.query(`UPDATE staff_roster SET ${sets.join(',')} WHERE period=$${n++} AND emp_id=$${n}`, p);
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
      FROM staff_roster WHERE period=$1 AND status='離職' AND resign_date IS NOT NULL
        AND TO_CHAR(resign_date,'YYYYMM')=$2 ORDER BY dept_code, resign_date
    `, [period, prevPeriod]);
    const newHiresLastMonth = await pool.query(`
      SELECT emp_id, emp_name, dept_name, factory, hire_date, job_title, mgr1
      FROM staff_roster WHERE period=$1 AND hire_date IS NOT NULL
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
    res.json({ summary: summary.rows, resignLastMonth: resignLastMonth.rows, newHiresLastMonth: newHiresLastMonth.rows, unpaidLeave: unpaid.rows, prevPeriod });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// 獎金指標設定 CRUD
// ══════════════════════════════════════════════
router.get('/bonus/metrics', async (req, res) => {
  try {
    res.json((await pool.query(`SELECT * FROM bonus_metrics ORDER BY sort_order, id`)).rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/bonus/metrics', async (req, res) => {
  const { metric_name, description, scope_type, scope_value, metric_source,
          filters, stat_field, unit, sort_order, bonus_rule, target_dept_codes } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(`
      INSERT INTO bonus_metrics
        (metric_name,description,scope_type,scope_value,metric_source,
         filters,stat_field,unit,sort_order,target_dept_codes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [metric_name.trim(), description||'', scope_type||'person', scope_value||'',
        metric_source||'manual', JSON.stringify(filters||[]),
        stat_field||'amount', unit||'', sort_order||0, JSON.stringify(target_dept_codes||[])]);
    if (bonus_rule) {
      await pool.query(`UPDATE bonus_metrics SET bonus_rule=$1 WHERE id=$2`, [JSON.stringify(bonus_rule), r.rows[0].id]);
    }
    const updated = await pool.query(`SELECT * FROM bonus_metrics WHERE id=$1`, [r.rows[0].id]);
    res.json(updated.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/bonus/metrics/:id', async (req, res) => {
  const { metric_name, description, scope_type, scope_value, metric_source,
          filters, stat_field, unit, sort_order, bonus_rule, target_dept_codes } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    await pool.query(`
      UPDATE bonus_metrics SET
        metric_name=$1, description=$2, scope_type=$3, scope_value=$4,
        metric_source=$5, filters=$6, stat_field=$7, unit=$8, sort_order=$9,
        target_dept_codes=$10, updated_at=NOW()
      WHERE id=$11
    `, [metric_name.trim(), description||'', scope_type||'person', scope_value||'',
        metric_source||'manual', JSON.stringify(filters||[]),
        stat_field||'amount', unit||'', sort_order||0,
        JSON.stringify(target_dept_codes||[]), req.params.id]);
    if (bonus_rule !== undefined) {
      await pool.query(`UPDATE bonus_metrics SET bonus_rule=$1 WHERE id=$2`, [JSON.stringify(bonus_rule), req.params.id]);
    }
    const updated = await pool.query(`SELECT * FROM bonus_metrics WHERE id=$1`, [req.params.id]);
    if (!updated.rows.length) return res.status(404).json({ error: '找不到指標' });
    res.json(updated.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bonus/metrics/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM bonus_targets WHERE metric_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM bonus_metrics WHERE id=$1`, [req.params.id]);
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
       FROM bonus_targets bt JOIN bonus_metrics bm ON bm.id=bt.metric_id
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
// ── period      = 獎金月份：名冊來源、目標設定的依據
// ── actualPeriod = 實績月份：DMS 數據來源（通常 = 上個月）
// ══════════════════════════════════════════════

// 從 target_dept_codes 推算所屬分館（用於實績過濾）
function inferBranchFromDeptCodes(deptCodes) {
  if (!deptCodes || !deptCodes.length) return null;
  const prefixes = { '051': 'AMA', '053': 'AMC', '054': 'AMD' };
  const branches = new Set();
  for (const code of deptCodes) {
    for (const [prefix, br] of Object.entries(prefixes)) {
      if (String(code).startsWith(prefix)) { branches.add(br); break; }
    }
  }
  // 只有唯一分館時才回傳，多分館或無法判斷回傳 null
  return branches.size === 1 ? [...branches][0] : null;
}

router.get('/bonus/progress', async (req, res) => {
  const { period, factory, data_period } = req.query;
  const actualPeriod = data_period || period;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const metrics = (await pool.query(`SELECT * FROM bonus_metrics ORDER BY sort_order, id`)).rows;
    // 目標不分月（取最新設定），避免因期間不符而找不到目標
    // 使用 DISTINCT ON 取每個 metric+emp+dept 的最新一筆
    const targets = (await pool.query(`
      SELECT DISTINCT ON (metric_id, COALESCE(emp_id,''), COALESCE(dept_code,''))
        *
      FROM bonus_targets
      ORDER BY metric_id, COALESCE(emp_id,''), COALESCE(dept_code,''), updated_at DESC
    `)).rows;
    const results = [];

    for (const m of metrics) {
      const filters   = m.filters || [];
      const deptCodes = m.target_dept_codes || [];
      let actual = null;
      let perfTarget = null;

      // ── 從 factory 查詢參數或 target_dept_codes 推算分館 ──
      const branchOverride = filters.find(f => f.type === 'branch_override')?.value || null;
      const effectiveBranch = branchOverride ||
        (factory && ['AMA','AMC','AMD'].includes(factory)
        ? factory
        : inferBranchFromDeptCodes(deptCodes));

      // ── 連結營收目標 ──
      if (m.metric_source === 'revenue') {
        const revBranchF = filters.find(f=>f.type==='branch')?.value || null;
        const revType    = filters.find(f=>f.type==='revenue_type')?.value || 'paid';
        // 分館優先級：effectiveBranch（廠別篩選/dept推算）> revBranchF（指標設定的branch filter）
        const useBranch  = effectiveBranch || revBranchF;
        try {
          actual     = await computeRevenueActual(actualPeriod, useBranch, revType); // 實績用 actualPeriod
          perfTarget = await getRevenueTarget(period, useBranch, revType);           // 目標用 period
        } catch(e) { actual = null; }
      
        

      // ── 連結業績指標 ──
      } else if (m.metric_source === 'performance') {
        const perfMetricId = filters.find(f => f.type === 'perf_metric_id')?.value;
        if (perfMetricId) {
          try {
            const perfMetric = (await pool.query(`SELECT * FROM performance_metrics WHERE id=$1`, [perfMetricId])).rows[0];
            if (perfMetric) {
              // 實績用 actualPeriod + 推算分館
              actual = await computePerfActual(perfMetric, actualPeriod, effectiveBranch);
              // 目標用 period；分館優先用 effectiveBranch，否則抓 AMA/AMC/AMD 合計
              if (effectiveBranch) {
                const tRes = await pool.query(
                  `SELECT target_value FROM performance_targets WHERE metric_id=$1 AND period=$2 AND branch=$3`,
                  [perfMetricId, period, effectiveBranch]
                );
                perfTarget = parseFloat(tRes.rows[0]?.target_value || 0) || null;
              } else {
                // 集團合計：加總所有分館
                const tRes = await pool.query(
                  `SELECT COALESCE(SUM(target_value),0) AS v FROM performance_targets WHERE metric_id=$1 AND period=$2`,
                  [perfMetricId, period]
                );
                perfTarget = parseFloat(tRes.rows[0]?.v || 0) || null;
              }
            }
          } catch(e) { actual = null; }
        }

      // ── DMS 直接來源 ──
      } else if (m.metric_source !== 'manual') {
        const branchF = effectiveBranch;
        try {
          if (m.metric_source === 'repair_income') {
            const acTypes = filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const conds = [`period=$1`]; const p = [actualPeriod]; let idx=2;
            if (branchF) { conds.push(`branch=$${idx++}`); p.push(branchF); }
            if (acTypes.length) { conds.push(`account_type=ANY($${idx++})`); p.push(acTypes); }
            const fld = m.stat_field==='count' ? 'COUNT(DISTINCT work_order)' : 'SUM(total_untaxed)';
            actual = parseFloat((await pool.query(`SELECT COALESCE(${fld},0) AS v FROM repair_income WHERE ${conds.join(' AND ')}`, p)).rows[0]?.v || 0);
          } else if (m.metric_source === 'tech_wage') {
            const conds = [`period=$1`]; const p = [actualPeriod]; let idx=2;
            if (branchF) { conds.push(`branch=$${idx++}`); p.push(branchF); }
            const workCodes = filters.filter(f=>f.type==='work_code').map(f=>f.value);
            for (const wc of workCodes) {
              if (wc.includes('-')) { const [fr,to]=wc.split('-'); conds.push(`work_code BETWEEN $${idx++} AND $${idx++}`); p.push(fr.trim(),to.trim()); }
              else { conds.push(`work_code=$${idx++}`); p.push(wc); }
            }
            const fld = m.stat_field==='amount'?'SUM(wage)':m.stat_field==='hours'?'SUM(standard_hours)':'COUNT(DISTINCT work_order)';
            actual = parseFloat((await pool.query(`SELECT COALESCE(${fld},0) AS v FROM tech_performance WHERE ${conds.join(' AND ')}`, p)).rows[0]?.v || 0);
} else if (m.metric_source === 'tech_hours') {
        // 從 tech_performance 計算工時（與 techHours.js 同邏輯，折扣還原）
        const deptTypes = filters.filter(f=>f.type==='dept_type').map(f=>f.value);
        const acTypes   = filters.filter(f=>f.type==='account_type').map(f=>f.value);
        // 取產能設定裡的時薪
        let hourlyRates = { engine:2150, bodywork:1450, paint:1450, beauty:2150 };
        try {
          const cfgRes = await pool.query(`SELECT value FROM app_settings WHERE key='tech_capacity_config'`);
          if (cfgRes.rows[0]?.value) {
            const cfg = JSON.parse(cfgRes.rows[0].value);
            if (cfg.hourly_rates) hourlyRates = { ...hourlyRates, ...cfg.hourly_rates };
          }
        } catch(e) {}
        // 折扣還原工資 SQL 片段
        const restoreWage = `CASE WHEN discount IS NOT NULL AND discount > 0 AND discount < 1 THEN wage / NULLIF(discount,0) WHEN discount IS NOT NULL AND discount >= 1 AND discount < 100 THEN wage / NULLIF(discount/100.0,0) ELSE wage END`;
        const DEPT_PATTERNS = { engine:['引擎'], bodywork:['鈑金'], paint:['烤漆','噴漆'], beauty:['美容'] };
        const brF = effectiveBranch;
        try {
          let totalActual = 0;
          const BRANCHES = brF ? [brF] : ['AMA','AMC','AMD'];
          for (const br of BRANCHES) {
            if (deptTypes.length) {
              // 依科別篩選人員 + 各科時薪換算
              const rosterPeriodRes = await pool.query(`SELECT DISTINCT period FROM staff_roster ORDER BY period DESC LIMIT 1`);
              const rp = rosterPeriodRes.rows[0]?.period;
              for (const dt of deptTypes) {
                const patterns = DEPT_PATTERNS[dt] || [];
                const dtRate   = parseFloat(hourlyRates[dt] || 2150);
                if (!rp || !patterns.length) continue;
                const rosterRes = await pool.query(
                  `SELECT emp_name FROM staff_roster WHERE period=$1 AND (factory=$2 OR factory IS NULL) AND (${patterns.map((_,i)=>`dept_name ILIKE $${i+3}`).join(' OR ')}) AND COALESCE(job_category,'') NOT ILIKE '%計時%' AND status!='離職'`,
                  [rp, br, ...patterns.map(p=>`%${p}%`)]
                );
                const techNames = rosterRes.rows.map(r=>r.emp_name).filter(Boolean);
                if (!techNames.length) continue;
                const conds=[`period=$1`,`branch=$2`,`tech_name_clean=ANY($3)`];
                const p=[actualPeriod, br, techNames]; let idx=4;
                if (acTypes.length){conds.push(`account_type=ANY($${idx++})`);p.push(acTypes);}
                let expr;
                if (m.stat_field==='hours'){
                  expr=`SUM(ROUND((${restoreWage}/${dtRate})::numeric,2))`;
                } else if (m.stat_field==='count'){
                  expr=`COUNT(DISTINCT work_order)`;
                } else {
                  expr=`SUM(${restoreWage})`;
                }
                const r = await pool.query(`SELECT COALESCE(${expr},0) AS v FROM tech_performance WHERE ${conds.join(' AND ')}`, p);
                totalActual += parseFloat(r.rows[0]?.v || 0);
              }
            } else {
              // 不限科別，全廠技師，用引擎時薪
              const dtRate = parseFloat(hourlyRates.engine || 2150);
              const conds=[`period=$1`,`branch=$2`]; const p=[actualPeriod,br]; let idx=3;
              if (acTypes.length){conds.push(`account_type=ANY($${idx++})`);p.push(acTypes);}
              let expr = m.stat_field==='hours'?`SUM(ROUND((${restoreWage}/${dtRate})::numeric,2))`:m.stat_field==='count'?'COUNT(DISTINCT work_order)':`SUM(${restoreWage})`;
              const r = await pool.query(`SELECT COALESCE(${expr},0) AS v FROM tech_performance WHERE ${conds.join(' AND ')}`, p);
              totalActual += parseFloat(r.rows[0]?.v || 0);
            }
          }
actual = totalActual;
        } catch(e) { actual = null; }

        // ── 自動計算工時目標（roster × 利用率 × 工作天）──
        try {
          const cfgR = await pool.query(`SELECT value FROM app_settings WHERE key='tech_capacity_config'`);
          const tCfg = cfgR.rows[0]?.value ? JSON.parse(cfgR.rows[0].value) : {};
          const utilR    = tCfg.utilization_rates    || {};
          const resignOk = tCfg.resigned_count_target === true;

          const rpR2  = await pool.query(`SELECT DISTINCT period FROM staff_roster ORDER BY period DESC LIMIT 1`);
          const rp2   = rpR2.rows[0]?.period;
          const pSt2  = `${actualPeriod.slice(0,4)}-${actualPeriod.slice(4,6)}-01`;
          const BRS2  = brF ? [brF] : ['AMA','AMC','AMD'];
          let tgtTotal = 0;

          for (const brr of BRS2) {
            let wd = 0;
            const wdR = await pool.query(`SELECT work_dates FROM working_days_config WHERE branch=$1 AND period=$2`, [brr, actualPeriod]);
            if (wdR.rows[0]?.work_dates?.length) wd = wdR.rows[0].work_dates.length;
            else {
              const r2 = await pool.query(`SELECT COUNT(DISTINCT open_time::date) AS cnt FROM business_query WHERE period=$1 AND branch=$2 AND open_time IS NOT NULL`, [actualPeriod, brr]);
              wd = parseInt(r2.rows[0]?.cnt || 0);
            }
            if (!wd || !rp2) continue;

            if (deptTypes.length) {
              for (const dt of deptTypes) {
                const pats = (DEPT_PATTERNS[dt]||[]).map(p=>`%${p}%`);
                if (!pats.length) continue;
                const tR = await pool.query(
                  `SELECT job_title, status FROM staff_roster WHERE period=$1 AND (factory=$2 OR factory IS NULL) AND (${pats.map((_,i)=>`dept_name ILIKE $${i+3}`).join(' OR ')}) AND COALESCE(job_category,'') NOT ILIKE '%計時%' AND (status!='離職' OR (resign_date IS NOT NULL AND resign_date >= $${pats.length+3}::date))`,
                  [rp2, brr, ...pats, pSt2]
                );
                for (const t2 of tR.rows) {
                  const tRates = utilR[dt] || {};
                  let u = tRates[t2.job_title] !== undefined ? tRates[t2.job_title] : (tRates.default ?? 0.8);
                  if (t2.status === '離職' && !resignOk) u = 0;
                  tgtTotal += wd * 8 * u;
                }
              }
            } else if (deptCodes.length) {
              const tR = await pool.query(
                `SELECT job_title, status FROM staff_roster WHERE period=$1 AND dept_code=ANY($2) AND (factory=$3 OR factory IS NULL) AND COALESCE(job_category,'') NOT ILIKE '%計時%' AND (status!='離職' OR (resign_date IS NOT NULL AND resign_date >= $4::date))`,
                [rp2, deptCodes, brr, pSt2]
              );
              for (const t2 of tR.rows) {
                const tRates = utilR['engine'] || {};
                let u = tRates[t2.job_title] !== undefined ? tRates[t2.job_title] : (tRates.default ?? 0.8);
                if (t2.status === '離職' && !resignOk) u = 0;
                tgtTotal += wd * 8 * u;
              }
            }
          }
          if (tgtTotal > 0) perfTarget = Math.round(tgtTotal * 10) / 10;
        } catch(e) { console.warn('[tech_hours target]', e.message); }

        // ── 手動實績覆蓋 ──
        try {
          const overR = await pool.query(
            `SELECT actual_value FROM bonus_actual_overrides WHERE metric_id=$1 AND period=$2 AND COALESCE(branch,'')=$3 LIMIT 1`,
            [m.id, actualPeriod, effectiveBranch || '']
          );
          if (overR.rows.length && overR.rows[0].actual_value != null)
            actual = parseFloat(overR.rows[0].actual_value);
        } catch(e) {}
      }
      } catch(e) { actual = null; }

      const myTargets = targets.filter(t => t.metric_id === m.id);
      results.push({ metric: m, targets: myTargets, actual, perfTarget, effectiveBranch });
    }
    res.json({ results, period, actualPeriod });
  } catch(err) { res.status(500).json({ error: err.message }); }
);

// ── 可設定目標的人員/部門清單 ──
router.get('/bonus/scope-members', async (req, res) => {
  const { period, scope_type, factory, dept_codes } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  const deptCodesArr = dept_codes ? dept_codes.split(',').map(s=>s.trim()).filter(Boolean) : [];
  const f = activeFilter(period, 2);
  try {
    const p = [period, f.param]; let idx = f.nextIdx;
    let extra = '';
    if (factory)             { extra += ` AND factory=$${idx++}`;           p.push(factory); }
    if (deptCodesArr.length) { extra += ` AND dept_code=ANY($${idx++})`;    p.push(deptCodesArr); }
    if (scope_type === 'dept') {
      const r = await pool.query(`SELECT DISTINCT dept_code, dept_name, factory FROM staff_roster WHERE period=$1 ${f.cond} ${extra} ORDER BY dept_code`, p);
      res.json(r.rows);
    } else {
      const r = await pool.query(`SELECT emp_id, emp_name, dept_code, dept_name, factory, job_title, mgr1 FROM staff_roster WHERE period=$1 ${f.cond} ${extra} ORDER BY dept_code, emp_id`, p);
      res.json(r.rows);
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得部門清單 ──
router.get('/bonus/departments', async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  const f = activeFilter(period, 2);
  try {
    const r = await pool.query(`SELECT DISTINCT dept_code, dept_name, factory FROM staff_roster WHERE period=$1 ${f.cond} ORDER BY factory NULLS LAST, dept_code`, [period, f.param]);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 手動實績覆蓋 CRUD ──
router.get('/bonus/actual-override', async (req, res) => {
  const { metric_id, period, branch } = req.query;
  if (!metric_id || !period) return res.status(400).json({ error: '參數不完整' });
  try {
    const r = await pool.query(
      `SELECT * FROM bonus_actual_overrides WHERE metric_id=$1 AND period=$2 AND COALESCE(branch,'')=$3`,
      [metric_id, period, branch || '']
    );
    res.json(r.rows[0] || null);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/bonus/actual-override', async (req, res) => {
  const { metric_id, period, branch, actual_value, note } = req.body;
  if (!metric_id || !period) return res.status(400).json({ error: '參數不完整' });
  try {
    await pool.query(`
      INSERT INTO bonus_actual_overrides (metric_id, period, branch, actual_value, note, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (metric_id, period, COALESCE(branch,''))
      DO UPDATE SET actual_value=$4, note=$5, updated_at=NOW()
    `, [metric_id, period, branch||'', actual_value!=null?parseFloat(actual_value):null, note||'']);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bonus/actual-override', async (req, res) => {
  const { metric_id, period, branch } = req.query;
  if (!metric_id || !period) return res.status(400).json({ error: '參數不完整' });
  try {
    await pool.query(
      `DELETE FROM bonus_actual_overrides WHERE metric_id=$1 AND period=$2 AND COALESCE(branch,'')=$3`,
      [metric_id, period, branch||'']
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
