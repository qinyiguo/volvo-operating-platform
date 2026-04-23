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
 * Token 來源（依優先序）:
 *   1. Cookie: dms_token（HttpOnly, Secure, SameSite=Lax）← 2026-04-23 起主力
 *   2. Authorization: Bearer <token> ← 保留讓 curl / Postman / 舊 client 相容
 *   （?_token= query 已停用，避免 log/referer 外洩）
 *
 * CSRF 保護（double-submit cookie）:
 *   登入時同時發 dms_csrf cookie（非 HttpOnly，讓前端 JS 能讀）。前端每個
 *   狀態變更請求（POST/PUT/PATCH/DELETE）必須在 X-CSRF-Token header 帶上
 *   同值，伺服器比對不符 → 403。GET 免檢查。
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
  'feature:promo_bonus_edit':    '銷售獎金規則',
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

// ═══ Session TTL（與 routes/users.js 保持一致）═══
// 絕對 4 小時；閒置 30 分即自動失效（符合 OWASP ASVS L2 對含個資系統的建議）
const SESSION_IDLE_MS = 30 * 60 * 1000;

// ═══ 從 DB 或 in-memory 驗證 token（含絕對 + 閒置雙重超時） ═══
async function resolveToken(token) {
  if (!token) return null;
  try {
    const r = await pool.query(`
      SELECT s.token, s.expires_at, s.last_activity,
             u.id AS user_id, u.username, u.display_name,
             u.role, u.branch, u.is_active
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = $1
        AND s.expires_at > NOW()
        AND s.last_activity > NOW() - ($2::text || ' milliseconds')::interval
    `, [token, String(SESSION_IDLE_MS)]);
    if (!r.rows.length) return null;
    const user = r.rows[0];
    if (!user.is_active) return null;
    // 閒置活化：每次有效請求都把 last_activity 往前推（節流：<60s 內不重複寫）
    pool.query(
      `UPDATE user_sessions SET last_activity=NOW()
         WHERE token=$1 AND last_activity < NOW() - INTERVAL '60 seconds'`,
      [token]
    ).catch(e => console.warn('[auth] last_activity update failed:', e.message));
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

  // Cookie 優先（受 SameSite=Lax 保護，瀏覽器自動帶），退回 Bearer（curl/Postman 相容）
  const cookieTok = req.cookies?.dms_token;
  const auth      = req.headers['authorization'] || '';
  const bearerTok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = cookieTok || bearerTok;
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
  const cookieTok = req.cookies?.dms_token;
  const auth      = req.headers['authorization'] || '';
  const bearerTok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  req.user = await resolveToken(cookieTok || bearerTok);
  next();
}

// ═══ Middleware: CSRF（double-submit cookie）═══
// GET/HEAD/OPTIONS 免檢查；狀態變更請求必須帶 X-CSRF-Token 且值等於 dms_csrf cookie。
// Bearer-only client（無 cookie）豁免：CSRF 攻擊需受害者已登入的瀏覽器，
// 不存在於純 API client 的威脅模型。
// 內部 service 呼叫（x-internal-service 正確）亦豁免。
// 登入 / 登出端點豁免：它們本身就是切換 session 狀態，且 login.html 不載 auth.js
// 所以 fetch 不會自動帶 X-CSRF-Token；若有人保留舊 dms_token cookie 也不該卡在登入。
// req.originalUrl 總是完整路徑 '/api/users/login'（不受 app.use 掛載前綴影響）
const CSRF_EXEMPT_PATHS = new Set([
  '/api/users/login',
  '/api/users/logout',
]);
function csrfProtect(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // 登入 / 登出豁免（login.html 不載 auth.js → 不會自動帶 X-CSRF-Token；
  // 且這兩個端點就是切換 session 狀態，本身對 CSRF 免疫）
  const pathOnly = (req.originalUrl || '').split('?')[0];
  if (CSRF_EXEMPT_PATHS.has(pathOnly)) return next();

  // 內部呼叫豁免
  const intHdr = req.headers['x-internal-service'];
  if (intHdr && timingEq(String(intHdr), INTERNAL_TOKEN)) return next();

  // 無 cookie 的 API client（Bearer-only）豁免
  if (!req.cookies?.dms_token) return next();

  const cookieCsrf = req.cookies?.dms_csrf;
  const headerCsrf = req.headers['x-csrf-token'];
  if (!cookieCsrf || !headerCsrf || !timingEq(String(cookieCsrf), String(headerCsrf))) {
    return res.status(403).json({ error: 'CSRF token 驗證失敗', code: 'CSRF_FAIL' });
  }
  next();
}

module.exports = {
  requireAuth,
  requirePermission,
  softAuth,
  csrfProtect,
  getUserPermissions,
  internalAuthHeaders,
  ALL_PERMISSIONS,
  PAGE_PERMISSIONS,
  BRANCH_PERMISSIONS,
  FEATURE_PERMISSIONS,
  LEGACY_PERMISSIONS,
  SUPER_ADMIN_PERMISSIONS,
};
