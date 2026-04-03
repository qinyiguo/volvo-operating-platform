const router = require('express').Router();
const pool   = require('../db/pool');

// ── 取得人員清單（由 DMS 資料推算，依指標類型）──
router.get('/person-targets/persons', async (req, res) => {
  const { metric_id, period, branch } = req.query;
  if (!metric_id || !period || !branch) return res.status(400).json({ error: '參數不完整' });
  try {
    const metric = (await pool.query('SELECT * FROM performance_metrics WHERE id=$1', [metric_id])).rows[0];
    if (!metric) return res.status(404).json({ error: '找不到指標' });
    let persons = [];
    if (['repair_income','repair_subfield'].includes(metric.metric_type)) {
      const r = await pool.query(
        `SELECT DISTINCT service_advisor AS person_name
         FROM repair_income
         WHERE period=$1 AND branch=$2 AND service_advisor IS NOT NULL AND service_advisor!=''
         ORDER BY service_advisor`, [period, branch]);
      persons = r.rows.map(r => r.person_name);
    } else if (['parts','boutique'].includes(metric.metric_type)) {
      const r = await pool.query(
        `SELECT DISTINCT sales_person AS person_name
         FROM parts_sales
         WHERE period=$1 AND branch=$2 AND sales_person IS NOT NULL AND sales_person!=''
         ORDER BY sales_person`, [period, branch]);
      persons = r.rows.map(r => r.person_name);
    } else if (metric.metric_type === 'tech_wage') {
      const r = await pool.query(
        `SELECT DISTINCT tech_name_clean AS person_name
         FROM tech_performance
         WHERE period=$1 AND branch=$2 AND tech_name_clean IS NOT NULL AND tech_name_clean!=''
         ORDER BY tech_name_clean`, [period, branch]);
      persons = r.rows.map(r => r.person_name);
    }
    res.json(persons);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 取得已設定的個人目標 ──
router.get('/person-targets', async (req, res) => {
  const { metric_id, period, branch, fallback_last_month } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (metric_id) { conds.push(`metric_id=$${idx++}`); params.push(metric_id); }
    if (period)    { conds.push(`period=$${idx++}`);    params.push(period); }
    if (branch)    { conds.push(`branch=$${idx++}`);    params.push(branch); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    let rows = (await pool.query(
      `SELECT * FROM person_metric_targets ${where} ORDER BY person_name`, params
    )).rows;

    // ★ 若當月無資料且有 fallback 參數，自動帶入上月權重（target_value 清空）
    if (!rows.length && fallback_last_month === '1' && metric_id && period && branch) {
      const y = parseInt(period.slice(0, 4));
      const m = parseInt(period.slice(4));
      const lastPeriod = m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, '0')}`;
      const lastRows = (await pool.query(
        `SELECT * FROM person_metric_targets WHERE metric_id=$1 AND period=$2 AND branch=$3 ORDER BY person_name`,
        [metric_id, lastPeriod, branch]
      )).rows;
      // 標記為 fallback，target_value 清空
      rows = lastRows.map(r => ({ ...r, period, target_value: null, _from_last_month: true }));
    }

    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 批次儲存個人目標 ──
router.put('/person-targets/batch', async (req, res) => {
  const { metric_id, period, branch, entries } = req.body;
  if (!metric_id || !period || !branch || !Array.isArray(entries))
    return res.status(400).json({ error: '參數不完整' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM person_metric_targets WHERE metric_id=$1 AND period=$2 AND branch=$3',
      [metric_id, period, branch]
    );
    for (const e of entries) {
      if (!e.person_name?.trim()) continue;
      await client.query(
        `INSERT INTO person_metric_targets
           (metric_id,period,branch,person_name,weight,target_value,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [metric_id, period, branch, e.person_name.trim(),
         e.weight ?? null, e.target_value ?? null, e.note || '']
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: entries.length });
  } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// ── 刪除整組（metric+period+branch）──
router.delete('/person-targets', async (req, res) => {
  const { metric_id, period, branch } = req.query;
  if (!metric_id || !period || !branch) return res.status(400).json({ error: '參數不完整' });
  try {
    await pool.query(
      'DELETE FROM person_metric_targets WHERE metric_id=$1 AND period=$2 AND branch=$3',
      [metric_id, period, branch]
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 個人業績達成率統計 ──
router.get('/stats/person-performance', async (req, res) => {
  const { metric_id, period, branch } = req.query;
  if (!metric_id || !period || !branch) return res.status(400).json({ error: '參數不完整' });
  try {
    const metric = (await pool.query('SELECT * FROM performance_metrics WHERE id=$1', [metric_id])).rows[0];
    if (!metric) return res.status(404).json({ error: '找不到指標' });

    // 廠別目標
    const tRes = await pool.query(
      'SELECT target_value FROM performance_targets WHERE metric_id=$1 AND period=$2 AND branch=$3',
      [metric_id, period, branch]
    );
    const branchTarget = parseFloat(tRes.rows[0]?.target_value || 0);

    // 個人目標設定
    const ptRes = await pool.query(
      'SELECT * FROM person_metric_targets WHERE metric_id=$1 AND period=$2 AND branch=$3',
      [metric_id, period, branch]
    );
    const ptMap = {};
    ptRes.rows.forEach(r => { ptMap[r.person_name] = r; });

    // 計算每人實績
    const filters = metric.filters || [];
    let persons = [];

    if (metric.metric_type === 'sa_config') {
      // 從 sa_sales_config 取 work_code filters，JOIN tech_performance + repair_income 取 SA 實績
      const saConfigRes = await pool.query(
        'SELECT * FROM sa_sales_config WHERE config_name=$1 LIMIT 1', [metric.metric_name]
      );
      if (saConfigRes.rows.length) {
        const saConfig = saConfigRes.rows[0];
        const scFilters = saConfig.filters || [];
        const workCodes = scFilters.filter(f => f.type === 'work_code');
        const acTypes   = scFilters.filter(f => f.type === 'account_type').map(f => f.value);
        const statMethod = saConfig.stat_method || 'amount';
        const selectExpr = statMethod === 'count' ? 'COUNT(*)' : statMethod === 'qty' ? 'SUM(tp.standard_hours)' : 'SUM(tp.wage)';
        const personType = saConfig.person_type || 'sales_person';
        const groupField = personType === 'tech_name_clean' ? 'tp.tech_name_clean' : 'ri.service_advisor';
        const conds  = [`tp.period=$1`, `tp.branch=$2`, `${groupField} IS NOT NULL`, `${groupField}!=''`];
        const params = [period, branch]; let idx = 3;
        if (acTypes.length) { conds.push(`tp.account_type=ANY($${idx++})`); params.push(acTypes); }
        const wcConds = [];
        for (const wc of workCodes) {
          if (wc.value && wc.value.includes('-')) {
            const [f, t] = wc.value.split('-');
            wcConds.push(`(tp.work_code BETWEEN $${idx++} AND $${idx++})`);
            params.push(f.trim(), t.trim());
          } else if (wc.value) {
            wcConds.push(`tp.work_code=$${idx++}`);
            params.push(wc.value);
          }
        }
        if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
        const joinClause = personType !== 'tech_name_clean'
          ? 'LEFT JOIN repair_income ri ON tp.work_order=ri.work_order AND tp.period=ri.period AND tp.branch=ri.branch'
          : '';
        const sql = `SELECT ${groupField} AS person_name, COALESCE(${selectExpr},0) AS actual FROM tech_performance tp ${joinClause} WHERE ${conds.join(' AND ')} GROUP BY ${groupField} ORDER BY actual DESC`;
        const r = await pool.query(sql, params);
        persons = r.rows;
      }

    } else if (['repair_income','repair_subfield'].includes(metric.metric_type)) {
      const acTypes = filters.filter(f=>f.type==='account_type').map(f=>f.value);
      const conds = [`period=$1`,`branch=$2`,`service_advisor IS NOT NULL`,`service_advisor!=''`];
      const params = [period, branch]; let idx = 3;
      if (acTypes.length) { conds.push(`account_type=ANY($${idx++})`); params.push(acTypes); }

      let selectExpr = 'SUM(total_untaxed)';
      if (metric.metric_type === 'repair_subfield') {
        const VALID = new Set(['bodywork_income','paint_income','engine_wage','parts_income',
          'accessories_income','boutique_income','carwash_income','outsource_income','addon_income','total_untaxed','parts_cost']);
        const subfields = filters.filter(f=>f.type==='subfield'&&VALID.has(f.value)).map(f=>f.value);
        const woMode = filters.find(f=>f.type==='wo_mode')?.value||'sum';
        if (subfields.length) {
          if (woMode==='wo_has') {
            const hasCond = subfields.map(c=>`COALESCE(${c},0)>0`).join(' OR ');
            selectExpr = `SUM(CASE WHEN (${hasCond}) THEN total_untaxed ELSE 0 END)`;
          } else if (woMode==='wo_exclude') {
            const excCond = subfields.map(c=>`COALESCE(${c},0)=0`).join(' AND ');
            selectExpr = `SUM(CASE WHEN (${excCond}) THEN total_untaxed ELSE 0 END)`;
          } else {
            selectExpr = `SUM(${subfields.map(c=>`COALESCE(${c},0)`).join('+')})`;
          }
        }
      }
      const r = await pool.query(
        `SELECT service_advisor AS person_name, COALESCE(${selectExpr},0) AS actual
         FROM repair_income WHERE ${conds.join(' AND ')}
         GROUP BY service_advisor ORDER BY actual DESC`, params);
      persons = r.rows;

    } else if (metric.metric_type === 'parts') {
      const cc=filters.filter(f=>f.type==='category_code').map(f=>f.value);
      const fc=filters.filter(f=>f.type==='function_code').map(f=>f.value);
      const pn=filters.filter(f=>f.type==='part_number').map(f=>f.value);
      const pt=filters.filter(f=>f.type==='part_type').map(f=>f.value);
      const conds=[`period=$1`,`branch=$2`,`sales_person IS NOT NULL`,`sales_person!=''`];
      const params=[period,branch]; let idx=3;
      if(cc.length){conds.push(`category_code=ANY($${idx++})`);params.push(cc);}
      if(fc.length){conds.push(`function_code=ANY($${idx++})`);params.push(fc);}
      if(pn.length){conds.push(`part_number=ANY($${idx++})`);params.push(pn);}
      if(pt.length){conds.push(`part_type=ANY($${idx++})`);params.push(pt);}
      const fld = metric.stat_field==='qty'?'SUM(sale_qty)':metric.stat_field==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
      const r = await pool.query(
        `SELECT sales_person AS person_name, COALESCE(${fld},0) AS actual
         FROM parts_sales WHERE ${conds.join(' AND ')}
         GROUP BY sales_person ORDER BY actual DESC`, params);
      persons = r.rows;

    } else if (metric.metric_type === 'boutique') {
      const bt=filters.filter(f=>f.type==='boutique_type').map(f=>f.value);
      const ac=filters.filter(f=>f.type==='account_type').map(f=>f.value);
      const conds=[`ps.period=$1`,`ps.branch=$2`,`ps.sales_person IS NOT NULL`,`ps.sales_person!=''`];
      const params=[period,branch]; let idx=3;
      if(bt.length){conds.push(`pc.part_type=ANY($${idx++})`);params.push(bt);}
      else conds.push(`pc.part_type IN ('精品','配件')`);
      if(ac.length){conds.push(`ps.part_type=ANY($${idx++})`);params.push(ac);}
      const r = await pool.query(
        `SELECT ps.sales_person AS person_name, COALESCE(SUM(ps.sale_price_untaxed),0) AS actual
         FROM parts_sales ps JOIN parts_catalog pc ON ps.part_number=pc.part_number
         WHERE ${conds.join(' AND ')}
         GROUP BY ps.sales_person ORDER BY actual DESC`, params);
      persons = r.rows;

    } else if (metric.metric_type === 'tech_wage') {
      const workCodes=filters.filter(f=>f.type==='work_code');
      const acTypes=filters.filter(f=>f.type==='account_type').map(f=>f.value);
      const conds=[`period=$1`,`branch=$2`,`tech_name_clean IS NOT NULL`,`tech_name_clean!=''`];
      const params=[period,branch]; let idx=3;
      if(acTypes.length){conds.push(`account_type=ANY($${idx++})`);params.push(acTypes);}
      for(const wc of workCodes){
        if(wc.value.includes('-')){const[f,t]=wc.value.split('-');conds.push(`work_code BETWEEN $${idx++} AND $${idx++}`);params.push(f.trim(),t.trim());}
        else{conds.push(`work_code=$${idx++}`);params.push(wc.value);}
      }
      const stat = metric.stat_field==='amount'?'SUM(wage)':metric.stat_field==='hours'?'SUM(standard_hours)':'COUNT(DISTINCT work_order)';
      const r = await pool.query(
        `SELECT tech_name_clean AS person_name, COALESCE(${stat},0) AS actual
         FROM tech_performance WHERE ${conds.join(' AND ')}
         GROUP BY tech_name_clean ORDER BY actual DESC`, params);
      persons = r.rows;
    }

    // 合併人員清單（DMS有的 + 設了目標的）
    const allNames = [...new Set([
      ...persons.map(p=>p.person_name),
      ...Object.keys(ptMap),
    ])];

    const result = allNames.map(name => {
      const pt = ptMap[name] || {};
      const actualRow = persons.find(p=>p.person_name===name);
      const actual = parseFloat(actualRow?.actual || 0);
      const weight = pt.weight != null ? parseFloat(pt.weight) : null;  // stored 0~1
      // priority: direct target > weight-based > null
      const personalTarget = pt.target_value != null
        ? parseFloat(pt.target_value)
        : (weight !== null && branchTarget > 0 ? branchTarget * weight : null);
      const achieveRate = personalTarget && personalTarget > 0
        ? parseFloat((actual / personalTarget * 100).toFixed(2))
        : null;
      return {
        person_name:     name,
        actual,
        weight,
        target_value:    pt.target_value != null ? parseFloat(pt.target_value) : null,
        personal_target: personalTarget,
        achieve_rate:    achieveRate,
        note:            pt.note || '',
        has_dms_data:    !!actualRow,
      };
    }).sort((a,b) => (b.actual||0) - (a.actual||0));

    res.json({ metric, branchTarget, persons: result, period, branch });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 跨廠彙整（全部據點一次回傳）──
router.get('/stats/person-performance-all', async (req, res) => {
  const { metric_id, period } = req.query;
  if (!metric_id || !period) return res.status(400).json({ error: '參數不完整' });
  try {
    const results = await Promise.all(['AMA','AMC','AMD'].map(branch =>
      fetch(`http://localhost:${process.env.PORT||3001}/api/stats/person-performance?metric_id=${metric_id}&period=${period}&branch=${branch}`)
        .then(r=>r.json()).catch(()=>({ branch, error:'fetch error', persons:[] }))
    ));
    res.json(results);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 複製上月權重設定到當月 ──
router.post('/person-targets/copy-from-last-month', async (req, res) => {
  const { metric_id, period, branch } = req.body;
  if (!metric_id || !period || !branch)
    return res.status(400).json({ error: '參數不完整' });

  // 計算上月 period
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4));
  const lastPeriod = m === 1
    ? `${y - 1}12`
    : `${y}${String(m - 1).padStart(2, '0')}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 確認當月是否已有資料
    const existing = await client.query(
      'SELECT COUNT(*) AS cnt FROM person_metric_targets WHERE metric_id=$1 AND period=$2 AND branch=$3',
      [metric_id, period, branch]
    );
    if (parseInt(existing.rows[0].cnt) > 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: false, message: '當月已有設定，未覆蓋', skipped: true });
    }

    // 複製上月資料（只複製 weight，不複製 target_value，因為每月目標金額不同）
    const lastMonthRows = await client.query(
      'SELECT * FROM person_metric_targets WHERE metric_id=$1 AND period=$2 AND branch=$3',
      [metric_id, lastPeriod, branch]
    );
    if (!lastMonthRows.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: false, message: `${lastPeriod} 無資料可複製`, count: 0 });
    }

    for (const r of lastMonthRows.rows) {
      await client.query(
        `INSERT INTO person_metric_targets
           (metric_id, period, branch, person_name, weight, target_value, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (metric_id, period, branch, person_name) DO NOTHING`,
        [metric_id, period, branch, r.person_name,
         r.weight, null /* target_value 不複製 */, r.note || '']
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, count: lastMonthRows.rows.length, from: lastPeriod, to: period });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
