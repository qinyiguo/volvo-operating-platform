/**
 * public/auth.js
 * 所有頁面共用的前端驗證工具
 * 在每個 HTML 頁面的 <script> 最前面加入:
 *   <script src="/auth.js"></script>
 */

(function() {
  const TOKEN_KEY = 'dms_token';
  const USER_KEY  = 'dms_user';

  // ── 儲存 / 讀取 ──
const router = require('express').Router();
const crypto = require('crypto');
const pool   = require('../db/pool');

const SESSION_TOKENS = new Set();

async function getSettingsPassword() {
  const r = await pool.query("SELECT value FROM app_settings WHERE key='settings_password'");
  return r.rows[0]?.value || 'admin1234';
}

router.post('/auth/settings', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error:'請輸入密碼' });
  if (password !== await getSettingsPassword()) return res.status(401).json({ error:'密碼錯誤' });
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
  if (currentPassword !== await getSettingsPassword()) return res.status(401).json({ error:'目前密碼不正確' });
  await pool.query("UPDATE app_settings SET value=$1 WHERE key='settings_password'", [newPassword]);
  SESSION_TOKENS.clear();
  res.json({ ok: true });
});

module.exports = router;

  // ── 全域替換 fetch 讓所有 API 請求自動帶 token ──
  // （可選：若頁面有直接用 fetch，建議改為 DmsAuth.fetchWithAuth）
})();
