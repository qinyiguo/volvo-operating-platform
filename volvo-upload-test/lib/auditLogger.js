/**
 * lib/auditLogger.js
 * 自動記錄所有使用者操作的 Express Middleware
 *
 * 使用方式（index.js）：
 *   const { auditMiddleware, writeLog } = require('./lib/auditLogger');
 *   app.use(auditMiddleware);   // 掛在 requireAuth 之後
 *
 * 也可手動寫入特定事件：
 *   await writeLog(req, { action:'DOWNLOAD', resource:'CSV', detail:'repair_income_202501_AMA.csv' });
 */

const pool = require('../db/pool');

// ─── Action 分類 ───────────────────────────────────────────────
const METHOD_ACTION = {
  GET:    'VIEW',
  POST:   'CREATE',
  PUT:    'UPDATE',
  PATCH:  'UPDATE',
  DELETE: 'DELETE',
};

// 特定路由覆寫 action label
const PATH_ACTION_MAP = [
  { pattern: /\/upload/i,                   action: 'UPLOAD'   },
  { pattern: /\/login/i,                    action: 'LOGIN'    },
  { pattern: /\/logout/i,                   action: 'LOGOUT'   },
  { pattern: /\/export|\/csv/i,             action: 'DOWNLOAD' },
  { pattern: /\/weekly-submit/i,            action: 'SUBMIT'   },
  { pattern: /\/password/i,                 action: 'PWD_CHANGE'},
  { pattern: /\/users/i,                    action: 'USER_MGMT'},
];

// 對應路由的人可讀名稱
const RESOURCE_LABELS = {
  '/api/stats/repair':              '維修收入統計',
  '/api/stats/income-summary':      '收入分類明細',
  '/api/stats/income-breakdown':    '收入分解',
  '/api/stats/revenue-per-vehicle': '單車銷售額',
  '/api/stats/sa-car-count':        'SA 進廠台數',
  '/api/stats/sa-paid-revenue':     'SA 業績',
  '/api/stats/parts':               '零件銷售統計',
  '/api/stats/boutique-accessories':'精品配件統計',
  '/api/stats/sa-sales-matrix':     '指標銷售矩陣',
  '/api/stats/tech-hours':          '技師工時',
  '/api/stats/tech-turnover':       '施工周轉率',
  '/api/stats/tech-wage-matrix':    '工資代碼矩陣',
  '/api/stats/performance':         '業績指標達成率',
  '/api/stats/daily':               '每日進廠',
  '/api/stats/wip':                 'WIP 未結工單',
  '/api/stats/vctl':                'VCTL 商務政策',
  '/api/stats/person-performance':  '個人業績達成率',
  '/api/query/repair_income':       '查詢｜維修收入',
  '/api/query/tech_performance':    '查詢｜技師工資',
  '/api/query/parts_sales':         '查詢｜零件銷售',
  '/api/query/business_query':      '查詢｜業務查詢',
  '/api/upload':                    '上傳 Excel',
  '/api/upload-requests':           '上傳簽核申請',
  '/api/users/login':               '使用者登入',
  '/api/users/logout':              '使用者登出',
  '/api/revenue-estimates/weekly-submit': '週次預估提交',
  '/api/bonus/progress':            '獎金進度查詢',
  '/api/bonus/metrics':             '獎金指標設定',
  '/api/bonus/signatures':          '獎金簽核',
  '/api/bonus/extra-bonuses':       '額外獎金',
  '/api/bonus/actual-override':     '手動實績覆蓋',
  '/api/bonus/dept-mode':           '科別團隊模式',
  '/api/bonus/dept-weights':        '科別權重',
  '/api/bonus/beauty-branches':     '美容技師分配',
  '/api/bonus/pp-alloc':            '個人占比配置',
  '/api/manager-review':            '主管考核',
  '/api/promo-bonus/configs':       '銷售獎金規則',
  '/api/bodyshop-bonus/settings':   '業務鈑烤設定',
  '/api/bodyshop-bonus/applications': '業務鈑烤申請',
  '/api/sa-config':                 'SA 指標銷售配置',
  '/api/tech-capacity-config':      '產能利用率設定',
  '/api/tech-bay-config':           '工位數設定',
  '/api/tech-group-config-v2':      '技師分組設定',
  '/api/tech-wage-config':          '工資代碼設定',
  '/api/notes':                     '月報筆記',
  '/api/wip/status':                'WIP 狀態備註',
  '/api/income-config':             '收入設定',
  '/api/working-days':              '工作天設定',
  '/api/beauty-op-hours':           '美容工時代碼',
  '/api/revenue-targets':           '營收目標設定',
  '/api/performance-metrics':       '業績指標設定',
};

// 不記錄的路由（過於頻繁或無意義）
const SKIP_PATTERNS = [
  /\/health/,
  /\/api\/periods/,
  /\/api\/counts/,
  /\/api\/users\/me$/,
  /\/api\/working-days/,
  /\/api\/auth\/settings\/check/,
  /\.(css|js|ico|png|jpg|woff|woff2|ttf)$/i,
];

// ─── IP 解析 ────────────────────────────────────────────────────
// 優先用 Express 的 req.ip — 它會根據 app.set('trust proxy', ...) 自動處理
// X-Forwarded-For，避免攻擊者偽造 XFF 汙染稽核（M2）。
// 沒有 req.ip（非 Express 環境）才退回手動解析。
function getClientIP(req) {
  if (req.ip) return req.ip;
  return req.connection?.remoteAddress
    || req.socket?.remoteAddress
    || '0.0.0.0';
}

// ─── 決定 Action ────────────────────────────────────────────────
function resolveAction(method, path) {
  for (const { pattern, action } of PATH_ACTION_MAP) {
    if (pattern.test(path)) return action;
  }
  return METHOD_ACTION[method.toUpperCase()] || 'ACTION';
}

// ─── 決定 Resource 標籤 ──────────────────────────────────────────
function resolveResource(path) {
  // 先嘗試精確比對
  const base = path.split('?')[0].replace(/\/\d+$/, '').replace(/\/:[^/]+/g, '');
  if (RESOURCE_LABELS[base]) return RESOURCE_LABELS[base];
  // 模糊比對
  for (const [key, label] of Object.entries(RESOURCE_LABELS)) {
    if (base.includes(key) || key.includes(base)) return label;
  }
  return path.split('/').slice(-2).join('/');
}

// ─── 從 req 提取資料相關 context ────────────────────────────────
function extractDataContext(req) {
  const q = req.query || {};
  const b = req.body  || {};
  return {
    data_branch: q.branch || b.branch || null,
    data_period: q.period || b.period || null,
  };
}

// ─── 核心寫入函式 ─────────────────────────────────────────────────
async function writeLog(req, overrides = {}) {
  try {
    const user    = req.user || null;
    const ip      = getClientIP(req);
    const ua      = (req.headers['user-agent'] || '').slice(0, 300);
    const path    = req.path || req.url || '';
    const method  = req.method || 'GET';
    const ctx     = extractDataContext(req);

    const row = {
      user_id:      user?.user_id  || null,
      username:     user?.username || 'anonymous',
      display_name: user?.display_name || '',
      user_role:    user?.role     || '',
      user_branch:  user?.branch   || null,
      ip_address:   ip,
      user_agent:   ua,
      action:       overrides.action       || resolveAction(method, path),
      resource:     overrides.resource     || resolveResource(path),
      resource_path: overrides.path        || path.split('?')[0],
      resource_detail: overrides.detail   || null,
      data_branch:  overrides.data_branch  || ctx.data_branch,
      data_period:  overrides.data_period  || ctx.data_period,
      status_code:  overrides.status_code  || null,
      duration_ms:  overrides.duration_ms  || null,
    };

    await pool.query(`
      INSERT INTO audit_logs
        (user_id, username, display_name, user_role, user_branch,
         ip_address, user_agent, action, resource, resource_path,
         resource_detail, data_branch, data_period,
         status_code, duration_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      row.user_id, row.username, row.display_name, row.user_role, row.user_branch,
      row.ip_address, row.user_agent, row.action, row.resource, row.resource_path,
      row.resource_detail, row.data_branch, row.data_period,
      row.status_code, row.duration_ms,
    ]);
  } catch(e) {
    // 日誌失敗不影響主流程
    console.warn('[auditLog] write failed:', e.message);
  }
}

// ─── Express Middleware ──────────────────────────────────────────
function auditMiddleware(req, res, next) {
  const path = req.path || req.url || '';

  // 跳過不需記錄的路由
  if (SKIP_PATTERNS.some(p => p.test(path))) return next();

  const startMs = Date.now();

  // 攔截 res.end 記錄回應狀態
  const origEnd = res.end.bind(res);
  res.end = function(...args) {
    const duration = Date.now() - startMs;
    // 非同步寫入，不阻擋回應
    if (req.user || /login/.test(path)) {
      writeLog(req, {
        status_code: res.statusCode,
        duration_ms: duration,
      }).catch(err => console.warn('[auditLog] middleware write failed:', err.message));
    }
    return origEnd(...args);
  };

  next();
}

module.exports = { auditMiddleware, writeLog, getClientIP };
