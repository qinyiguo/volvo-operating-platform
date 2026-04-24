/**
 * routes/uploadApproval.js  mount: app.use('/api', ...)
 * -------------------------------------------------------------
 * 上傳簽核申請（僅在「期間已鎖定」的上傳被擋下時使用）。
 *
 * 流程：pending → branch_approved → executed | rejected | withdrawn | expired
 *
 *   POST   /api/upload-requests                    多部分表單送件（含檔案）
 *   GET    /api/upload-requests                    角色化列表
 *   GET    /api/upload-requests/counts             nav badge 用
 *   GET    /api/upload-requests/:id/file           下載原始 Excel（審核者用）
 *   POST   /api/upload-requests/:id/branch-approve 一階核可
 *   POST   /api/upload-requests/:id/super-approve  二階核可 → 代為執行
 *   POST   /api/upload-requests/:id/reject         退件
 *   DELETE /api/upload-requests/:id                申請人撤回
 *
 * 執行方式（super-approve 後）：
 *   以 super_approver 的身分透過 loopback fetch 呼叫原上傳 endpoint，
 *   用 internalAuthHeaders() + x-internal-user-id 讓 route 視同 super_admin
 *   寫入（繞過鎖定）。成功寫回 execute_result，失敗寫 execute_error。
 */

const router = require('express').Router();
const multer = require('multer');
const pool   = require('../db/pool');
const {
  requireAuth, requirePermission, internalAuthHeaders, getUserPermissions,
} = require('../lib/authMiddleware');
const { isExcelBuffer, excelFileFilter } = require('../lib/utils');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: excelFileFilter });

router.use(requireAuth);

// ── upload_type → 對應的原上傳 endpoint 與必帶欄位 ──
const UPLOAD_TYPE_CONFIG = {
  dms: {
    endpoint: '/api/upload',
    fileField: 'files',    // 多檔，但簽核流程一次一檔
    label: 'DMS 四大檔上傳',
  },
  roster: {
    endpoint: '/api/bonus/upload-roster',
    fileField: 'file',
    extraFields: ['period'],
    label: '人員名冊上傳',
  },
  perf_targets: {
    endpoint: '/api/upload-performance-targets-native',
    fileField: 'file',
    extraFields: ['year', 'dataType'],
    label: '業績目標上傳',
  },
  revenue_targets: {
    endpoint: '/api/upload-revenue-targets',
    fileField: 'file',
    label: '營收目標上傳',
  },
  revenue_targets_native: {
    endpoint: '/api/upload-revenue-targets-native',
    fileField: 'file',
    extraFields: ['year', 'dataType'],
    label: '營收目標上傳（原生格式）',
  },
  bodyshop: {
    endpoint: '/api/bodyshop-bonus/upload',
    fileField: 'file',
    label: '業務鈑烤申請上傳',
  },
};

// ─────────────────────────────────────────────────────────
// POST /api/upload-requests  — 送出簽核申請
// body (multipart): file / upload_type / period / branch? / reason / 其餘 extra_body_*
// ─────────────────────────────────────────────────────────
router.post('/upload-requests', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
    if (!isExcelBuffer(req.file.buffer)) {
      return res.status(400).json({ error: '檔案內容不是有效的 Excel 格式（檔頭檢查失敗）' });
    }
    const upload_type = String(req.body.upload_type || '').trim();
    const cfg = UPLOAD_TYPE_CONFIG[upload_type];
    if (!cfg) return res.status(400).json({ error: '未知的上傳類型：' + upload_type });

    const period = String(req.body.period || '').trim();
    if (!/^\d{6}$/.test(period)) return res.status(400).json({ error: '請指定期間（YYYYMM）' });

    const branch  = String(req.body.branch || '').trim() || null;
    const reason  = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '請填寫申請理由' });

    // 把 extra_body_* 欄位收集起來（如 year / dataType）
    // LOW L6: 改為白名單 — 縮小攻擊面、避免將來不小心收到 __proto__/constructor
    // 等敏感 key 被當成業務欄位寫入 DB。若新增欄位請於白名單註冊。
    const ALLOWED_EXTRA_KEYS = new Set(['year', 'dataType']);
    const extra = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!k.startsWith('extra_')) continue;
      const key = k.slice(6);
      if (!ALLOWED_EXTRA_KEYS.has(key)) continue;          // 非白名單 → 忽略
      // 只接受 string/number；object/array 不允許（避免 nested pollution）
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      extra[key] = v;
    }

    const r = await pool.query(`
      INSERT INTO upload_approval_requests
        (requester_id, requester_username, requester_name,
         period, branch, upload_type, replay_endpoint,
         file_name, file_content, file_size, extra_body, reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, status, created_at, expires_at
    `, [
      req.user.user_id, req.user.username, req.user.display_name,
      period, branch, upload_type, cfg.endpoint,
      req.file.originalname, req.file.buffer, req.file.size,
      JSON.stringify(extra), reason,
    ]);
    res.json({ ok: true, request: r.rows[0] });
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ─────────────────────────────────────────────────────────
// GET /api/upload-requests  — 依角色列表
//   super_admin → 看全部（但 pending 者只有 branch_approved 才進到他的「待簽」）
//   feature:approve_upload_branch → 看自己所屬廠別的 pending
//   一般使用者 → 只看自己送出的
// ─────────────────────────────────────────────────────────
router.get('/upload-requests', async (req, res) => {
  const { scope } = req.query;  // 'mine' | 'todo' | 'all'
  try {
    const perms = await getUserPermissions(req.user.user_id, req.user.role);
    const isSuper  = req.user.role === 'super_admin';
    const canBranchApprove = isSuper || perms.includes('feature:approve_upload_branch');

    const conds = [], params = [];
    if (scope === 'mine') {
      params.push(req.user.user_id);
      conds.push(`requester_id = $${params.length}`);
    } else if (scope === 'todo') {
      if (isSuper) {
        conds.push(`status = 'branch_approved'`);
      } else if (canBranchApprove) {
        conds.push(`status = 'pending'`);
        // 只看自己能管的廠（依據 branch:* 權限）
        const branches = ['AMA','AMC','AMD','AME'].filter(b => perms.includes('branch:' + b));
        if (branches.length) {
          params.push(branches);
          conds.push(`(branch = ANY($${params.length}) OR branch IS NULL)`);
        }
      } else {
        return res.json([]);
      }
    } else if (!isSuper && !canBranchApprove) {
      // 沒權限看全部 → 只看自己
      params.push(req.user.user_id);
      conds.push(`requester_id = $${params.length}`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(`
      SELECT id, requester_username, requester_name, period, branch, upload_type,
             file_name, file_size, reason, status,
             branch_approver_name, branch_approved_at, branch_approve_note,
             super_approver_name, super_approved_at, super_approve_note,
             rejector_name, rejected_at, reject_note,
             executed_at, execute_result, execute_error,
             created_at, expires_at
      FROM upload_approval_requests ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `, params);
    res.json(r.rows);
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// GET /api/upload-requests/counts — nav badge 用
router.get('/upload-requests/counts', async (req, res) => {
  try {
    const perms   = await getUserPermissions(req.user.user_id, req.user.role);
    const isSuper = req.user.role === 'super_admin';
    const canBranchApprove = isSuper || perms.includes('feature:approve_upload_branch');
    let todo = 0;
    if (isSuper) {
      const r = await pool.query(`SELECT COUNT(*) FROM upload_approval_requests WHERE status='branch_approved'`);
      todo = parseInt(r.rows[0].count, 10);
    } else if (canBranchApprove) {
      const branches = ['AMA','AMC','AMD','AME'].filter(b => perms.includes('branch:' + b));
      if (branches.length) {
        const r = await pool.query(
          `SELECT COUNT(*) FROM upload_approval_requests WHERE status='pending' AND (branch = ANY($1) OR branch IS NULL)`,
          [branches]
        );
        todo = parseInt(r.rows[0].count, 10);
      }
    }
    const mine = (await pool.query(
      `SELECT COUNT(*) FROM upload_approval_requests WHERE requester_id=$1 AND status IN ('pending','branch_approved')`,
      [req.user.user_id]
    )).rows[0].count;
    res.json({ todo, mine: parseInt(mine, 10) });
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// GET /api/upload-requests/:id/file — 審核者下載原檔
router.get('/upload-requests/:id/file', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT requester_id, file_name, file_content FROM upload_approval_requests WHERE id=$1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: '找不到申請' });
    const perms = await getUserPermissions(req.user.user_id, req.user.role);
    const canSee = req.user.role === 'super_admin'
      || perms.includes('feature:approve_upload_branch')
      || row.requester_id === req.user.user_id;
    if (!canSee) return res.status(403).json({ error: '無權限' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name || 'upload.xlsx')}"`);
    res.send(row.file_content);
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// POST /api/upload-requests/:id/branch-approve
router.post('/upload-requests/:id/branch-approve', requirePermission('feature:approve_upload_branch'), async (req, res) => {
  const { note } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE upload_approval_requests
         SET status='branch_approved',
             branch_approver_id=$1, branch_approver_name=$2,
             branch_approved_at=NOW(), branch_approve_note=$3
       WHERE id=$4 AND status='pending'
       RETURNING id, status`,
      [req.user.user_id, req.user.display_name || req.user.username, note || '', req.params.id]
    );
    if (!r.rows.length) return res.status(409).json({ error: '申請狀態已變動，無法核可' });
    res.json({ ok: true, request: r.rows[0] });
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// POST /api/upload-requests/:id/super-approve  —  二階核可 + 代為執行
router.post('/upload-requests/:id/super-approve', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅系統管理員可二階核可' });
  const { note } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE upload_approval_requests
         SET status='super_approved',
             super_approver_id=$1, super_approver_name=$2,
             super_approved_at=NOW(), super_approve_note=$3
       WHERE id=$4 AND status='branch_approved'
       RETURNING *`,
      [req.user.user_id, req.user.display_name || req.user.username, note || '', req.params.id]
    );
    const reqRow = r.rows[0];
    if (!reqRow) { await client.query('ROLLBACK'); return res.status(409).json({ error: '申請狀態未達可核可條件（需先由據點主管核可）' }); }
    await client.query('COMMIT');

    // ── 代為執行：loopback POST 原 upload endpoint（用 super_admin 身分繞鎖）──
    const result = await replayUpload(reqRow, req);

    if (result.ok) {
      await pool.query(
        `UPDATE upload_approval_requests
           SET status='executed', executed_at=NOW(), execute_result=$1,
               file_content=NULL   -- 不再需要，釋放空間
         WHERE id=$2`,
        [JSON.stringify(result.data || {}), reqRow.id]
      );
      res.json({ ok: true, executed: true, result: result.data });
    } else {
      await pool.query(
        `UPDATE upload_approval_requests
           SET execute_error=$1
         WHERE id=$2`,
        [String(result.error || '執行失敗'), reqRow.id]
      );
      res.status(502).json({ ok: false, executed: false, error: result.error });
    }
  } catch(e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    res.status(500).json({ error: '內部錯誤，請稍後再試' });
  } finally { client.release(); }
});

// POST /api/upload-requests/:id/reject
router.post('/upload-requests/:id/reject', async (req, res) => {
  const { note } = req.body || {};
  try {
    const perms = await getUserPermissions(req.user.user_id, req.user.role);
    const isSuper = req.user.role === 'super_admin';
    const canApprove = isSuper || perms.includes('feature:approve_upload_branch');
    if (!canApprove) return res.status(403).json({ error: '無退件權限' });

    const r = await pool.query(
      `UPDATE upload_approval_requests
         SET status='rejected',
             rejector_id=$1, rejector_name=$2,
             rejected_at=NOW(), reject_note=$3,
             file_content=NULL
       WHERE id=$4 AND status IN ('pending','branch_approved')
       RETURNING id, status`,
      [req.user.user_id, req.user.display_name || req.user.username, note || '', req.params.id]
    );
    if (!r.rows.length) return res.status(409).json({ error: '申請狀態已變動，無法退件' });
    res.json({ ok: true, request: r.rows[0] });
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// DELETE /api/upload-requests/:id — 申請人撤回（僅 pending 可撤）
router.delete('/upload-requests/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE upload_approval_requests
         SET status='withdrawn', file_content=NULL
       WHERE id=$1 AND requester_id=$2 AND status='pending'
       RETURNING id`,
      [req.params.id, req.user.user_id]
    );
    if (!r.rows.length) return res.status(409).json({ error: '僅可撤回自己、未被簽核的申請' });
    res.json({ ok: true });
  } catch(e) { console.error('[' + req.method + ' ' + req.originalUrl + ']', e); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ─────────────────────────────────────────────────────────
// 代執行：loopback POST 到原 upload endpoint
// ─────────────────────────────────────────────────────────
async function replayUpload(reqRow, callerReq) {
  const cfg = UPLOAD_TYPE_CONFIG[reqRow.upload_type];
  if (!cfg) return { ok: false, error: '未知 upload_type: ' + reqRow.upload_type };

  // 安全：寫死 loopback，不信任 callerReq.headers.host（防 Host header 注入導致
  // internal auth header 被外送）。endpoint 本身來自 UPLOAD_TYPE_CONFIG，是程式內常數。
  const url = `http://127.0.0.1:${process.env.PORT || 8080}${cfg.endpoint}`;

  const form = new FormData();
  form.append(cfg.fileField, new Blob([reqRow.file_content]), reqRow.file_name || 'upload.xlsx');
  // 代入 extra_body（如 year / dataType / period）
  const extra = reqRow.extra_body || {};
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  // 某些 endpoint 還期待 period 欄位（如 roster）
  if (cfg.extraFields && cfg.extraFields.includes('period') && !('period' in extra)) {
    form.append('period', reqRow.period);
  }

  const headers = {
    ...internalAuthHeaders(),
    'x-internal-user-id': String(reqRow.super_approver_id || callerReq.user.user_id),
  };

  try {
    const r = await fetch(url, { method: 'POST', headers, body: form });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch(_) { data = { raw: text }; }
    if (!r.ok) return { ok: false, error: data.error || ('HTTP ' + r.status) };
    return { ok: true, data };
  } catch(e) {
    // 內部 loopback fetch 失敗（網路 / DNS / timeout）— 不洩 stack 給 client
    console.error('[replayUpload]', e);
    return { ok: false, error: '內部執行失敗，請查 server log' };
  }
}

module.exports = router;
