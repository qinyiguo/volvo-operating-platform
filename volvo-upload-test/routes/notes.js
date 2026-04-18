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
const { requireAuth } = require('../lib/authMiddleware');

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
router.put('/notes/batch', async (req, res) => {
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
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


// GET /api/notes/:key
router.get('/notes/:key', async (req, res) => {
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'invalid key' });
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key=$1`,
      [key]
    );
    res.json({ key: req.params.key, value: r.rows[0]?.value ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notes/:key  — body: { value: string }
router.put('/notes/:key', async (req, res) => {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notes?prefix=revenue_AMA_
router.get('/notes', async (req, res) => {
  const prefix = KEY_PREFIX + (req.query.prefix || '');
  try {
    const r = await pool.query(
      `SELECT key, value FROM app_settings WHERE key LIKE $1 ORDER BY key`,
      [prefix + '%']
    );
    const result = {};
    r.rows.forEach(row => {
      result[row.key.slice(KEY_PREFIX.length)] = row.value;
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
