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
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path         = require('path');
const initDatabase = require('./db/init');

const app  = express();
const PORT = process.env.PORT || 3001;

// 在反向代理（Zeabur）後方需信任 X-Forwarded-* 才能拿到真實 IP；
// 用 'loopback, linklocal, uniquelocal' 比 'true' 安全（不直接信任任意 IP）
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

// ── 安全標頭（CSP / HSTS / X-Frame-Options / X-Content-Type-Options …）──
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // 前端有大量 inline <script> 與 inline event handler；逐步移除前先保留 unsafe-inline
      // CDN 白名單：
      //   jsdelivr / cdnjs — xlsx-js-style / @e965/xlsx / Chart.js / html2canvas / gridstack
      //   fonts.googleapis.com — login.html 的 @import
      //   fonts.gstatic.com    — 實際字型檔
      // Helmet 預設把 script-src-attr 設為 'none' 阻擋 onclick="..." 等 inline
      // event handler；我們全站用了大量這種寫法 → 需明確加 unsafe-inline。
      'script-src':       ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      'script-src-attr':  ["'unsafe-inline'"],
      'script-src-elem':  ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      'style-src':        ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
      'style-src-attr':   ["'unsafe-inline'"],
      'style-src-elem':   ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
      'img-src':          ["'self'", 'data:', 'blob:'],
      'font-src':         ["'self'", 'data:', 'https://fonts.gstatic.com'],
      'connect-src':      ["'self'"],
      'frame-ancestors':  ["'none'"],
      'object-src':       ["'none'"],
      'base-uri':         ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true },
}));

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
// JSON body 一般用不到很大；上傳走 multer (50MB)，這裡降到 2mb 縮小攻擊面
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const { auditMiddleware } = require('./lib/auditLogger');
app.use(auditMiddleware);

// ── CSRF 保護（double-submit cookie）──
// 只對 /api/* 檢查；GET/HEAD/OPTIONS / 無 cookie 的 Bearer client / 內部呼叫皆豁免
const { csrfProtect } = require('./lib/authMiddleware');
app.use('/api', csrfProtect);

// ── 登入端點 rate limit（防暴力破解）──
// 同 IP 15 分內最多 10 次登入請求；超過回 429
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登入嘗試次數過多，請 15 分鐘後再試' },
});
app.use('/api/users/login', loginLimiter);

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
app.use('/api', require('./routes/uploadApproval'));

// ── Health check（防 Zeabur 冷啟動）──
app.get('/health', (req, res) => res.json({ ok: true }));

// ── 全域錯誤處理（避免外漏 stack trace / DB schema 訊息）──
// 各 route 應改為 next(err) 走到這裡；保留 generic message 給 client，
// 完整錯誤寫到 server log。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', req.method, req.originalUrl, err.message, err.stack);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: '內部錯誤，請稍後再試' });
});

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
    // 資安告警偵測器（每 5 分鐘掃 audit_logs）
    const { startAuditAlertDetector } = require('./lib/auditAlerts');
    startAuditAlertDetector();
    // 稽核 hash-chain 月度 checkpoint
    const { startAuditCheckpointScheduler } = require('./lib/auditCheckpoint');
    startAuditCheckpointScheduler();
  })
  .catch(err => { console.error('DB初始化失敗:', err.message); process.exit(1); });
