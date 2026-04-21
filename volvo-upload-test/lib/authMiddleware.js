/**
 * lib/authMiddleware.js
 * -------------------------------------------------------------
 * 身份驗證與權限中介層（所有 /api 路由的守門員）。
 *
 * 匯出:
 *   requireAuth(req,res,next)     要求合法 Bearer token，失敗回 401
 *   requirePermission(key)        工廠函式；super_admin 自動通過；失敗回 403
 *   softAuth                      只附加 req.user，不阻擋
 *   internalAuthHeaders()         同 process 內部 fetch loopback 用，回傳
 *                                 { 'x-internal-service': INTERNAL_TOKEN }
 *   ALL_PERMISSIONS / PAGE_* / BRANCH_* / FEATURE_*  權限鍵定義
 *
 * 權限鍵分三類:
 *   page:*       頁面存取（performance / stats / query / bonus / settings / monthly）
 *   branch:*     可見廠別（AMA / AMC / AMD）
 *   feature:*    功能動作（upload / targets / bonus_edit / user_manage）
 *
 * Token 來源: 只接受 Authorization: Bearer <token>
 *             （?_token= query 已停用，避免 log/referer 外洩）
 */

const crypto = require('crypto');
const pool = require('../db/pool');

// 同行程內部呼叫用的 shared secret。可由 INTERNAL_API_TOKEN 覆寫（供多 process 部署）。
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || crypto.randomBytes(24).toString('hex');

function internalAuthHeaders() {
  return { 'x-internal-service': INTERNAL_TOKEN };
}

function timingEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ═══ 所有可設定的權限鍵 ═══
const PAGE_PERMISSIONS = {
  'page:performance': '業績指標',
  'page:stats':       '各廠明細',
  'page:query':       '資料查詢',
  'page:bonus':       '獎金表',
  'page:settings':    '系統設定',
  'page:monthly':     '月報',
};
const BRANCH_PERMISSIONS = {
  'branch:AMA': 'AMA 內湖廠',
  'branch:AMC': 'AMC 仁愛廠',
  'branch:AMD': 'AMD 士林廠',
  'branch:AME': 'AME 美容＋鈑烤',
};
const FEATURE_PERMISSIONS = {
  // 上傳類（原 feature:upload 拆分）
  'feature:upload_dms':          'DMS 四大檔上傳',
  'feature:upload_roster':       '人員名冊上傳',
  'feature:upload_targets':      '業績/營收目標上傳',
  'feature:upload_bodyshop':     '業務鈑烤申請上傳',
  // 業績與營收（原 feature:targets 拆分）
  'feature:perf_metric_edit':    '業績指標定義',
  'feature:perf_target_edit':    '業績目標/個人目標',
  'feature:revenue_target_edit': '營收目標/週次預估',
  // 各廠明細
  'feature:tech_config_edit':    '產能/工位/技師/工資代碼',
  'feature:wip_edit':            'WIP 工單狀態',
  // 獎金（原 feature:bonus_edit 拆分）
  'feature:bonus_metric_edit':   '獎金指標/目標/權重',
  'feature:bonus_extra_edit':    '額外獎金/主管考核',
  'feature:bonus_sign':          '獎金簽核',
  'feature:promo_bonus_edit':    '促銷獎金規則',
  'feature:bodyshop_bonus_edit': '業務鈑烤獎金',
  'feature:sa_config_edit':      'SA 指標銷售配置',
  // 月報
  'feature:monthly_edit':        '月報版面/筆記',
  // 資料匯出（防止資料外洩，與檢視權分離）
  'feature:export_bonus':        '獎金表匯出（Excel/PDF）',
  'feature:export_data':         '資料匯出（查詢/明細/WIP/月報圖）',
  'feature:export_audit':        '操作紀錄匯出',
  // 系統
  'feature:sys_config_edit':     '系統設定（收入/工作天/美容工時）',
  'feature:user_manage':         '使用者管理',
  'feature:password_reset':      '重設他人密碼',
  'feature:approve_upload_branch': '上傳簽核-據點主管',
  // ── 舊權限鍵（保留於 DB，UI 隱藏；寫入端點已改用新鍵）──
  'feature:upload':              '[舊] Excel 上傳',
  'feature:targets':             '[舊] 目標設定',
  'feature:bonus_edit':          '[舊] 獎金指標設定',
};

// 舊權限鍵不再顯示於 UI，但保留在 ALL_PERMISSIONS 以免前端顯示 undefined。
const LEGACY_PERMISSIONS = new Set([
  'feature:upload', 'feature:targets', 'feature:bonus_edit',
]);

const ALL_PERMISSIONS = { ...PAGE_PERMISSIONS, ...BRANCH_PERMISSIONS, ...FEATURE_PERMISSIONS };

// ═══ 超級管理員擁有所有權限 ═══
const SUPER_ADMIN_PERMISSIONS = Object.keys(ALL_PERMISSIONS);

// ═══ 從 DB 或 in-memory 驗證 token ═══
async function resolveToken(token) {
  if (!token) return null;
  try {
    const r = await pool.query(`
      SELECT s.token, s.expires_at,
             u.id AS user_id, u.username, u.display_name,
             u.role, u.branch, u.is_active
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > NOW()
    `, [token]);
    if (!r.rows.length) return null;
    const user = r.rows[0];
    if (!user.is_active) return null;
    return user;
  } catch(e) {
    return null;
  }
}

// ═══ 取得使用者所有已授予的權限 ═══
async function getUserPermissions(userId, role) {
  if (role === 'super_admin') return SUPER_ADMIN_PERMISSIONS;
  try {
    const r = await pool.query(
      `SELECT permission_key FROM user_permissions WHERE user_id = $1`, [userId]
    );
    return r.rows.map(r => r.permission_key);
  } catch(e) { return []; }
}

// ═══ Middleware: 必須登入 ═══
async function requireAuth(req, res, next) {
  // ── 同行程內部服務呼叫例外：用 shared secret 比對，不再信任 IP 判斷 ──
  const hdr = req.headers['x-internal-service'];
  if (hdr && timingEq(String(hdr), INTERNAL_TOKEN)) {
    // 若另帶 x-internal-user-id → 以該使用者身分執行（讓 requirePermission / role
    // 檢查走正常流程）。用於「簽核通過後代為執行上傳」的場景。
    const uid = parseInt(req.headers['x-internal-user-id'] || '', 10);
    if (uid) {
      try {
        const r = await pool.query(
          `SELECT id AS user_id, username, display_name, role, branch, is_active
             FROM users WHERE id=$1`, [uid]);
        if (r.rows[0] && r.rows[0].is_active) req.user = r.rows[0];
      } catch(e) {}
    }
    return next();
  }

  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user  = await resolveToken(token);
  if (!user) return res.status(401).json({ error: '未登入或登入已過期', code: 'UNAUTHORIZED' });
  req.user = user;
  next();
}

// ═══ Middleware: 必須有特定權限 ═══
function requirePermission(permissionKey) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登入', code: 'UNAUTHORIZED' });
    if (req.user.role === 'super_admin') return next();
    const perms = await getUserPermissions(req.user.user_id, req.user.role);
    if (!perms.includes(permissionKey)) {
      return res.status(403).json({ error: `無 ${ALL_PERMISSIONS[permissionKey] || permissionKey} 權限`, code: 'FORBIDDEN' });
    }
    next();
  };
}

// ═══ Middleware: 軟性驗證（不阻擋，只附加 user info）═══
async function softAuth(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  req.user = await resolveToken(token);
  next();
}

module.exports = {
  requireAuth,
  requirePermission,
  softAuth,
  getUserPermissions,
  internalAuthHeaders,
  ALL_PERMISSIONS,
  PAGE_PERMISSIONS,
  BRANCH_PERMISSIONS,
  FEATURE_PERMISSIONS,
  LEGACY_PERMISSIONS,
  SUPER_ADMIN_PERMISSIONS,
};
