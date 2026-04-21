/**
 * index.js
 * -------------------------------------------------------------
 * Express 應用程式主入口。
 *
 * 做三件事:
 *   1. 全域 middleware: CORS（env-driven 白名單）、express.json、
 *      express.static、auditMiddleware（log 所有已登入請求）。
 *   2. 掛載所有 /api 路由。順序重要:含「未驗證端點」的 users.js
 *      （/users/login）必須最早掛上，否則會被後面 router 的
 *      router.use(requireAuth) 攔截。
 *   3. 啟動時跑 initDatabase() 建表補欄位，並啟一個 24h 週期
 *      cleanupStaleRows() 清理過期 session / 180 天前 audit_logs /
 *      365 天前 upload_history。
 *
 * 環境變數: 見 db/pool.js + lib/authMiddleware.js + README。
 */
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const initDatabase = require('./db/init');

const app  = express();
const PORT = process.env.PORT || 3001;

const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                    // 無 Origin header：curl、server-side
    if (corsAllowed.includes(origin)) return cb(null, true); // 白名單跨域放行
    // 其餘：不下 CORS header。同源請求瀏覽器本來就不檢查 CORS，會通過；
    // 真正的跨域請求會被瀏覽器擋掉——我們不丟 Error，避免 Express 回 HTML 500。
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const { auditMiddleware } = require('./lib/auditLogger');
app.use(auditMiddleware);

// ── 路由掛載 ──
// 注意：含未驗證端點的 router（users 的 /login）必須最先掛上。
// 因為其他 router 的 router.use(requireAuth) 會對任何進入該 router 的請求都先跑驗證，
// 即使該 router 內部沒匹配到路由，未驗證請求也已經被攔下回 401。
app.use('/api', require('./routes/users'));      // 含 /users/login（未驗證）

app.use('/api', require('./routes/upload'));
app.use('/api', require('./routes/saConfig'));
app.use('/api', require('./routes/query'));       // income-config + working-days + counts + query/*
app.use('/api', require('./routes/techWage'));
app.use('/api', require('./routes/revenue'));
app.use('/api', require('./routes/performance'));
app.use('/api', require('./routes/stats'));
app.use('/api', require('./routes/auditLogs'));
app.use('/api', require('./routes/bonus'));
app.use('/api', require('./routes/techHours'));
app.use('/api', require('./routes/personTargets'));
app.use('/api', require('./routes/wip'));
app.use('/api', require('./routes/vctl'));
app.use('/api', require('./routes/promoBonus'));
app.use('/api/manager-review', require('./routes/managerReview'));
app.use('/api', require('./routes/bodyshopBonus'));
app.use('/api', require('./routes/notes'));

// ── Health check（防 Zeabur 冷啟動）──
app.get('/health', (req, res) => res.json({ ok: true }));

// ── 背景清理（每 24h）──
// 避免 user_sessions / audit_logs / upload_history 無限成長。
const pool = require('./db/pool');
async function cleanupStaleRows() {
  try {
    const s = await pool.query(`DELETE FROM user_sessions WHERE expires_at < NOW()`);
    const a = await pool.query(`DELETE FROM audit_logs      WHERE created_at < NOW() - INTERVAL '180 days'`);
    const u = await pool.query(`DELETE FROM upload_history  WHERE created_at < NOW() - INTERVAL '365 days'`);
    console.log(`[cleanup] sessions=${s.rowCount} audit_logs=${a.rowCount} uploads=${u.rowCount}`);
  } catch (e) {
    console.warn('[cleanup] failed:', e.message);
  }
}

// ── 啟動 ──
initDatabase()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .then(() => {
    cleanupStaleRows();                                   // 啟動後跑一次
    setInterval(cleanupStaleRows, 24 * 60 * 60 * 1000);   // 之後每 24h
  })
  .catch(err => { console.error('DB初始化失敗:', err.message); process.exit(1); });
