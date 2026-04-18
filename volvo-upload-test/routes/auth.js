const router = require('express').Router();
const crypto = require('crypto');
const pool   = require('../db/pool');

const SESSION_TOKENS = new Set();

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pwd, salt, 100000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

// 回 { ok, legacy }；legacy=true 代表 DB 存的還是舊明文，登入成功後要升級成 hash
function verifyPassword(pwd, stored) {
  if (!stored) return { ok: false, legacy: false };
  if (stored.startsWith('pbkdf2$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return { ok: false, legacy: false };
    const calc = crypto.pbkdf2Sync(pwd, salt, 100000, 32, 'sha256').toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(calc, 'hex');
    if (a.length !== b.length) return { ok: false, legacy: false };
    return { ok: crypto.timingSafeEqual(a, b), legacy: false };
  }
  return { ok: pwd === stored, legacy: true };
}

async function getStoredPassword() {
  const r = await pool.query("SELECT value FROM app_settings WHERE key='settings_password'");
  return r.rows[0]?.value ?? null;
}

router.post('/auth/settings', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error:'請輸入密碼' });
  const stored = await getStoredPassword();
  if (stored == null) return res.status(503).json({ error:'系統尚未初始化' });
  const { ok, legacy } = verifyPassword(password, stored);
  if (!ok) return res.status(401).json({ error:'密碼錯誤' });
  if (legacy) {
    await pool.query("UPDATE app_settings SET value=$1 WHERE key='settings_password'", [hashPassword(password)]);
  }
  const token = crypto.randomBytes(24).toString('hex');
  SESSION_TOKENS.add(token);
  setTimeout(() => SESSION_TOKENS.delete(token), 8 * 60 * 60 * 1000);
  res.json({ token });
});

router.get('/auth/settings/check', (req, res) => {
  res.json({ valid: !!(req.query.token && SESSION_TOKENS.has(req.query.token)) });
});

router.put('/auth/settings/password', async (req, res) => {
  const { token, currentPassword, newPassword } = req.body;
  if (!token || !SESSION_TOKENS.has(token)) return res.status(401).json({ error:'未驗證，請重新登入' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error:'新密碼至少需要 4 個字元' });
  const stored = await getStoredPassword();
  if (stored == null) return res.status(503).json({ error:'系統尚未初始化' });
  const { ok } = verifyPassword(currentPassword, stored);
  if (!ok) return res.status(401).json({ error:'目前密碼不正確' });
  await pool.query("UPDATE app_settings SET value=$1 WHERE key='settings_password'", [hashPassword(newPassword)]);
  SESSION_TOKENS.clear();
  res.json({ ok: true });
});

module.exports = router;
