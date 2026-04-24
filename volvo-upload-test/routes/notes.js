// routes/notes.js
// 說明欄 API — 儲存至 app_settings 資料表
// 掛載方式：app.use('/api', require('./routes/notes'))
//
// ⚠️  重要：server.js 需設定 body 大小限制，否則圖片儲存會失敗：
//     app.use(express.json({ limit: '20mb' }));
//     app.use(express.urlencoded({ extended: true, limit: '20mb' }));
//
// GET  /api/notes/:key         — 讀取單一筆記
// PUT  /api/notes/:key         — 寫入（upsert）單一筆記  body: { value }
// GET  /api/notes              — 以 prefix 讀取多筆  ?prefix=monthly_AMA_
// PUT  /api/notes/batch        — 批次寫入              body: { entries:[{key,value}] }

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

router.use(requireAuth);

const KEY_PREFIX = 'note_';
const MAX_KEY_LEN = 200;
const MAX_VAL_LEN = 5 * 1024 * 1024; // 5MB — PostgreSQL TEXT 支援，足夠 base64 圖片

function safeKey(k) {
  if (!k || typeof k !== 'string') return null;
  const cleaned = k.replace(/[^\w\-.:@]/g, '_').slice(0, MAX_KEY_LEN);
  return KEY_PREFIX + cleaned;
}

// PUT /api/notes/batch  — body: { entries:[{key,value}] }
router.put('/notes/batch', requirePermission('feature:monthly_edit'), async (req, res) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: 'entries must be a non-empty array' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      const key = safeKey(e.key);
      if (!key) continue;
      const value = String(e.value ?? '').slice(0, MAX_VAL_LEN);
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, value]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: entries.length });
  } catch(err) { await client.query('ROLLBACK');
    console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); } finally {
    client.release();
  }
});


// MEDIUM 3: 讀取也需 page:monthly 權限（避免任何登入者讀全部月報筆記）
// 寫入端點本來就有 feature:monthly_edit；讀取應對齊到相應的頁面權限
const requireNotesRead = requirePermission('page:monthly');

// GET /api/notes/:key
router.get('/notes/:key', requireNotesRead, async (req, res) => {
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'invalid key' });
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key=$1`,
      [key]
    );
    res.json({ key: req.params.key, value: r.rows[0]?.value ?? null });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// PUT /api/notes/:key  — body: { value: string }
router.put('/notes/:key', requirePermission('feature:monthly_edit'), async (req, res) => {
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'invalid key' });
  const value = String(req.body?.value ?? '').slice(0, MAX_VAL_LEN);
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    );
    res.json({ ok: true, key: req.params.key });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// GET /api/notes?prefix=revenue_AMA_
// MEDIUM 3: 加 page:monthly 權限 + 強制 prefix 至少 1 字以防止「整庫拉走」
router.get('/notes', requireNotesRead, async (req, res) => {
  const userPrefix = String(req.query.prefix || '').trim();
  if (!userPrefix) {
    return res.status(400).json({ error: '需指定 prefix（避免整庫枚舉）' });
  }
  // 防 LIKE 萬用字元濫用：把 % 和 _ escape，使用者只能精確 prefix
  const safePrefix = userPrefix.replace(/[\\%_]/g, c => '\\' + c);
  const fullPrefix = KEY_PREFIX + safePrefix;
  try {
    const r = await pool.query(
      `SELECT key, value FROM app_settings WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`,
      [fullPrefix + '%']
    );
    const result = {};
    r.rows.forEach(row => {
      result[row.key.slice(KEY_PREFIX.length)] = row.value;
    });
    res.json(result);
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

module.exports = router;
