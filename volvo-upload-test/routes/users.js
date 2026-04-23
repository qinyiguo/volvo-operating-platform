/**
 * routes/users.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 使用者帳號系統（登入、使用者管理、權限授予、個人設定）。
 *
 * 公開:
 *   POST /api/users/login            帳密登入 → user_sessions token
 *
 * 登入後:
 *   POST /api/users/logout           撤銷當前 token
 *   GET  /api/users/me               目前使用者 + 權限清單
 *   GET  /api/users/permissions-schema   前端用的權限定義表
 *   PUT  /api/users/:id/password     改密碼（本人需附 current_password）
 *   PUT  /api/users/me/profile       更新顯示名稱
 *
 * 需 feature:user_manage:
 *   GET /users   POST /users   PUT /users/:id   DELETE /users/:id
 *
 * 角色三層:  super_admin > branch_admin > user
 *   canManageRole() 強制不可越權編輯。
 *
 * 密碼：pbkdf2-sha256，16-byte salt。預設 600k iterations（OWASP 2023+）。
 *   舊使用者仍存 100k → 登入驗證透過 users.password_iterations 取實際值；
 *   驗證成功後若 iterations < 600k，會自動 rehash 升級至 600k（漸進 migration，
 *   使用者完全無感）。
 *
 * Session 撤銷時機：
 *   - 改密碼（自己 / 別人）：DELETE 該 user 所有 session
 *   - 改 role / branch / is_active=false：DELETE 該 user 所有 session（防權限延後生效）
 *   - 帳號刪除 / 停用：cascade
 *
 * 本檔含 /users/login（未驗證），必須在 index.js 內早於其他 router 掛載。
 */
const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db/pool');
const {
  requireAuth, requirePermission,
  getUserPermissions, ALL_PERMISSIONS,
  PAGE_PERMISSIONS, BRANCH_PERMISSIONS, FEATURE_PERMISSIONS,
  LEGACY_PERMISSIONS,
  SUPER_ADMIN_PERMISSIONS,
} = require('../lib/authMiddleware');

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

// OWASP 2023+ 建議：PBKDF2-SHA256 最少 600,000 iterations
const PBKDF2_ITER_DEFAULT = 600000;
const PASSWORD_MIN_LENGTH = 10;

function hashPassword(password, salt, iterations = PBKDF2_ITER_DEFAULT) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// 用 timing-safe 比較避免時序攻擊；iterations 從 DB row 取得（漸進 migration）
function verifyPassword(password, hash, salt, iterations = 100000) {
  const expected = hashPassword(password, salt, iterations);
  if (expected.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 撤銷一位使用者所有 session（角色/分行/停用變更時必呼叫）
async function revokeAllSessions(userId, client) {
  const c = client || pool;
  await c.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

// 角色可以管理哪些角色（防止越權）
function canManageRole(managerRole, targetRole) {
  if (managerRole === 'super_admin') return true;
  if (managerRole === 'branch_admin' && targetRole === 'user') return true;
  return false;
}

// ═══════════════════════════════════════════════
// 登入 / 登出 / 驗證
// ═══════════════════════════════════════════════

// POST /api/users/login
router.post('/users/login', async (req, res, next) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '請輸入帳號與密碼' });
  try {
    const r = await pool.query(
      `SELECT * FROM users WHERE username = $1`, [username.trim()]
    );
    if (!r.rows.length) return res.status(401).json({ error: '帳號或密碼錯誤' });
    const user = r.rows[0];
    if (!user.is_active) return res.status(403).json({ error: '帳號已停用，請聯絡管理員' });
    const storedIter = user.password_iterations || 100000;
    if (!verifyPassword(password, user.password_hash, user.password_salt, storedIter)) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    // 漸進升級：舊 100k → 600k 重算，使用者無感
    if (storedIter < PBKDF2_ITER_DEFAULT) {
      try {
        const newSalt = generateSalt();
        const newHash = hashPassword(password, newSalt, PBKDF2_ITER_DEFAULT);
        await pool.query(
          `UPDATE users SET password_hash=$1, password_salt=$2, password_iterations=$3 WHERE id=$4`,
          [newHash, newSalt, PBKDF2_ITER_DEFAULT, user.id]
        );
      } catch (e) {
        console.warn('[login] pbkdf2 upgrade failed for user', user.id, e.message);
      }
    }

    // 建立 session token，8 小時有效
    const token     = generateToken();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, user.id, expiresAt]
    );

    // 更新最後登入時間
    await pool.query(
      `UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]
    );

    const permissions = await getUserPermissions(user.id, user.role);
    res.json({
      token,
      user: {
        id:           user.id,
        username:     user.username,
        display_name: user.display_name,
        role:         user.role,
        branch:       user.branch,
        permissions,
      },
      expires_at: expiresAt,
    });
  } catch(err) { next(err); }
});

// POST /api/users/logout
router.post('/users/logout', requireAuth, async (req, res) => {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    if (token) await pool.query(`DELETE FROM user_sessions WHERE token = $1`, [token]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/users/me — 取得目前使用者資訊
router.get('/users/me', requireAuth, async (req, res) => {
  try {
    const permissions = await getUserPermissions(req.user.user_id, req.user.role);
    res.json({
      id:           req.user.user_id,
      username:     req.user.username,
      display_name: req.user.display_name,
      role:         req.user.role,
      branch:       req.user.branch,
      permissions,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/users/permissions-schema — 前端用，取得所有可設定的權限定義
// 舊權限鍵（LEGACY_PERMISSIONS）被排除，避免再顯示在 UI
router.get('/users/permissions-schema', requireAuth, (req, res) => {
  const filterLegacy = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (!LEGACY_PERMISSIONS.has(k)) out[k] = v;
    return out;
  };
  res.json({
    pages:    PAGE_PERMISSIONS,
    branches: BRANCH_PERMISSIONS,
    features: filterLegacy(FEATURE_PERMISSIONS),
  });
});

// ═══════════════════════════════════════════════
// 使用者管理 CRUD
// ═══════════════════════════════════════════════

// GET /api/users — 列出所有使用者（依角色過濾）
router.get('/users', requireAuth, requirePermission('feature:user_manage'), async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'super_admin') {
      query  = `SELECT id, username, display_name, role, branch, is_active, last_login, created_at FROM users ORDER BY role, username`;
      params = [];
    } else if (req.user.role === 'branch_admin') {
      // 據點管理員只能看自己據點的使用者
      query  = `SELECT id, username, display_name, role, branch, is_active, last_login, created_at FROM users WHERE branch = $1 AND role = 'user' ORDER BY username`;
      params = [req.user.branch];
    } else {
      return res.status(403).json({ error: '無使用者管理權限' });
    }
    const r = await pool.query(query, params);

    // 一起取得每人的權限
    const userIds = r.rows.map(u => u.id);
    let permMap = {};
    if (userIds.length) {
      const pr = await pool.query(
        `SELECT user_id, array_agg(permission_key) AS permissions FROM user_permissions WHERE user_id = ANY($1) GROUP BY user_id`,
        [userIds]
      );
      pr.rows.forEach(p => { permMap[p.user_id] = p.permissions; });
    }
    const users = r.rows.map(u => ({
      ...u,
      permissions: u.role === 'super_admin' ? SUPER_ADMIN_PERMISSIONS : (permMap[u.id] || []),
    }));
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users — 新增使用者
router.post('/users', requireAuth, requirePermission('feature:user_manage'), async (req, res, next) => {
  const { username, password, display_name, role, branch, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: '帳號與密碼為必填' });
  if (!['super_admin','branch_admin','user'].includes(role)) return res.status(400).json({ error: '無效的角色' });
  if (!canManageRole(req.user.role, role)) return res.status(403).json({ error: '無法建立此角色的使用者' });
  // branch_admin 只能建立自己據點的使用者
  const effectiveBranch = req.user.role === 'branch_admin' ? req.user.branch : (branch || null);
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `密碼至少 ${PASSWORD_MIN_LENGTH} 個字元` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const salt = generateSalt();
    const hash = hashPassword(password, salt, PBKDF2_ITER_DEFAULT);
    const r = await client.query(
      `INSERT INTO users (username, password_hash, password_salt, password_iterations, display_name, role, branch)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, username, display_name, role, branch, is_active`,
      [username.trim(), hash, salt, PBKDF2_ITER_DEFAULT, display_name || username, role, effectiveBranch]
    );
    const newUser = r.rows[0];

    // 設定權限
    if (role !== 'super_admin' && Array.isArray(permissions) && permissions.length) {
      for (const perm of permissions) {
        if (ALL_PERMISSIONS[perm] || perm.startsWith('branch:')) {
          await client.query(
            `INSERT INTO user_permissions (user_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [newUser.id, perm]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, user: { ...newUser, permissions: permissions || [] } });
  } catch(err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: '帳號已存在' });
    next(err);
  } finally { client.release(); }
});

// PUT /api/users/:id — 更新使用者資訊
router.put('/users/:id', requireAuth, requirePermission('feature:user_manage'), async (req, res, next) => {
  const { display_name, role, branch, is_active, permissions } = req.body;
  const targetId = parseInt(req.params.id);

  try {
    const target = await pool.query(`SELECT * FROM users WHERE id=$1`, [targetId]);
    if (!target.rows.length) return res.status(404).json({ error: '找不到使用者' });
    const targetUser = target.rows[0];

    // 不能修改比自己高或同等的角色（除非是 super_admin）
    if (!canManageRole(req.user.role, targetUser.role)) {
      return res.status(403).json({ error: '無法修改此使用者' });
    }
    // 不能修改自己
    if (targetId === req.user.user_id) {
      return res.status(400).json({ error: '請透過個人設定修改自己的資料' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const effectiveBranch = req.user.role === 'branch_admin' ? req.user.branch : (branch || null);
      const effectiveRole   = req.user.role === 'super_admin' ? (role || targetUser.role) : targetUser.role;
      const effectiveActive = is_active ?? targetUser.is_active;

      // 偵測安全敏感欄位變更 → 需撤銷 session 防延後生效
      const securityChanged =
        effectiveRole   !== targetUser.role     ||
        effectiveBranch !== targetUser.branch   ||
        effectiveActive !== targetUser.is_active||
        Array.isArray(permissions); // 權限有改 → 一律撤銷

      await client.query(
        `UPDATE users SET display_name=$1, role=$2, branch=$3, is_active=$4, updated_at=NOW() WHERE id=$5`,
        [display_name || targetUser.display_name, effectiveRole, effectiveBranch, effectiveActive, targetId]
      );

      // 更新權限
      if (effectiveRole !== 'super_admin' && Array.isArray(permissions)) {
        await client.query(`DELETE FROM user_permissions WHERE user_id=$1`, [targetId]);
        for (const perm of permissions) {
          if (ALL_PERMISSIONS[perm]) {
            await client.query(
              `INSERT INTO user_permissions (user_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [targetId, perm]
            );
          }
        }
      }

      // 角色 / 分行 / 停用 / 權限改變 → 撤銷該使用者所有 session
      if (securityChanged) await revokeAllSessions(targetId, client);

      await client.query('COMMIT');
      res.json({ ok: true, sessions_revoked: securityChanged });
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch(err) { next(err); }
});

// PUT /api/users/:id/password — 重設密碼
router.put('/users/:id/password', requireAuth, async (req, res, next) => {
  const targetId    = parseInt(req.params.id);
  const { password, current_password } = req.body;
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `密碼至少 ${PASSWORD_MIN_LENGTH} 個字元` });
  }

  try {
    const target = await pool.query(`SELECT * FROM users WHERE id=$1`, [targetId]);
    if (!target.rows.length) return res.status(404).json({ error: '找不到使用者' });
    const targetUser = target.rows[0];

    // 修改自己 → 需要舊密碼
    if (targetId === req.user.user_id) {
      if (!current_password) return res.status(400).json({ error: '請提供目前密碼' });
      const storedIter = targetUser.password_iterations || 100000;
      if (!verifyPassword(current_password, targetUser.password_hash, targetUser.password_salt, storedIter)) {
        return res.status(401).json({ error: '目前密碼不正確' });
      }
    } else {
      // 修改別人 → 需要「重設他人密碼」feature 權限 + 角色層級也必須可管
      if (req.user.role !== 'super_admin') {
        const perms = await getUserPermissions(req.user.user_id, req.user.role);
        if (!perms.includes('feature:password_reset')) {
          return res.status(403).json({ error: '無「重設他人密碼」權限' });
        }
      }
      if (!canManageRole(req.user.role, targetUser.role)) {
        return res.status(403).json({ error: '無法修改此使用者密碼' });
      }
    }

    const salt = generateSalt();
    const hash = hashPassword(password, salt, PBKDF2_ITER_DEFAULT);
    await pool.query(
      `UPDATE users SET password_hash=$1, password_salt=$2, password_iterations=$3, updated_at=NOW() WHERE id=$4`,
      [hash, salt, PBKDF2_ITER_DEFAULT, targetId]
    );
    // 強制登出該使用者所有 session
    await revokeAllSessions(targetId);
    res.json({ ok: true });
  } catch(err) { next(err); }
});

// DELETE /api/users/:id — 刪除使用者
router.delete('/users/:id', requireAuth, requirePermission('feature:user_manage'), async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.user_id) return res.status(400).json({ error: '不能刪除自己的帳號' });
  try {
    const target = await pool.query(`SELECT role FROM users WHERE id=$1`, [targetId]);
    if (!target.rows.length) return res.status(404).json({ error: '找不到使用者' });
    if (!canManageRole(req.user.role, target.rows[0].role)) {
      return res.status(403).json({ error: '無法刪除此使用者' });
    }
    await pool.query(`DELETE FROM users WHERE id=$1`, [targetId]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// 個人設定
// ═══════════════════════════════════════════════

// PUT /api/users/me/profile
router.put('/users/me/profile', requireAuth, async (req, res) => {
  const { display_name } = req.body;
  if (!display_name?.trim()) return res.status(400).json({ error: '顯示名稱不能為空' });
  try {
    await pool.query(
      `UPDATE users SET display_name=$1, updated_at=NOW() WHERE id=$2`,
      [display_name.trim(), req.user.user_id]
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
