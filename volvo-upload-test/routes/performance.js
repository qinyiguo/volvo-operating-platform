/**
 * routes/performance.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 業績指標定義與月目標管理。performance.html / settings.html 使用。
 *
 *   GET    /api/performance-metrics            指標定義列表
 *   POST   /api/performance-metrics            (feature:targets)
 *   PUT    /api/performance-metrics/:id        (feature:targets)
 *   DELETE /api/performance-metrics/:id        (feature:targets)
 *   GET    /api/performance-targets            各指標月目標與去年實績
 *   PUT    /api/performance-targets/batch      (feature:targets) 批次寫入
 *   POST   /api/upload-performance-targets-native  (feature:upload) 原生 Excel 匯入
 */
const router = require('express').Router();
const multer = require('multer');
const XLSX   = require('xlsx');
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');
const { checkPeriodLock, checkBatchPeriodLock } = require('../lib/bonusPeriodLock');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireAuth);

// ── 業績指標 CRUD ──
router.get('/performance-metrics', async (req, res) => {
  try { res.json((await pool.query(`SELECT * FROM performance_metrics ORDER BY sort_order, id`)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/performance-metrics', requirePermission('feature:perf_metric_edit'), async (req, res) => {
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

router.put('/performance-metrics/:id', requirePermission('feature:perf_metric_edit'), async (req, res) => {
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

router.delete('/performance-metrics/:id', requirePermission('feature:perf_metric_edit'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM performance_targets WHERE metric_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM performance_metrics WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 業績目標 ──
router.get('/performance-targets', async (req, res) => {
  const { metric_id, period } = req.query;
  try {
    const conds = []; const params = []; let idx = 1;
    if (metric_id) { conds.push(`metric_id=$${idx++}`); params.push(metric_id); }
    if (period)    { conds.push(`period=$${idx++}`);    params.push(period); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json((await pool.query(`SELECT * FROM performance_targets ${where} ORDER BY branch`, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/performance-targets/batch', requirePermission('feature:perf_target_edit'), async (req, res) => {
  const { metric_id, period, entries } = req.body;
  if (!metric_id || !period || !Array.isArray(entries)) return res.status(400).json({ error: '參數不完整' });
  if (checkPeriodLock(period, res, req)) return;
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

// ── 業績目標 Excel 匯入 ──
router.post('/upload-performance-targets-native', requirePermission('feature:upload_targets'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  const year     = String(req.body.year || '').trim();
  const dataType = String(req.body.dataType || 'target').trim();
  if (!year.match(/^\d{4}$/)) return res.status(400).json({ error: '請指定正確的年份' });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, cellNF: true, cellText: false });
    const SHEET_KWS = ['目標','年度','銷售','實績'];
    let sheetName = workbook.SheetNames[0];
    for (const sn of workbook.SheetNames) {
      if (SHEET_KWS.some(kw => sn.includes(kw))) { sheetName = sn; break; }
    }
    const sheet = workbook.Sheets[sheetName];

    const objRows       = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    const firstRowKeys  = objRows.length ? Object.keys(objRows[0]) : [];
    const isFlatFormat  =
      firstRowKeys.some(k => k === '期間' || k === 'Period') &&
      firstRowKeys.some(k => k === '據點' || k === 'Branch');

    // ── 扁平格式 ──
    if (isFlatFormat) {
      const headers      = firstRowKeys;
      const targetCols   = headers.filter(h => h.endsWith('_目標'));
      const lastYearCols = headers.filter(h => h.endsWith('_去年'));
      const allMetricNames = [...new Set([
        ...targetCols.map(h => h.replace(/_目標$/, '')),
        ...lastYearCols.map(h => h.replace(/_去年$/, '')),
      ])];

      if (!allMetricNames.length) {
        return res.status(400).json({
          error: '找不到指標欄位，欄位名稱需以 _目標 或 _去年 結尾',
          debug: { sampleHeaders: headers.slice(0, 8) },
        });
      }

      const BRANCHES  = ['AMA', 'AMC', 'AMD'];
      const entriesMap = {};
      allMetricNames.forEach(m => { entriesMap[m] = {}; });

      for (const row of objRows) {
        const rawPeriod = String(row['期間'] || row['Period'] || '').trim().replace(/\D/g, '');
        const rawBranch = String(row['據點'] || row['Branch'] || '').trim().toUpperCase();
        if (rawPeriod.length !== 6 || !BRANCHES.includes(rawBranch)) continue;
        for (const metricName of allMetricNames) {
          const tv  = parseFloat(String(row[`${metricName}_目標`] ?? '').replace(/,/g, ''));
          const ly  = parseFloat(String(row[`${metricName}_去年`] ?? '').replace(/,/g, ''));
          const key = `${rawBranch}|||${rawPeriod}`;
          entriesMap[metricName][key] = {
            branch: rawBranch, period: rawPeriod,
            target_value:    isNaN(tv) ? null : tv,
            last_year_value: isNaN(ly) ? null : ly,
          };
        }
      }

      const totalEntries = Object.values(entriesMap).reduce((s, m) => s + Object.keys(m).length, 0);
      if (!totalEntries) return res.status(400).json({ error: '找不到有效資料列，請確認期間格式（例：202601）和據點（AMA/AMC/AMD）' });

      // 檔案內任一 period 已鎖定 → 整批拒絕（super_admin 除外）
      const flatPeriods = Object.values(entriesMap).flatMap(rm => Object.values(rm).map(e => e.period));
      if (checkBatchPeriodLock(flatPeriods, res, req)) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const createdMetrics = [], existingMetrics = [], metricIdMap = {};
        const strip = s => s.replace(/銷售目標|目標|銷售/g, '').replace(/\s+/g, '').trim();
        const allDbMetrics = (await client.query('SELECT id, metric_name FROM performance_metrics')).rows;
        for (const metricName of allMetricNames) {
          let found = allDbMetrics.find(m => m.metric_name === metricName);
          if (!found) found = allDbMetrics.find(m => strip(m.metric_name) === strip(metricName));
          if (found) {
            metricIdMap[metricName] = found.id; existingMetrics.push(metricName);
          } else {
            const ins = await client.query(
              `INSERT INTO performance_metrics (metric_name, description, metric_type, filters, stat_field, unit)
               VALUES ($1, '', 'parts', '[]', 'amount', '') RETURNING id`, [metricName]
            );
            metricIdMap[metricName] = ins.rows[0].id; createdMetrics.push(metricName);
          }
        }
        let count = 0;
        for (const [metricName, rowMap] of Object.entries(entriesMap)) {
          const metricId = metricIdMap[metricName];
          for (const entry of Object.values(rowMap)) {
            await client.query(`
              INSERT INTO performance_targets (metric_id, branch, period, target_value, last_year_value, updated_at)
              VALUES ($1,$2,$3,$4,$5,NOW())
              ON CONFLICT (metric_id, branch, period) DO UPDATE SET
                target_value    = CASE WHEN $4 IS NOT NULL THEN $4 ELSE performance_targets.target_value END,
                last_year_value = CASE WHEN $5 IS NOT NULL THEN $5 ELSE performance_targets.last_year_value END,
                updated_at      = NOW()
            `, [metricId, entry.branch, entry.period, entry.target_value, entry.last_year_value]);
            count++;
          }
        }
        await client.query('COMMIT');
        const summaryMap = {};
        for (const rowMap of Object.values(entriesMap)) {
          for (const e of Object.values(rowMap)) {
            if (!summaryMap[e.period]) summaryMap[e.period] = new Set();
            summaryMap[e.period].add(e.branch);
          }
        }
        const summary = {};
        Object.entries(summaryMap).forEach(([p, s]) => { summary[p] = [...s].sort(); });
        res.json({ ok: true, count, year, format: 'flat', dataType: 'both',
          metrics: allMetricNames.map(n => ({ name: n, rawTitle: n })),
          created: createdMetrics, existing: existingMetrics, summary });
      } catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
      return;
    }

    // ── 區塊格式 ──
    const valueField = dataType === 'last_year' ? 'last_year_value' : 'target_value';
    const raw        = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    const BRANCHES   = ['AMA','AMC','AMD'];
    const toMonthIndex = (cell) => {
      if (typeof cell === 'number' && cell >= 1 && cell <= 12 && Number.isInteger(cell)) return cell;
      const s = String(cell ?? '').trim();
      const m = s.match(/^([1-9]|1[0-2])月?$/);
      return m ? parseInt(m[1]) : -1;
    };
    const cleanTitle = (title) => String(title)
      .replace(/銷售目標|目標|銷售|（k）|\(k\)|\(K\)|\（K\）/gi, '')
      .replace(/\s+/g, '').trim();

    const data = {};
    let curName = null, monthColIdx = {};
    for (let ri = 0; ri < raw.length; ri++) {
      const row = raw[ri];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
      const monthCells = row.map((c, ci) => ({ mo: toMonthIndex(c), ci })).filter(x => x.mo > 0);
      if (monthCells.length >= 6) { monthColIdx = {}; monthCells.forEach(({ mo, ci }) => { monthColIdx[mo] = ci; }); continue; }
      const isCellEmpty = (v) => v === '' || v === 0 || v === null || v === undefined;
      const firstCell = row[0];
      if (firstCell && typeof firstCell === 'string' && isCellEmpty(row[1]) && isCellEmpty(row[2])) {
        const cleaned = cleanTitle(firstCell);
        if (cleaned.length >= 2) { curName = cleaned; monthColIdx = {}; if (!data[curName]) data[curName] = { rawTitle: String(firstCell).trim(), branches: {} }; continue; }
      }
      if (!curName || Object.keys(monthColIdx).length === 0) continue;
      const branchRaw   = String(row[0] ?? '').trim().toUpperCase();
      const matchedBranch = BRANCHES.find(b => branchRaw === b || branchRaw.endsWith(b));
      if (!matchedBranch) continue;
      if (!data[curName].branches[matchedBranch]) data[curName].branches[matchedBranch] = {};
      for (const [mo, ci] of Object.entries(monthColIdx)) {
        const v = parseFloat(String(row[ci] ?? '').replace(/,/g, ''));
        if (!isNaN(v)) data[curName].branches[matchedBranch][parseInt(mo)] = v;
      }
    }

    if (!Object.keys(data).length) return res.status(400).json({ error: '找不到任何區塊資料，請確認格式（需有標題列＋月份列＋AMA/AMC/AMD資料列）' });

    // 檔案內任一 period (YYYYMM) 已鎖定 → 整批拒絕（super_admin 除外）
    const touchedPeriods = [];
    for (const info of Object.values(data)) {
      for (const branchMap of Object.values(info.branches)) {
        for (const mo of Object.keys(branchMap)) touchedPeriods.push(year + String(mo).padStart(2,'0'));
      }
    }
    if (checkBatchPeriodLock(touchedPeriods, res, req)) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saConfigs  = (await client.query(`SELECT config_name, filters, stat_method FROM sa_sales_config`)).rows;
      const findSaConfig = (metricName) => {
        let match = saConfigs.find(c => c.config_name === metricName);
        if (match) return match;
        return saConfigs.find(c => c.config_name.includes(metricName) || metricName.includes(c.config_name)) || null;
      };
      const findMetricId = async (cleanedName, rawTitle) => {
        let r = await client.query(`SELECT id FROM performance_metrics WHERE metric_name=$1`, [cleanedName]);
        if (r.rows.length) return r.rows[0].id;
        if (rawTitle && rawTitle !== cleanedName) {
          r = await client.query(`SELECT id FROM performance_metrics WHERE metric_name=$1`, [rawTitle]);
          if (r.rows.length) return r.rows[0].id;
        }
        const allMetrics = (await client.query(`SELECT id, metric_name FROM performance_metrics`)).rows;
        const strip = s => s.replace(/銷售目標|目標|銷售/g,'').replace(/\s+/g,'').trim();
        const match = allMetrics.find(m => strip(m.metric_name) === cleanedName || strip(m.metric_name) === strip(cleanedName));
        return match ? match.id : null;
      };

      const createdMetrics = [], createdFromSA = [], metricIdMap = {};
      for (const [name, info] of Object.entries(data)) {
        const existingId = await findMetricId(name, info.rawTitle);
        if (existingId) { metricIdMap[name] = existingId; }
        else {
          const saMatch  = findSaConfig(name);
          const filters  = saMatch ? JSON.stringify(saMatch.filters) : '[]';
          const statField = saMatch ? (saMatch.stat_method === 'quantity' ? 'qty' : saMatch.stat_method === 'count' ? 'count' : 'amount') : 'amount';
          const ins = await client.query(
            `INSERT INTO performance_metrics (metric_name, description, metric_type, filters, stat_field, unit)
             VALUES ($1, '', 'parts', $2, $3, '') RETURNING id`, [name, filters, statField]
          );
          metricIdMap[name] = ins.rows[0].id; createdMetrics.push(name);
          if (saMatch) createdFromSA.push({ name, saName: saMatch.config_name });
        }
      }

      let count = 0;
      for (const [name, info] of Object.entries(data)) {
        const metricId = metricIdMap[name];
        for (const [branch, monthData] of Object.entries(info.branches)) {
          for (const [mo, val] of Object.entries(monthData)) {
            const period     = `${year}${String(mo).padStart(2,'0')}`;
            const storedVal  = Math.round(val);
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
        yearNote: dataType === 'last_year' ? `去年實績已存入 ${year} 年各月的 last_year_value。確認：目標期間也是 ${year} 年？` : null,
        metrics: Object.keys(data).map(n => ({ name: n, rawTitle: data[n].rawTitle })),
        created: createdMetrics, createdFromSA,
        existing: Object.keys(data).filter(n => !createdMetrics.includes(n)),
      });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
