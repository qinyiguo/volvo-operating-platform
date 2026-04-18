
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
};
const FEATURE_PERMISSIONS = {
  'feature:upload':       'Excel 上傳',
  'feature:targets':      '目標設定',
  'feature:bonus_edit':   '獎金指標設定',
  'feature:user_manage':  '使用者管理',
};

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
  if (hdr && timingEq(String(hdr), INTERNAL_TOKEN)) return next();

  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query._token || '');
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
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query._token || '');
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
  SUPER_ADMIN_PERMISSIONS,
};
