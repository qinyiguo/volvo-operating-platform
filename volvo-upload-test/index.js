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
// 注意：含未驗證端點的 router（users 的 /login、auth 的 /auth/settings）必須最先掛上。
// 因為其他 router 的 router.use(requireAuth) 會對任何進入該 router 的請求都先跑驗證，
// 即使該 router 內部沒匹配到路由，未驗證請求也已經被攔下回 401。
app.use('/api', require('./routes/users'));      // 含 /users/login（未驗證）
app.use('/api', require('./routes/auth'));       // 含 /auth/settings（未驗證）

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

// ── 啟動 ──
initDatabase()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => { console.error('DB初始化失敗:', err.message); process.exit(1); });
