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
  window.DmsAuth = {
    getToken() { return localStorage.getItem(TOKEN_KEY); },
    getUser()  {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
      catch(e) { return null; }
    },
    save(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },

    // ── 驗證 + 初始化（在每個頁面 init 最前面呼叫）──
    async init(options = {}) {
      const {
        requiredPermission = null,  // 需要的頁面權限，如 'page:stats'
        redirectOnFail = true,
      } = options;

      const token = this.getToken();
      if (!token) {
        if (redirectOnFail) window.location.href = '/login.html';
        return null;
      }

      try {
        const res = await fetch('/api/users/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
          this.clear();
          if (redirectOnFail) window.location.href = '/login.html';
          return null;
        }
        const user = await res.json();
        this.save(token, user); // 更新快取
        window._currentUser = user;

        // 先依權限過濾導覽列，讓使用者即使卡在無權限頁也能跳到有權限的頁
        this._filterNavByPermission(user);
        // 在「設定」分頁標上待簽核 badge（非同步，不阻塞）
        this._refreshApprovalBadgeOnNav();

        // 檢查頁面權限
        if (requiredPermission && user.role !== 'super_admin') {
          if (!user.permissions.includes(requiredPermission)) {
            const homeHref = this._firstAllowedPage(user) || '/login.html';
            document.body.innerHTML = `
              <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                          background:#0f172a;color:#e2e8f0;flex-direction:column;gap:16px;font-family:sans-serif">
                <div style="font-size:48px">🚫</div>
                <div style="font-size:20px;font-weight:700">無存取權限</div>
                <div style="color:#64748b">您沒有查看此頁面的權限，請聯絡管理員</div>
                <a href="${homeHref}" style="margin-top:8px;color:#3b82f6;text-decoration:none;font-size:14px">← 返回首頁</a>
              </div>`;
            return null;
          }
        }

        // 渲染導覽列使用者資訊
        this._renderUserBadge(user);
        return user;
      } catch(e) {
        this.clear();
        if (redirectOnFail) window.location.href = '/login.html';
        return null;
      }
    },

    // ── 取得待簽核數量並在 nav 插入獨立的「📬 簽核」入口 ──
    // 顯示條件（三擇一）：
    //   1. super_admin
    //   2. 擁有 feature:approve_upload_branch
    //   3. 自己有 pending / branch_approved 的申請（避免被忽略）
    async _refreshApprovalBadgeOnNav() {
      try {
        const user = window._currentUser;
        if (!user) return;
        const has = (k) => user.role === 'super_admin' || (user.permissions || []).includes(k);
        const isApprover = user.role === 'super_admin' || has('feature:approve_upload_branch');

        // 先問一次計數，決定要不要顯示
        const r = await this.fetchWithAuth('/api/upload-requests/counts').then(r => r.json()).catch(()=>null);
        const todo = r ? (r.todo || 0) : 0;
        const mine = r ? (r.mine || 0) : 0;
        const shouldShow = isApprover || mine > 0;
        if (!shouldShow) return;

        // 只在導覽列還沒放過時插入
        const nav = document.querySelector('.nav');
        if (!nav || document.querySelector('.nav-link-approval')) return;
        const settingsLink = document.querySelector('.nav-link[href="/settings.html"]');
        const a = document.createElement('a');
        a.href = '/settings.html?section=upload-approval';
        a.className = 'nav-link nav-link-approval';
        a.innerHTML = '📬 簽核';
        if (todo > 0) {
          const badge = document.createElement('span');
          badge.className = 'apr-nav-badge';
          badge.textContent = todo;
          badge.style.cssText = 'margin-left:4px;background:#ef4444;color:#fff;font-size:10px;font-weight:800;padding:1px 6px;border-radius:9px;vertical-align:top';
          a.appendChild(badge);
        } else if (mine > 0) {
          const dot = document.createElement('span');
          dot.textContent = mine;
          dot.style.cssText = 'margin-left:4px;background:rgba(59,130,246,.2);color:#60a5fa;font-size:10px;font-weight:800;padding:1px 6px;border-radius:9px;vertical-align:top';
          a.appendChild(dot);
        }
        // 插在 設定 之前；若沒有 設定 連結，就附到最後一個 nav-link 後面
        if (settingsLink && settingsLink.parentNode) {
          settingsLink.parentNode.insertBefore(a, settingsLink);
        } else {
          const links = nav.querySelectorAll('.nav-link');
          const last = links[links.length - 1];
          if (last && last.parentNode) last.parentNode.insertBefore(a, last.nextSibling);
          else nav.appendChild(a);
        }
      } catch(e) {}
    },

    // ── 頁面權限 → nav-link 對應表 ──
    _navPermissionMap: {
      '/performance.html':    'page:performance',
      '/stats.html':          'page:stats',
      '/query.html':          'page:query',
      '/monthly_report.html': 'page:monthly',
      '/bonus.html':          'page:bonus',
      '/settings.html':       'page:settings',
    },

    // ── 隱藏使用者沒權限的 nav-link ──
    _filterNavByPermission(user) {
      if (!user || user.role === 'super_admin') return;
      const perms = new Set(user.permissions || []);
      document.querySelectorAll('.nav-link').forEach(a => {
        const href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
        const need = this._navPermissionMap[href];
        if (need && !perms.has(need)) a.style.display = 'none';
      });
    },

    // ── 找出使用者能進入的第一個頁面（依 nav 順序）──
    _firstAllowedPage(user) {
      if (!user) return null;
      if (user.role === 'super_admin') return '/performance.html';
      const order = [
        '/performance.html','/stats.html','/query.html',
        '/monthly_report.html','/bonus.html','/settings.html',
      ];
      const perms = new Set(user.permissions || []);
      for (const href of order) {
        const need = this._navPermissionMap[href];
        if (!need || perms.has(need)) return href;
      }
      return null;
    },

    // ── 登出 ──
    async logout() {
      const token = this.getToken();
      if (token) {
        try {
          await fetch('/api/users/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
        } catch(e) {}
      }
      this.clear();
      window.location.href = '/login.html';
    },

    // ── API 請求（自動帶 token）──
    fetchWithAuth(url, options = {}) {
      const token = this.getToken();
      const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token}` };
      return fetch(url, { ...options, headers });
    },

    // ── 權限檢查 ──
    hasPermission(key) {
      const user = window._currentUser;
      if (!user) return false;
      if (user.role === 'super_admin') return true;
      return user.permissions.includes(key);
    },

    // ── 可見的廠別 ──
    visibleBranches() {
      const user = window._currentUser;
      if (!user) return [];
      const ALL = ['AMA','AMC','AMD','AME'];
      if (user.role === 'super_admin') return ALL;
      const allowed = ALL.filter(br => user.permissions.includes(`branch:${br}`));
      // 若有指定 branch 且 permissions 未明確包含，以 branch 為準
      if (!allowed.length && user.branch) return [user.branch];
      return allowed.length ? allowed : ALL;
    },

    // ── 導覽列使用者圖示 ──
    _renderUserBadge(user) {
      // 找到 nav 容器插入使用者 badge
      const nav = document.querySelector('.nav');
      if (!nav || document.getElementById('_userBadge')) return;
      const roleLabel = { super_admin:'超管', branch_admin:'管理員', user:'使用者' };
      const roleColor = { super_admin:'#f59e0b', branch_admin:'#10b981', user:'#3b82f6' };
      const badge = document.createElement('div');
      badge.id = '_userBadge';
      badge.style.cssText = `
        display:flex;align-items:center;gap:8px;margin-left:auto;
        padding:6px 12px;border-radius:8px;cursor:pointer;
        background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
        position:relative;flex-shrink:0;
      `;
      badge.innerHTML = `
        <div style="width:28px;height:28px;border-radius:50%;
                    background:${roleColor[user.role] || '#64748b'}22;
                    border:2px solid ${roleColor[user.role] || '#64748b'};
                    display:flex;align-items:center;justify-content:center;
                    font-size:12px;font-weight:700;color:${roleColor[user.role] || '#64748b'}">
          ${(user.display_name || user.username).charAt(0).toUpperCase()}
        </div>
        <div style="line-height:1.3;min-width:0">
          <div style="font-size:12px;font-weight:700;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px">
            ${user.display_name || user.username}
          </div>
          <div style="font-size:10px;color:${roleColor[user.role] || '#64748b'}">
            ${roleLabel[user.role] || user.role}${user.branch ? ' · ' + user.branch : ''}
          </div>
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;opacity:.5">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <div id="_userMenu" style="
          display:none;position:fixed;top:48px;right:12px;
          background:#1a2740;border:1px solid #2d4060;border-radius:10px;
          box-shadow:0 12px 40px rgba(0,0,0,.8);z-index:9999;min-width:160px;
          padding:6px 0;
        ">
          <div style="padding:10px 14px 8px;border-bottom:1px solid #253347">
            <div style="font-size:12px;font-weight:700;color:#e2e8f0">${user.display_name || user.username}</div>
            <div style="font-size:11px;color:#64748b;margin-top:1px">${user.username}</div>
          </div>
          <div onclick="DmsAuth._openProfileModal()" style="
            padding:9px 14px;font-size:13px;color:#cbd5e1;cursor:pointer;display:flex;align-items:center;gap:8px;
          " onmouseover="this.style.background='rgba(59,130,246,.08)'" onmouseout="this.style.background=''">
            👤 個人設定
          </div>
          <div onclick="DmsAuth.logout()" style="
            padding:9px 14px;font-size:13px;color:#ef4444;cursor:pointer;display:flex;align-items:center;gap:8px;
          " onmouseover="this.style.background='rgba(239,68,68,.08)'" onmouseout="this.style.background=''">
            🚪 登出
        </div>
      </div>
      `;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('_userMenu');
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
      });
      document.addEventListener('click', () => {
        const menu = document.getElementById('_userMenu');
        if (menu) menu.style.display = 'none';
      });
      nav.appendChild(badge);
    },

    // ── 個人設定 Modal ──
    _openProfileModal() {
      const user = window._currentUser;
      if (!user) return;
      const m = document.createElement('div');
      m.id = '_profileModal';
      m.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;
        display:flex;align-items:center;justify-content:center;padding:16px
      `;
      m.innerHTML = `
        <div style="background:#1a2740;border:1px solid #2d4060;border-radius:14px;width:100%;max-width:420px;padding:24px">
          <div style="font-size:16px;font-weight:800;color:#fff;margin-bottom:20px">👤 個人設定</div>
          <div style="margin-bottom:14px">
            <label style="font-size:12px;color:#64748b;font-weight:600">顯示名稱</label>
            <input id="_pDisplayName" value="${user.display_name || ''}" style="
              width:100%;background:#0f172a;border:1px solid #2d3f56;color:#e2e8f0;
              padding:9px 12px;border-radius:7px;font-size:14px;margin-top:5px;box-sizing:border-box;outline:none
            ">
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:12px;color:#64748b;font-weight:600">修改密碼（留空則不修改）</label>
          </div>
          <input id="_pCurPw" type="password" placeholder="目前密碼" style="
            width:100%;background:#0f172a;border:1px solid #2d3f56;color:#e2e8f0;
            padding:9px 12px;border-radius:7px;font-size:14px;margin-bottom:8px;box-sizing:border-box;outline:none
          ">
          <input id="_pNewPw" type="password" placeholder="新密碼（至少 6 字元）" style="
            width:100%;background:#0f172a;border:1px solid #2d3f56;color:#e2e8f0;
            padding:9px 12px;border-radius:7px;font-size:14px;margin-bottom:16px;box-sizing:border-box;outline:none
          ">
          <div id="_pMsg" style="font-size:13px;margin-bottom:10px;min-height:20px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('_profileModal').remove()" style="
              padding:8px 16px;background:#253347;color:#cbd5e1;border:1px solid #2d3f56;
              border-radius:6px;font-size:13px;font-weight:600;cursor:pointer
            ">取消</button>
            <button onclick="DmsAuth._saveProfile(${user.id})" style="
              padding:8px 18px;background:#3b82f6;color:#fff;border:none;
              border-radius:6px;font-size:13px;font-weight:700;cursor:pointer
            ">儲存</button>
          </div>
        </div>
      `;
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    },

    async _saveProfile(userId) {
      const displayName = document.getElementById('_pDisplayName').value.trim();
      const curPw       = document.getElementById('_pCurPw').value;
      const newPw       = document.getElementById('_pNewPw').value;
      const msg         = document.getElementById('_pMsg');
      if (!displayName) { msg.style.color='#ef4444'; msg.textContent='顯示名稱不能為空'; return; }
      try {
        // 更新顯示名稱
        const r1 = await this.fetchWithAuth('/api/users/me/profile', {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ display_name: displayName })
        }).then(r => r.json());
        if (r1.error) throw new Error(r1.error);

        // 修改密碼
        if (newPw) {
          if (!curPw) { msg.style.color='#ef4444'; msg.textContent='請輸入目前密碼'; return; }
          const r2 = await this.fetchWithAuth(`/api/users/${userId}/password`, {
            method:'PUT', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ current_password: curPw, password: newPw })
          }).then(r => r.json());
          if (r2.error) throw new Error(r2.error);
          msg.style.color = '#10b981';
          msg.textContent = '✅ 密碼已更新，請重新登入';
          setTimeout(() => this.logout(), 1500);
          return;
        }

        msg.style.color = '#10b981';
        msg.textContent = '✅ 已儲存';
        // 更新本地快取
        const u = this.getUser();
        if (u) { u.display_name = displayName; this.save(this.getToken(), u); window._currentUser = u; }
        // 更新 badge 顯示
        const badge = document.getElementById('_userBadge');
        if (badge) badge.remove();
        this._renderUserBadge(window._currentUser);
        setTimeout(() => { const m = document.getElementById('_profileModal'); if (m) m.remove(); }, 800);
      } catch(e) {
        if (msg) { msg.style.color='#ef4444'; msg.textContent = '❌ ' + e.message; }
      }
    },
  };

  // ── 全域主題（亮/暗）切換：任何載入 /auth.js 的頁面都自動生效 ──
  const THEME_KEY = 'volvo_theme';
  function applyTheme(t) {
    if (!document.body) return;
    if (t === 'light') document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = t === 'light' ? '🌙' : '☀️';
  }
  const savedTheme = (function(){ try { return localStorage.getItem(THEME_KEY); } catch(e) { return null; } })();
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(savedTheme === 'light' ? 'light' : 'dark');
  });
  // 只在頁面沒自訂 toggleTheme 時才用全域版（monthly_report.html 有自己的實作）
  if (typeof window.toggleTheme !== 'function') {
    window.toggleTheme = function() {
      const isLight = document.body.classList.contains('light-theme');
      const next = isLight ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch(e) {}
    };
  }

  // ── 全域替換 fetch 讓所有 API 請求自動帶 token ──
  // 對 /api/* 的請求，若尚未帶 Authorization header，就自動補上 Bearer。
  const _origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input
                : (input instanceof URL ? input.href : '');
      const isApi = url && (
        url.startsWith('/api/') ||
        url.startsWith(location.origin + '/api/')
      );
      if (isApi) {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) {
          init = init || {};
          const headers = new Headers(init.headers || {});
          if (!headers.has('Authorization')) {
            headers.set('Authorization', 'Bearer ' + token);
            init.headers = headers;
          }
        }
      }
    } catch (e) { /* fall through — 不阻斷原始請求 */ }
    return _origFetch(input, init);
  };
})();
