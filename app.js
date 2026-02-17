/**
 * Vault Dashboard v3.1 — Multi-User Edition
 * Obsidian Vault Remote Control — All-in-one
 * Multi-User + Password Protected + Discord Webhook
 */

// Default user config (can be overridden by vault_users.json in repo)
const DEFAULT_USERS = [
    { id: 'swamp', name: 'Swamp', color: '#6366f1', role: 'admin' },
    { id: 'user2', name: 'User 2', color: '#10b981', role: 'member' },
    { id: 'user3', name: 'User 3', color: '#f59e0b', role: 'member' },
    { id: 'user4', name: 'User 4', color: '#ef4444', role: 'member' },
    { id: 'user5', name: 'User 5', color: '#8b5cf6', role: 'member' }
];
// Passwords stored in localStorage, not hardcoded (security)
const ROLE_PASSWORDS = JSON.parse(localStorage.getItem('vault_passwords') || '{"admin":"","member":""}');
const DEFAULT_GEMINI_KEY = '';  // Set via Settings page, stored in localStorage

// ===================================
// GitHub Vault API
// ===================================
class VaultAPI {
    constructor(token, repo) {
        this.token = token;
        this.repo = repo;
        this.base = 'https://api.github.com/repos/' + repo;
        this.cache = {};
    }

    async req(path, opts) {
        const url = path.startsWith('http') ? path : this.base + '/' + path;
        const key = url;
        if (!opts && this.cache[key] && Date.now() - this.cache[key].t < 90000) return this.cache[key].d;
        const headers = { 'Authorization': 'token ' + this.token, 'Accept': 'application/vnd.github.v3+json' };
        if (opts && opts.body) headers['Content-Type'] = 'application/json';
        const res = await fetch(url, { headers, ...opts });
        if (!res.ok) {
            let body = '';
            try { body = await res.text(); } catch (_) { }
            console.error('[VaultAPI] req failed:', res.status, path, body.substring(0, 200));
            throw new Error('API ' + res.status + ': ' + res.statusText + (body ? ' — ' + body.substring(0, 80) : ''));
        }
        const data = await res.json();
        if (!opts) this.cache[key] = { d: data, t: Date.now() };
        return data;
    }

    async getTree() {
        const d = await this.req('git/trees/main?recursive=1');
        return d.tree.filter(f => f.type === 'blob');
    }

    async getMdFiles() {
        const tree = await this.getTree();
        const skip = ['.obsidian', 'exports', 'scripts', '.git', '__pycache__', '.github', 'node_modules'];
        return tree.filter(f => f.path.endsWith('.md')).filter(f => !skip.some(s => f.path.startsWith(s)));
    }

    async readFile(path, fresh) {
        const apiPath = 'contents/' + encodeURIComponent(path).replace(/%2F/g, '/');
        if (fresh) {
            // Bypass all caches for write operations
            const url = this.base + '/' + apiPath + '?t=' + Date.now();
            const res = await fetch(url, {
                headers: { 'Authorization': 'token ' + this.token, 'Accept': 'application/vnd.github.v3+json' },
                cache: 'no-store'
            });
            if (!res.ok) throw new Error('API ' + res.status + ': ' + res.statusText);
            const d = await res.json();
            const raw = (d.content || '').replace(/\s/g, '');
            try { return decodeURIComponent(escape(atob(raw))); }
            catch (e) { return atob(raw); }
        }
        const d = await this.req(apiPath);
        // GitHub API returns base64 with embedded newlines — strip them
        const raw = (d.content || '').replace(/\s/g, '');
        try {
            return decodeURIComponent(escape(atob(raw)));
        } catch (e) {
            console.warn('[readFile] base64 decode fallback for', path, e.message);
            return atob(raw);
        }
    }

    async writeFile(path, content, message) {
        const apiPath = 'contents/' + encodeURIComponent(path).replace(/%2F/g, '/');
        const encodedContent = btoa(unescape(encodeURIComponent(content)));

        // Always fetch fresh SHA (bypass ALL caches) to avoid 409 Conflict
        let sha = null;
        try {
            const url = this.base + '/' + apiPath + '?t=' + Date.now();
            const res = await fetch(url, {
                headers: { 'Authorization': 'token ' + this.token, 'Accept': 'application/vnd.github.v3+json' },
                cache: 'no-store'
            });
            if (res.ok) {
                const existing = await res.json();
                sha = existing.sha;
            }
        } catch (e) { /* new file */ }

        const body = { message: message || 'Update ' + path, content: encodedContent };
        if (sha) body.sha = sha;
        return await this.req(apiPath, {
            method: 'PUT',
            body: JSON.stringify(body)
        });
    }

    async getCommits(n) {
        return await this.req('commits?per_page=' + (n || 20));
    }

    async getStats() {
        const files = await this.getMdFiles();
        return {
            total: files.length,
            projects: files.filter(f => f.path.startsWith('Projects/')).length,
            dailies: files.filter(f => f.path.startsWith('Daily/')).length,
            knowledge: files.filter(f => f.path.startsWith('Knowledge/')).length,
            weekly: files.filter(f => f.path.startsWith('Weekly/')).length,
            totalSize: files.reduce((a, f) => a + (f.size || 0), 0)
        };
    }

    async getTodos() {
        const files = await this.getMdFiles();
        const targets = files.filter(f =>
            (f.path.startsWith('Projects/') && !f.path.includes('\u30ED\u30B0')) || f.path === 'Home.md'
        );
        const todos = [];
        for (const f of targets.slice(0, 20)) {
            try {
                const c = await this.readFile(f.path);
                const project = f.path.startsWith('Projects/') ? f.path.split('/')[1] : 'Home';
                c.split('\n').forEach(line => {
                    const s = line.trim();
                    if (s.startsWith('- [ ]') || s.startsWith('- [/]')) {
                        todos.push({ task: s.replace(/^- \[.\] ?/, '').trim(), project, done: false, file: f.path });
                    } else if (s.startsWith('- [x]')) {
                        todos.push({ task: s.replace('- [x] ', '').trim(), project, done: true, file: f.path });
                    }
                });
            } catch (e) { /* skip */ }
        }
        return todos;
    }

    async getProjects() {
        const files = await this.getMdFiles();
        const p = {};
        files.filter(f => f.path.startsWith('Projects/')).forEach(f => {
            const name = f.path.split('/')[1];
            if (!p[name]) p[name] = { name, files: [], size: 0 };
            p[name].files.push(f.path);
            p[name].size += f.size || 0;
        });
        return Object.values(p).sort((a, b) => b.files.length - a.files.length);
    }

    async search(keyword) {
        const files = await this.getMdFiles();
        const results = [];
        const kw = keyword.toLowerCase();
        for (const f of files) {
            if (f.path.split('/').pop().replace('.md', '').toLowerCase().includes(kw)) {
                results.push({ file: f.path, type: '\u30D5\u30A1\u30A4\u30EB\u540D', preview: f.path });
            }
        }
        for (const f of files.slice(0, 40)) {
            if (results.length >= 20) break;
            if (results.some(r => r.file === f.path)) continue;
            try {
                const c = await this.readFile(f.path);
                if (c.toLowerCase().includes(kw)) {
                    const line = c.split('\n').find(l => l.toLowerCase().includes(kw)) || '';
                    results.push({ file: f.path, type: '\u5185\u5BB9', preview: line.trim().substring(0, 100) });
                }
            } catch (e) { /* skip */ }
        }
        return results;
    }

    async healthCheck() {
        const files = await this.getMdFiles();
        const issues = [];
        let score = 100;
        const today = new Date().toISOString().substring(0, 10);
        const hasToday = files.some(f => f.path === 'Daily/' + today + '.md');
        if (!hasToday) { issues.push('\u26A0\uFE0F \u4ECA\u65E5\u306EDaily\u30CE\u30FC\u30C8\u304C\u3042\u308A\u307E\u305B\u3093'); score -= 10; }
        const hasHome = files.some(f => f.path === 'Home.md');
        if (!hasHome) { issues.push('\u26A0\uFE0F Home.md \u304C\u3042\u308A\u307E\u305B\u3093'); score -= 5; }
        const emptyCheck = files.filter(f => f.size < 10);
        if (emptyCheck.length > 0) { issues.push('\u26A0\uFE0F \u7A7A\u30D5\u30A1\u30A4\u30EB: ' + emptyCheck.length + '\u4EF6'); score -= emptyCheck.length; }
        const projDirs = [...new Set(files.filter(f => f.path.startsWith('Projects/')).map(f => f.path.split('/')[1]))];
        for (const p of projDirs) {
            const hasMain = files.some(f => f.path === 'Projects/' + p + '/' + p + '.md');
            if (!hasMain) { issues.push('\u26A0\uFE0F Projects/' + p + ' \u306BTOP\u30D5\u30A1\u30A4\u30EB\u306A\u3057'); score -= 3; }
        }
        if (files.length > 150) { issues.push('\u2139\uFE0F \u30CE\u30FC\u30C8\u6570: ' + files.length + ' (\u6574\u7406\u63A8\u5968)'); }
        const folders = {};
        files.forEach(f => { const d = f.path.split('/')[0]; folders[d] = (folders[d] || 0) + 1; });
        return { score: Math.max(0, Math.min(100, score)), issues, stats: { total: files.length, empty: emptyCheck.length, projects: projDirs.length }, folders };
    }

    clearCache() { this.cache = {}; }
}

// ===================================
// Gemini AI API
// ===================================
class GeminiAPI {
    constructor(key) { this.key = key; }

    async ask(prompt, context) {
        if (!this.key) throw new Error('Gemini API Keyが未設定です');
        const systemPrompt = context
            ? 'You are a helpful assistant for an Obsidian Vault. Answer in Japanese. Context:\n' + context
            : 'You are a helpful AI assistant. Answer in Japanese.';

        const maxRetries = 3;
        let delay = 2000;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const res = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + this.key,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        system_instruction: { parts: [{ text: systemPrompt }] },
                        contents: [{ parts: [{ text: prompt }] }]
                    })
                }
            );

            if (res.status === 429 && attempt < maxRetries) {
                console.log(`[Gemini] 429 Rate limit, retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
                continue;
            }

            if (!res.ok) throw new Error('Gemini API Error: ' + res.status);
            const data = await res.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || '応答なし';
        }
        throw new Error('Gemini API: レート制限中。しばらく待ってから再試行してください');
    }
}

// ===================================
// App Controller
// ===================================
class VaultApp {
    constructor() {
        this.api = null;
        this.gemini = null;
        this.page = 'dashboard';
        this.aiMode = 'ask';
        this.aiHistory = [];
        this.pins = JSON.parse(localStorage.getItem('vault_pins') || '[]');
        this.todoFilter = 'pending';
        this.todoProjectFilter = '';
        this.webhookUrl = localStorage.getItem('vault_webhook') || '';
        this._todosCache = [];
        this.currentUser = JSON.parse(sessionStorage.getItem('vault_user') || 'null');
        this.availableUsers = DEFAULT_USERS;
        try { this.checkPassword(); } catch (e) { console.error('checkPassword error:', e); this.init(); }
    }

    checkPassword() {
        const saved = sessionStorage.getItem('vault_auth');
        const savedUser = sessionStorage.getItem('vault_user');
        if (saved === 'ok' && savedUser) {
            this.currentUser = JSON.parse(savedUser);
            this.init();
            return;
        }
        // Hide original content
        document.getElementById('app').style.display = 'none';
        document.getElementById('toast').style.display = 'none';
        // Multi-user login overlay
        const overlay = document.createElement('div');
        overlay.id = 'password-gate';
        let usersHtml = '<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin:20px 0">';
        this.availableUsers.forEach((u, i) => {
            usersHtml += '<div class="user-select-card" data-idx="' + i + '" style="cursor:pointer;padding:12px 16px;border-radius:12px;border:2px solid transparent;background:var(--bg-2);transition:all 0.2s;text-align:center;min-width:80px" onmouseover="this.style.borderColor=\'' + u.color + '\'" onmouseout="if(!this.classList.contains(\'selected\'))this.style.borderColor=\'transparent\'">' +
                '<div style="width:40px;height:40px;border-radius:50%;background:' + u.color + ';margin:0 auto 6px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff">' + u.name.charAt(0).toUpperCase() + '</div>' +
                '<div style="font-size:13px;font-weight:600;color:var(--text-1)">' + u.name + '</div>' +
                '<div style="font-size:10px;color:var(--text-4)">' + u.role + '</div>' +
                '</div>';
        });
        usersHtml += '</div>';

        overlay.innerHTML =
            '<div class="login-bg"></div>' +
            '<div class="login-container" style="max-width:460px">' +
            '<div class="login-logo-wrap"><div class="login-logo-glow"></div><div class="login-logo">\u{1F465}</div></div>' +
            '<h1 class="login-title">\u30ED\u30B0\u30A4\u30F3</h1>' +
            '<p class="login-subtitle">\u30E6\u30FC\u30B6\u30FC\u3092\u9078\u629E\u3057\u3066\u30D1\u30B9\u30EF\u30FC\u30C9\u3092\u5165\u529B</p>' +
            usersHtml +
            '<div class="input-group" style="margin-top:8px">' +
            '<input type="password" id="pw-input" placeholder="\u30D1\u30B9\u30EF\u30FC\u30C9\u3092\u5165\u529B" autocomplete="off" disabled style="opacity:0.5">' +
            '</div>' +
            '<button id="pw-btn" class="btn btn-primary btn-lg" disabled style="opacity:0.5">\u30ED\u30B0\u30A4\u30F3</button>' +
            '<p id="pw-error" style="color:var(--red);font-size:13px;margin-top:10px;display:none">\u274C \u30D1\u30B9\u30EF\u30FC\u30C9\u304C\u9055\u3044\u307E\u3059</p>' +
            '</div>';
        overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;position:fixed;inset:0;z-index:9999;background:var(--bg-0)';
        document.body.appendChild(overlay);

        // User selection
        let selectedIdx = -1;
        overlay.querySelectorAll('.user-select-card').forEach(card => {
            card.addEventListener('click', () => {
                overlay.querySelectorAll('.user-select-card').forEach(c => {
                    c.classList.remove('selected');
                    c.style.borderColor = 'transparent';
                });
                card.classList.add('selected');
                card.style.borderColor = this.availableUsers[parseInt(card.dataset.idx)].color;
                selectedIdx = parseInt(card.dataset.idx);
                const pwInput = document.getElementById('pw-input');
                const pwBtn = document.getElementById('pw-btn');
                pwInput.disabled = false;
                pwInput.style.opacity = '1';
                pwBtn.disabled = false;
                pwBtn.style.opacity = '1';
                pwInput.focus();
            });
        });

        const pwInput = document.getElementById('pw-input');
        const pwBtn = document.getElementById('pw-btn');
        const tryPw = () => {
            if (selectedIdx < 0) return;
            const user = this.availableUsers[selectedIdx];
            const pw = pwInput.value;
            // If passwords not yet configured, show setup
            if (!ROLE_PASSWORDS.admin && !ROLE_PASSWORDS.member) {
                this.showPasswordSetup(overlay);
                return;
            }
            if (pw === ROLE_PASSWORDS[user.role] || pw === ROLE_PASSWORDS.admin) {
                this.currentUser = user;
                sessionStorage.setItem('vault_auth', 'ok');
                sessionStorage.setItem('vault_user', JSON.stringify(user));
                overlay.remove();
                document.getElementById('app').style.display = '';
                document.getElementById('toast').style.display = '';
                this.init();
            } else {
                document.getElementById('pw-error').style.display = 'block';
                pwInput.value = '';
                pwInput.focus();
            }
        };
        pwBtn.addEventListener('click', tryPw);
        pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryPw(); });

        // Auto-show setup if passwords not configured
        if (!ROLE_PASSWORDS.admin && !ROLE_PASSWORDS.member) {
            this.showPasswordSetup(overlay);
        }
    }

    showPasswordSetup(overlay) {
        overlay.innerHTML =
            '<div class="login-bg"></div>' +
            '<div class="login-container" style="max-width:420px">' +
            '<div class="login-logo-wrap"><div class="login-logo-glow"></div><div class="login-logo">🔐</div></div>' +
            '<h1 class="login-title">初回セットアップ</h1>' +
            '<p class="login-subtitle">パスワードを設定してください</p>' +
            '<div class="input-group" style="margin-top:16px">' +
            '<label style="font-size:13px;color:var(--text-3);margin-bottom:4px;display:block">👑 Admin パスワード</label>' +
            '<input type="password" id="setup-admin-pw" placeholder="Admin パスワード" autocomplete="off">' +
            '</div>' +
            '<div class="input-group" style="margin-top:12px">' +
            '<label style="font-size:13px;color:var(--text-3);margin-bottom:4px;display:block">👤 Member パスワード</label>' +
            '<input type="password" id="setup-member-pw" placeholder="Member パスワード" autocomplete="off">' +
            '</div>' +
            '<button id="setup-btn" class="btn btn-primary btn-lg" style="margin-top:16px">保存してログイン</button>' +
            '<p id="setup-error" style="color:var(--red);font-size:13px;margin-top:10px;display:none">❌ パスワードを入力してください</p>' +
            '</div>';
        overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;position:fixed;inset:0;z-index:9999;background:var(--bg-0)';

        document.getElementById('setup-btn').addEventListener('click', () => {
            const adminPw = document.getElementById('setup-admin-pw').value;
            const memberPw = document.getElementById('setup-member-pw').value;
            if (!adminPw) {
                document.getElementById('setup-error').style.display = 'block';
                return;
            }
            const passwords = { admin: adminPw, member: memberPw || adminPw };
            localStorage.setItem('vault_passwords', JSON.stringify(passwords));
            location.reload();
        });
    }

    init() {
        console.log('[VaultApp] init() called');
        try {
            const token = localStorage.getItem('vault_token');
            const repo = localStorage.getItem('vault_repo');
            const gemKey = localStorage.getItem('vault_gemini') || '';
            this.webhookUrl = localStorage.getItem('vault_webhook') || '';
            if (token && repo) this.connect(token, repo, gemKey);

            // Login
            const loginBtn = document.getElementById('login-btn');
            if (loginBtn) loginBtn.addEventListener('click', () => this.doLogin());
            const tokenInput = document.getElementById('token-input');
            if (tokenInput) tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });

            // Nav
            document.querySelectorAll('.sb-item').forEach(item => {
                item.addEventListener('click', () => this.navigate(item.dataset.page));
            });

            // Logout
            const logoutBtn = document.getElementById('logout-btn');
            if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout());

            // Search
            document.getElementById('search-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.doSearch(); });

            // AI
            document.getElementById('ai-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.sendAi(); });

            // TODO filter
            document.querySelectorAll('#todo-filter .tab').forEach(t => {
                t.addEventListener('click', () => {
                    document.querySelectorAll('#todo-filter .tab').forEach(x => x.classList.remove('active'));
                    t.classList.add('active');
                    this.todoFilter = t.dataset.filter;
                    if (this._todosCache && this._todosCache.length) this.renderTodoList();
                    else this.loadTodos();
                });
            });

            // Mobile menu
            document.getElementById('menu-toggle')?.addEventListener('click', () => {
                const sb = document.getElementById('sidebar');
                sb.classList.toggle('open');
                this.toggleMobileBackdrop(sb.classList.contains('open'));
            });

            // Quick note enter
            document.getElementById('quick-note-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.addQuickNote(); });
            document.getElementById('todo-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.addTodo(); });
            document.getElementById('pin-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.addPin(); });
            document.getElementById('memo-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.addMemo(); });
            document.getElementById('ai-chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.sendAiChat(); });

            console.log('[VaultApp] init() complete');
        } catch (e) { console.error('[VaultApp] init error:', e); }
    }

    doLogin() {
        const token = document.getElementById('token-input').value.trim();
        const repo = document.getElementById('repo-input').value.trim();
        const gemKey = document.getElementById('gemini-input').value.trim() || localStorage.getItem('vault_gemini') || '';
        if (!token) return this.toast('\u274C \u30C8\u30FC\u30AF\u30F3\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044');
        localStorage.setItem('vault_token', token);
        localStorage.setItem('vault_repo', repo);
        if (gemKey) localStorage.setItem('vault_gemini', gemKey);
        this.connect(token, repo, gemKey);
    }

    updateSidebarUser() {
        if (!this.currentUser) return;
        const avatar = document.getElementById('sidebar-user-avatar');
        const name = document.getElementById('sidebar-user-name');
        const role = document.getElementById('sidebar-user-role');
        if (avatar) { avatar.style.background = this.currentUser.color; avatar.textContent = this.currentUser.name.charAt(0).toUpperCase(); }
        if (name) name.textContent = this.currentUser.name;
        if (role) role.textContent = this.currentUser.role === 'admin' ? '\u{1F451} Admin' : '\u{1F464} Member';
    }

    connect(token, repo, gemKey) {
        this.api = new VaultAPI(token, repo);
        if (gemKey) this.gemini = new GeminiAPI(gemKey);
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('main-screen').classList.add('active');
        document.getElementById('connection-status').innerHTML = '\uD83D\uDFE2 ' + repo;
        if (document.getElementById('setting-repo')) document.getElementById('setting-repo').value = repo;
        if (document.getElementById('setting-webhook')) document.getElementById('setting-webhook').value = this.webhookUrl;
        this.updateSidebarUser();
        this.loadDashboard();
    }

    logout() {
        localStorage.removeItem('vault_token');
        localStorage.removeItem('vault_repo');
        localStorage.removeItem('vault_gemini');
        sessionStorage.removeItem('vault_auth');
        sessionStorage.removeItem('vault_user');
        this.currentUser = null;
        location.reload();
    }

    navigate(page) {
        if (!page) return;
        document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
        const target = document.querySelector('.sb-item[data-page="' + page + '"]');
        if (target) target.classList.add('active');
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const el = document.getElementById('page-' + page);
        if (el) el.classList.add('active');
        this.page = page;
        document.getElementById('sidebar').classList.remove('open');
        this.toggleMobileBackdrop(false);

        const loaders = {
            dashboard: () => this.loadDashboard(),
            todos: () => this.loadTodos(),
            projects: () => this.loadProjects(),
            files: () => this.loadFiles(),
            timeline: () => this.loadTimeline(),
            health: () => this.runHealthCheck(),
            pins: () => this.renderPins(),
            apps: () => this.loadApps(),
            memos: () => this.loadMemos(),
            ai: () => this.initAiChat()
        };
        if (loaders[page]) loaders[page]();
    }

    toggleMobileBackdrop(show) {
        let bd = document.querySelector('.sidebar-backdrop');
        if (show) {
            if (!bd) {
                bd = document.createElement('div');
                bd.className = 'sidebar-backdrop';
                bd.addEventListener('click', () => {
                    document.getElementById('sidebar').classList.remove('open');
                    this.toggleMobileBackdrop(false);
                });
                document.body.appendChild(bd);
            }
            requestAnimationFrame(() => bd.classList.add('show'));
        } else if (bd) {
            bd.classList.remove('show');
        }
    }

    // =========== APP LAUNCHER ===========
    loadApps() {
        const apps = [
            { id: 'roulette', name: 'AbsCL ルーレット', icon: '🎰', desc: 'メンバー選択ルーレット', url: 'apps/roulette/index.html', color: 'linear-gradient(135deg, #f59e0b, #ef4444)' },
            { id: 'pomodoro', name: 'ポモドーロタイマー', icon: '🍅', desc: 'PWA対応タイマー', url: 'apps/pomodoro/index.html', color: 'linear-gradient(135deg, #ef4444, #dc2626)' },
            { id: 'diff', name: 'Git Diff Viewer', icon: '🔀', desc: 'コミット差分ビューア', url: 'diff/index.html', color: 'linear-gradient(135deg, #10b981, #06b6d4)' },
            { id: 'status', name: 'ステータスページ', icon: '📊', desc: 'サービス稼働状況', url: 'status/index.html', color: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }
        ];
        const grid = document.getElementById('apps-grid');
        grid.innerHTML = apps.map(a => `
            <div class="app-card" onclick="app.launchApp('${a.url}', '${a.name}')" style="cursor:pointer">
                <div class="app-card-icon" style="background:${a.color}">${a.icon}</div>
                <div class="app-card-info">
                    <h4>${a.name}</h4>
                    <p>${a.desc}</p>
                </div>
                <span class="app-card-launch">▶</span>
            </div>
        `).join('');
    }

    launchApp(url, name) {
        this._currentAppUrl = url;
        document.getElementById('apps-grid').style.display = 'none';
        document.getElementById('app-frame-wrap').style.display = 'flex';
        document.getElementById('apps-close-frame').style.display = 'inline-flex';
        document.getElementById('app-frame-title').textContent = name;
        document.getElementById('app-frame').src = url;
    }

    closeAppFrame() {
        document.getElementById('app-frame').src = '';
        document.getElementById('app-frame-wrap').style.display = 'none';
        document.getElementById('apps-grid').style.display = '';
        document.getElementById('apps-close-frame').style.display = 'none';
    }

    openAppExternal() {
        if (this._currentAppUrl) window.open(this._currentAppUrl, '_blank');
    }

    toggleAppFullscreen() {
        const wrap = document.getElementById('app-frame-wrap');
        wrap.classList.toggle('fullscreen');
    }

    // =========== MARKDOWN RENDERER ===========
    renderMarkdown(text) {
        if (!text) return '';
        let html = this.esc(text);
        // Headers
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        // Bold & italic
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Checkboxes
        html = html.replace(/^- \[x\] (.+)$/gm, '<div class="md-check done">✅ $1</div>');
        html = html.replace(/^- \[ \] (.+)$/gm, '<div class="md-check">⬜ $1</div>');
        // Lists
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        // Horizontal rule
        html = html.replace(/^---$/gm, '<hr>');
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        // Clean up br inside pre
        html = html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, (m, cls, code) => {
            return '<pre><code' + cls + '>' + code.replace(/<br>/g, '\n') + '</code></pre>';
        });
        return html;
    }

    // =========== MEMOS ===========
    async loadMemos() {
        const list = document.getElementById('memo-list');
        const countEl = document.getElementById('memo-count');
        if (!this.api) { list.innerHTML = '<div class="loading">🚧 GitHub接続が必要です</div>'; return; }
        list.innerHTML = this.loading();
        try {
            const content = await this.api.readFile('Memos.md');
            const lines = content.split('\n').filter(l => l.trim().startsWith('- '));
            this._memosRaw = content;
            this._memoLines = lines;
            countEl.textContent = lines.length + ' 件';
            if (!lines.length) {
                list.innerHTML = '<div class="loading">📝 メモはまだありません</div>';
                return;
            }
            list.innerHTML = lines.map((line, i) => {
                const match = line.match(/^- \*\*(.+?)\*\* — (.+)$/);
                const ts = match ? match[1] : '';
                const text = match ? match[2] : line.replace(/^- /, '');
                return '<div class="memo-card" style="animation-delay:' + (i * 0.05) + 's">' +
                    '<div class="memo-card-content">' +
                    '<span class="memo-text">' + this.esc(text) + '</span>' +
                    (ts ? '<span class="memo-time">' + ts + '</span>' : '') +
                    '</div>' +
                    '<button class="btn btn-ghost btn-sm memo-done" onclick="app.deleteMemo(' + i + ')" title="完了">✅</button>' +
                    '</div>';
            }).reverse().join('');
        } catch (e) {
            if (e.message && e.message.includes('404')) {
                list.innerHTML = '<div class="loading">📝 メモはまだありません。最初のメモを追加しよう！</div>';
                countEl.textContent = '0 件';
            } else {
                list.innerHTML = '<div class="loading">❌ ' + this.esc(e.message) + '</div>';
            }
        }
    }

    async addMemo() {
        const input = document.getElementById('memo-input');
        const text = input.value.trim();
        if (!text) return;
        if (!this.api) return this.toast('❌ GitHub接続が必要です');
        input.value = '';
        const now = new Date();
        const ts = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        const newLine = '- **' + ts + '** — ' + text;

        try {
            let content;
            try {
                content = await this.api.readFile('Memos.md');
            } catch (e) {
                content = '---\ntags:\n  - type/ボス\n---\n\n# 💡 メモ帳\n';
            }
            content += '\n' + newLine;
            await this.api.writeFile('Memos.md', content, 'Bot: memo - ' + text.substring(0, 30));
            this.toast('💡 メモ追加！');
            this.loadMemos();
            // Webhook通知
            this.notifyWebhook('💡 メモ追加', text);
        } catch (e) {
            this.toast('❌ ' + e.message);
        }
    }

    async deleteMemo(idx) {
        if (!this.api || !this._memoLines) return;
        const line = this._memoLines[idx];
        if (!line) return;
        try {
            let content = this._memosRaw;
            content = content.replace(line, '').replace(/\n\n\n+/g, '\n\n');
            await this.api.writeFile('Memos.md', content.trim() + '\n', 'Bot: memo done');
            this.toast('✅ メモ完了！');
            this.loadMemos();
        } catch (e) {
            this.toast('❌ ' + e.message);
        }
    }

    // =========== AI CHAT ===========
    initAiChat() {
        if (!this._aiHistory) this._aiHistory = [];
        const input = document.getElementById('ai-chat-input');
        if (input) {
            input.focus();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendAiChat();
                }
            });
        }
    }

    async sendAiChat() {
        const input = document.getElementById('ai-chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        const geminiKey = localStorage.getItem('vault_gemini');
        if (!geminiKey) { this.toast('❌ 設定で Gemini API Key を入力してください'); return; }

        // Add user message
        this._addAiMsg('user', text);

        // Show thinking indicator
        const thinkingId = 'ai-thinking-' + Date.now();
        const msgs = document.getElementById('ai-messages');
        msgs.insertAdjacentHTML('beforeend',
            '<div class="ai-msg ai-msg-bot" id="' + thinkingId + '">' +
            '<div class="ai-msg-avatar">🤖</div>' +
            '<div class="ai-msg-content"><div class="ai-thinking"><span></span><span></span><span></span></div></div></div>');
        msgs.scrollTop = msgs.scrollHeight;

        try {
            // Gather Vault context
            let vaultContext = '';
            if (this.api) {
                try {
                    const [stats, todayContent, commits] = await Promise.all([
                        this.api.getStats(),
                        this.api.readFile('Daily/' + new Date().toISOString().substring(0, 10) + '.md').catch(() => ''),
                        this.api.getCommits(5)
                    ]);
                    vaultContext = '\n\n【Vault統計】ノート: ' + stats.total + ', プロジェクト: ' + stats.projects +
                        ', Daily: ' + stats.dailies + ', Knowledge: ' + stats.knowledge +
                        '\n【今日のDaily】\n' + (todayContent || 'まだ作成されていません').substring(0, 800) +
                        '\n【最近のコミット】\n' + commits.slice(0, 5).map(c => c.commit.message.split('\n')[0].substring(0, 50) + ' (' + c.commit.author.date.substring(0, 10) + ')').join('\n');

                    // Search related files for context
                    const keywords = text.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
                    if (keywords.length) {
                        const files = await this.api.getMdFiles();
                        const relevant = files.filter(f => keywords.some(k => f.path.toLowerCase().includes(k.toLowerCase()))).slice(0, 3);
                        for (const f of relevant) {
                            try {
                                const c = await this.api.readFile(f.path);
                                vaultContext += '\n\n【' + f.path + '】\n' + c.substring(0, 500);
                            } catch (e) { }
                        }
                    }
                } catch (e) { console.warn('Vault context error:', e); }
            }

            // Build conversation history
            if (!this._aiHistory) this._aiHistory = [];
            this._aiHistory.push({ role: 'user', parts: [{ text: text }] });

            const systemPrompt = 'あなたは「Vault AI」です。Obsidian Vaultの知識ベースを持つAIアシスタントとして、' +
                'ユーザーと自然に会話してください。日本語でフレンドリーに回答し、Vaultの内容を参照して具体的に答えてください。' +
                'メモ追加、TODO確認、ファイル検索などについて積極的に提案してください。' + vaultContext;

            const body = {
                contents: this._aiHistory,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
            };

            const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) throw new Error('API ' + res.status);
            const data = await res.json();
            const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '応答を取得できませんでした';

            this._aiHistory.push({ role: 'model', parts: [{ text: reply }] });
            // Keep history manageable
            if (this._aiHistory.length > 20) this._aiHistory = this._aiHistory.slice(-16);

            // Remove thinking, add response
            document.getElementById(thinkingId)?.remove();
            this._addAiMsg('bot', reply);
        } catch (e) {
            document.getElementById(thinkingId)?.remove();
            this._addAiMsg('bot', '❌ エラー: ' + e.message);
        }
    }

    _addAiMsg(role, text) {
        const msgs = document.getElementById('ai-messages');
        const isBot = role === 'bot';
        const avatar = isBot ? '🤖' : '👤';
        const cls = isBot ? 'ai-msg-bot' : 'ai-msg-user';
        const rendered = isBot ? this.renderMarkdown(text) : this.esc(text);
        msgs.insertAdjacentHTML('beforeend',
            '<div class="ai-msg ' + cls + '">' +
            '<div class="ai-msg-avatar">' + avatar + '</div>' +
            '<div class="ai-msg-content">' + rendered + '</div></div>');
        msgs.scrollTop = msgs.scrollHeight;
    }

    clearAiChat() {
        this._aiHistory = [];
        const msgs = document.getElementById('ai-messages');
        msgs.innerHTML =
            '<div class="ai-msg ai-msg-bot">' +
            '<div class="ai-msg-avatar">🤖</div>' +
            '<div class="ai-msg-content">' +
            '<p>会話をクリアしました。新しい質問をどうぞ！</p>' +
            '<div class="ai-quick-actions">' +
            '<button class="ai-quick-btn" onclick="app.aiQuick(\'今日のTODOを教えて\')">📋 TODO確認</button>' +
            '<button class="ai-quick-btn" onclick="app.aiQuick(\'Vaultの統計情報を教えて\')">📊 Vault統計</button>' +
            '<button class="ai-quick-btn" onclick="app.aiQuick(\'最近の作業内容を要約して\')">📝 作業要約</button>' +
            '<button class="ai-quick-btn" onclick="app.aiQuick(\'プロジェクト一覧を教えて\')">📁 プロジェクト</button>' +
            '</div></div></div>';
    }

    aiQuick(text) {
        document.getElementById('ai-chat-input').value = text;
        this.sendAiChat();
    }

    toast(msg) {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
    }

    esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
    loading() { return '<div class="loading"><div class="spinner"></div>\u8AAD\u307F\u8FBC\u307F\u4E2D...</div>'; }

    relativeTime(dateStr) {
        const diff = Date.now() - new Date(dateStr).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return '\u305F\u3063\u305F\u4ECA';
        if (m < 60) return m + '\u5206\u524D';
        const h = Math.floor(m / 60);
        if (h < 24) return h + '\u6642\u9593\u524D';
        const d = Math.floor(h / 24);
        if (d < 7) return d + '\u65E5\u524D';
        return dateStr.substring(0, 10);
    }

    // =========== DASHBOARD ===========
    async loadDashboard() {
        const grid = document.getElementById('stats-grid');
        if (!grid) return;
        if (!this.api) {
            grid.innerHTML = '<div class="loading">\u{1F6A7} GitHub\u63A5\u7D9A\u304C\u5FC5\u8981\u3067\u3059</div>';
            return;
        }
        grid.innerHTML = this.loading();
        try {
            const [stats, commits] = await Promise.all([this.api.getStats(), this.api.getCommits(8)]);
            const sizeMB = (stats.totalSize / 1024 / 1024).toFixed(1);
            grid.innerHTML =
                '<div class="stat-card g1"><div class="stat-label">\u{1F4CB} \u30CE\u30FC\u30C8</div><div class="stat-value">' + stats.total + '</div></div>' +
                '<div class="stat-card g2"><div class="stat-label">\u{1F4C1} \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8</div><div class="stat-value">' + stats.projects + '</div></div>' +
                '<div class="stat-card g3"><div class="stat-label">\u{1F4C5} Daily</div><div class="stat-value">' + stats.dailies + '</div></div>' +
                '<div class="stat-card g4"><div class="stat-label">\u{1F4DA} Knowledge</div><div class="stat-value">' + stats.knowledge + '</div></div>' +
                '<div class="stat-card g5"><div class="stat-label">\u{1F4BE} \u30B5\u30A4\u30BA</div><div class="stat-value">' + sizeMB + 'MB</div></div>';

            // Health mini
            const hm = document.getElementById('health-mini');
            const score = Math.min(100, 75 + Math.floor(stats.total / 8));
            const color = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)';
            hm.innerHTML =
                '<div style="text-align:center;font-size:36px;font-weight:800;color:' + color + '">' + score + '</div>' +
                '<div class="health-bar"><div class="health-bar-fill" style="width:' + score + '%;background:' + color + '"></div></div>';

            // Recent
            const rm = document.getElementById('recent-mini');
            rm.innerHTML = commits.slice(0, 6).map(c =>
                '<div style="padding:5px 0;border-bottom:1px solid var(--border-1);font-size:13px;display:flex;justify-content:space-between">' +
                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + this.esc(c.commit.message.split('\n')[0].substring(0, 40)) + '</span>' +
                '<span style="color:var(--text-4);flex-shrink:0;margin-left:8px">' + c.commit.author.date.substring(0, 10) + '</span>' +
                '</div>'
            ).join('');

            // Today
            const tc = document.getElementById('today-content');
            const today = new Date().toISOString().substring(0, 10);
            try {
                const content = await this.api.readFile('Daily/' + today + '.md');
                tc.innerHTML = '<div class="md-preview" style="max-height:250px;overflow-y:auto;padding:8px">' + this.renderMarkdown(content) + '</div>';
            } catch (e) {
                tc.innerHTML = '<p class="text-muted">\u4ECA\u65E5\u306EDaily\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093</p>';
            }
        } catch (e) {
            grid.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>';
        }
        // v3.0 extras
        this.loadDashboardExtras();
    }

    // =========== QUICK NOTE ===========
    async addQuickNote() {
        const input = document.getElementById('quick-note-input');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return this.toast('\u274C \u30E1\u30E2\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044');
        if (!this.api) return this.toast('\u274C GitHub\u63A5\u7D9A\u304C\u5FC5\u8981\u3067\u3059');
        input.value = '';
        const today = new Date().toISOString().substring(0, 10);
        const path = 'Daily/' + today + '.md';
        try {
            let content = '';
            try { content = await this.api.readFile(path); } catch (e) {
                content = '---\ndate: ' + today + '\ntags: #type/\u65E5\u5831\n---\n# ' + today + '\n';
            }
            const now = new Date().toTimeString().substring(0, 5);
            content += '\n- ' + now + ' ' + text;
            const userTag = this.currentUser ? '[' + this.currentUser.name + '] ' : '';
            await this.api.writeFile(path, content, userTag + '\u{1F4DD} Quick note: ' + text.substring(0, 30));
            this.api.clearCache();
            this.toast('\u2705 \u30E1\u30E2\u8FFD\u52A0\u5B8C\u4E86');
            this.notifyWebhook('\u{1F4DD} \u30AF\u30A4\u30C3\u30AF\u30E1\u30E2', text);
            this.loadDashboard();
        } catch (e) { this.toast('\u274C ' + e.message); }
    }

    // =========== TODO ===========
    async loadTodos() {
        const list = document.getElementById('todo-list');
        if (!list) return;
        if (!this.api) { list.innerHTML = '<div class="loading">\u{1F6A7} GitHub\u63A5\u7D9A\u304C\u5FC5\u8981\u3067\u3059</div>'; return; }
        list.innerHTML = this.loading();
        try {
            const todos = await this.api.getTodos();
            this._todosCache = todos;

            // Build project filter dropdown
            const projects = [...new Set(todos.map(t => t.project))].sort();
            let filterHtml = '<div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
            filterHtml += '<select id="todo-project-filter" onchange="app.todoProjectFilter=this.value;app.renderTodoList()" style="padding:6px 10px;background:var(--bg-3);color:var(--text-1);border:1px solid var(--border-1);border-radius:var(--radius-xs);font-size:13px">';
            filterHtml += '<option value="">\u{1F4C1} \u5168\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8</option>';
            projects.forEach(p => filterHtml += '<option value="' + this.esc(p) + '"' + (this.todoProjectFilter === p ? ' selected' : '') + '>' + this.esc(p) + '</option>');
            filterHtml += '</select>';
            filterHtml += '<span style="font-size:12px;color:var(--text-4)">' + projects.length + ' \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8</span>';
            filterHtml += '</div>';

            list.innerHTML = filterHtml;
            this.renderTodoList();
        } catch (e) {
            console.error('[loadTodos]', e);
            list.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>';
        }
    }

    renderTodoList() {
        const list = document.getElementById('todo-list');
        if (!list || !this._todosCache) return;
        // Preserve the filter dropdown
        const dropdownRow = list.querySelector('div:first-child');

        const todos = this._todosCache;
        let filtered = todos;
        if (this.todoFilter === 'pending') filtered = todos.filter(t => !t.done);
        else if (this.todoFilter === 'done') filtered = todos.filter(t => t.done);
        if (this.todoProjectFilter) filtered = filtered.filter(t => t.project === this.todoProjectFilter);

        // Remove all children except the dropdown row
        while (list.children.length > 1) list.removeChild(list.lastChild);

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'loading';
            empty.textContent = this.todoFilter === 'pending' ? '\u{1F389} \u3059\u3079\u3066\u5B8C\u4E86\uFF01' : '\u{1F4CB} \u8A72\u5F53\u306A\u3057';
            list.appendChild(empty);
            return;
        }

        filtered.forEach(t => {
            const gIdx = todos.indexOf(t);
            const row = document.createElement('div');
            row.className = 'todo-item';
            const chk = document.createElement('div');
            chk.className = 'todo-check' + (t.done ? ' done' : '');
            chk.textContent = t.done ? '\u2713' : '';
            chk.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleTodo(gIdx);
            });
            const txt = document.createElement('span');
            txt.className = 'todo-text' + (t.done ? ' done-text' : '');
            txt.textContent = t.task;
            const proj = document.createElement('span');
            proj.className = 'todo-project';
            proj.textContent = t.project;
            const del = document.createElement('span');
            del.className = 'todo-delete';
            del.textContent = '\u{1F5D1}';
            del.title = '\u524A\u9664';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('\u300C' + t.task + '\u300D\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F')) this.deleteTodo(gIdx);
            });
            row.appendChild(chk);
            row.appendChild(txt);
            row.appendChild(proj);
            row.appendChild(del);
            list.appendChild(row);
        });
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:10px;text-align:center;color:var(--text-4);font-size:13px';
        summary.textContent = '\u2B1C ' + todos.filter(t => !t.done).length + ' \u672A\u5B8C\u4E86 | \u2705 ' + todos.filter(t => t.done).length + ' \u5B8C\u4E86';
        list.appendChild(summary);
    }

    async addTodo() {
        const input = document.getElementById('todo-input');
        const projInput = document.getElementById('todo-project-input');
        if (!input) return;
        const task = input.value.trim();
        if (!task) return this.toast('\u274C TODO\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044');
        if (!this.api) return this.toast('\u274C GitHub\u63A5\u7D9A\u304C\u5FC5\u8981\u3067\u3059');
        const proj = (projInput && projInput.value.trim()) || 'Home';
        input.value = '';
        this.toast('\u23F3 \u8FFD\u52A0\u4E2D...');
        try {
            const path = proj === 'Home' ? 'Home.md' : 'Projects/' + proj + '/' + proj + '.md';
            let content = '';
            try { content = await this.api.readFile(path); } catch (e) { content = '# ' + proj + '\n\n## TODO\n'; }
            content += '\n- [ ] ' + task;
            const userTag = this.currentUser ? '[' + this.currentUser.name + '] ' : '';
            await this.api.writeFile(path, content, userTag + '\u{1F4CB} Add TODO: ' + task.substring(0, 30));
            this.api.clearCache();
            this.toast('\u2705 TODO\u8FFD\u52A0: ' + task);
            this.notifyWebhook('\u{1F4CB} TODO\u8FFD\u52A0', task);
            this.loadTodos();
        } catch (e) { this.toast('\u274C ' + e.message); }
    }

    // =========== PROJECTS ===========
    async loadProjects() {
        const grid = document.getElementById('project-grid');
        grid.innerHTML = this.loading();
        try {
            const projects = await this.api.getProjects();
            grid.innerHTML = projects.map(p =>
                '<div class="project-card" data-project="' + this.esc(p.name) + '">' +
                '<h4>\u{1F4C1} ' + this.esc(p.name) + '</h4>' +
                '<div class="project-meta">' +
                '<span>\u{1F4C4} ' + p.files.length + ' files</span>' +
                '<span>\u{1F4BE} ' + (p.size / 1024).toFixed(1) + ' KB</span>' +
                '</div></div>'
            ).join('');

            grid.querySelectorAll('.project-card').forEach(card => {
                card.addEventListener('click', () => this.showProjectDetail(card.dataset.project));
            });
        } catch (e) { grid.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    async showProjectDetail(name) {
        const detail = document.getElementById('project-detail');
        detail.style.display = 'block';
        detail.innerHTML = this.loading();
        try {
            const files = await this.api.getMdFiles();
            const projFiles = files.filter(f => f.path.startsWith('Projects/' + name + '/'));
            detail.innerHTML =
                '<div class="card-header">\u{1F4C1} ' + this.esc(name) + '</div>' +
                projFiles.map(f =>
                    '<div class="ft-item ft-file" style="cursor:pointer" onclick="app.navigate(\'files\');app.previewFile(\'' + this.esc(f.path) + '\')">' +
                    '\u{1F4C4} ' + this.esc(f.path.split('/').pop()) + ' <span style="color:var(--text-4);font-size:11px">' + ((f.size || 0) / 1024).toFixed(1) + 'KB</span></div>'
                ).join('');
        } catch (e) { detail.innerHTML = '\u274C ' + this.esc(e.message); }
    }

    // =========== FILES ===========
    async loadFiles() {
        const tree = document.getElementById('file-tree');
        tree.innerHTML = this.loading();
        try {
            const files = await this.api.getMdFiles();
            const folders = {};
            files.forEach(f => {
                const parts = f.path.split('/');
                const folder = parts.length > 1 ? parts[0] : '/';
                if (!folders[folder]) folders[folder] = [];
                folders[folder].push(f);
            });

            tree.innerHTML = '';
            Object.keys(folders).sort().forEach(folder => {
                const fEl = document.createElement('div');
                fEl.className = 'ft-item ft-folder';
                fEl.textContent = '\u{1F4C1} ' + folder + ' (' + folders[folder].length + ')';
                const cls = 'fc_' + folder.replace(/[^a-zA-Z0-9]/g, '_');
                fEl.addEventListener('click', () => {
                    tree.querySelectorAll('.' + cls).forEach(c => c.style.display = c.style.display === 'none' ? 'block' : 'none');
                });
                tree.appendChild(fEl);

                folders[folder].forEach(f => {
                    const el = document.createElement('div');
                    el.className = 'ft-item ft-file ' + cls;
                    el.textContent = '\u{1F4C4} ' + f.path.split('/').pop();
                    el.style.display = 'none';
                    el.addEventListener('click', (e) => { e.stopPropagation(); this.previewFile(f.path); });
                    tree.appendChild(el);
                });
            });
        } catch (e) { tree.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    async previewFile(path) {
        const preview = document.getElementById('file-preview');
        preview.innerHTML = this.loading();
        try {
            const content = await this.api.readFile(path);
            const size = new Blob([content]).size;
            preview.innerHTML =
                '<div class="file-preview-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
                '<span class="file-preview-path">' + this.esc(path) + '</span>' +
                '<div style="display:flex;gap:8px;align-items:center">' +
                '<span class="file-preview-meta" style="font-size:12px;color:var(--text-4)">' + (size / 1024).toFixed(1) + ' KB</span>' +
                '<button class="btn btn-ghost btn-sm" onclick="app.editFile(\'' + this.esc(path.replace(/'/g, "\\'")) + '\')">\u270F\uFE0F \u7DE8\u96C6</button>' +
                '</div></div>' +
                (path.endsWith('.md') ? '<div class="md-preview">' + this.renderMarkdown(content) + '</div>' : '<pre>' + this.esc(content) + '</pre>');
        } catch (e) { preview.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    async editFile(path) {
        const preview = document.getElementById('file-preview');
        preview.innerHTML = this.loading();
        try {
            const content = await this.api.readFile(path, true);
            preview.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
                '<span style="font-weight:600">\u270F\uFE0F ' + this.esc(path) + '</span>' +
                '<div style="display:flex;gap:8px">' +
                '<button class="btn btn-ghost btn-sm" onclick="app.previewFile(\'' + this.esc(path.replace(/'/g, "\\'")) + '\')">\u274C \u30AD\u30E3\u30F3\u30BB\u30EB</button>' +
                '<button class="btn btn-primary btn-sm" onclick="app.saveFile(\'' + this.esc(path.replace(/'/g, "\\'")) + '\')">\u{1F4BE} \u4FDD\u5B58</button>' +
                '</div></div>' +
                '<textarea id="file-editor" style="width:100%;min-height:400px;background:var(--bg-0);color:var(--text-1);border:1px solid var(--border-1);border-radius:var(--radius-xs);padding:12px;font-family:monospace;font-size:13px;line-height:1.6;resize:vertical">' + this.esc(content) + '</textarea>';
        } catch (e) { preview.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    async saveFile(path) {
        const editor = document.getElementById('file-editor');
        if (!editor) return;
        const content = editor.value;
        this.toast('\u23F3 \u4FDD\u5B58\u4E2D...');
        try {
            const userTag = this.currentUser ? '[' + this.currentUser.name + '] ' : '';
            await this.api.writeFile(path, content, userTag + '\u270F\uFE0F Edit via Dashboard: ' + path.split('/').pop());
            this.api.clearCache();
            this.toast('\u2705 \u4FDD\u5B58\u5B8C\u4E86: ' + path.split('/').pop());
            this.notifyWebhook('\u270F\uFE0F \u30D5\u30A1\u30A4\u30EB\u7DE8\u96C6', path);
            this.previewFile(path);
        } catch (e) {
            console.error('[saveFile]', e);
            this.toast('\u274C ' + e.message);
        }
    }

    showCreateFile() { document.getElementById('create-file-form').style.display = 'block'; }

    async createFile() {
        const path = document.getElementById('new-file-path').value.trim();
        const content = document.getElementById('new-file-content').value;
        if (!path) return this.toast('\u274C \u30D1\u30B9\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044');
        try {
            const userTag = this.currentUser ? '[' + this.currentUser.name + '] ' : '';
            await this.api.writeFile(path, content, userTag + '\u{1F4C4} Create: ' + path);
            this.api.clearCache();
            document.getElementById('create-file-form').style.display = 'none';
            document.getElementById('new-file-path').value = '';
            document.getElementById('new-file-content').value = '';
            this.toast('\u2705 \u4F5C\u6210\u5B8C\u4E86: ' + path);
            this.notifyWebhook('\u{1F4C4} \u30D5\u30A1\u30A4\u30EB\u4F5C\u6210', path);
            this.loadFiles();
        } catch (e) { this.toast('\u274C ' + e.message); }
    }

    // =========== SEARCH ===========
    async doSearch() {
        const kw = document.getElementById('search-input').value.trim();
        if (!kw) return;
        const results = document.getElementById('search-results');
        results.innerHTML = this.loading();
        try {
            const hits = await this.api.search(kw);
            if (hits.length === 0) {
                results.innerHTML = '<div class="loading">\u{1F50D} "' + this.esc(kw) + '" \u2014 \u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F</div>';
                return;
            }
            results.innerHTML = hits.map(r =>
                '<div class="search-result" data-path="' + this.esc(r.file) + '">' +
                '<div class="result-file">\u{1F4C4} ' + this.esc(r.file) + ' <span style="color:var(--text-4)">(' + r.type + ')</span></div>' +
                '<div class="result-preview">' + this.esc(r.preview) + '</div></div>'
            ).join('');
            results.querySelectorAll('.search-result').forEach(el => {
                el.addEventListener('click', () => { this.navigate('files'); this.previewFile(el.dataset.path); });
            });
        } catch (e) { results.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    // =========== AI ===========
    setAiMode(mode) {
        this.aiMode = mode;
        document.querySelectorAll('.ai-tabs .tab').forEach(t => {
            t.classList.toggle('active', t.dataset.mode === mode);
        });
        const input = document.getElementById('ai-input');
        if (mode === 'ask') input.placeholder = 'Vault\u306B\u3064\u3044\u3066\u8CEA\u554F...';
        else if (mode === 'chat') input.placeholder = '\u4F55\u3067\u3082\u8CEA\u554F...';
        else input.placeholder = '\u751F\u6210\u3057\u305F\u3044\u30B3\u30FC\u30C9\u306E\u8AAC\u660E...';
    }

    async sendAi() {
        const input = document.getElementById('ai-input');
        const q = input.value.trim();
        if (!q) return;
        if (!this.gemini) return this.toast('\u274C Gemini API Key\u3092\u8A2D\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044');
        input.value = '';
        const chat = document.getElementById('ai-chat');
        chat.innerHTML += '<div class="ai-msg user"><div class="ai-bubble">' + this.esc(q) + '</div></div>';
        chat.innerHTML += '<div class="ai-msg bot"><div class="ai-bubble">\u{1F914} \u8003\u3048\u4E2D...</div></div>';
        chat.scrollTop = chat.scrollHeight;

        try {
            let context = '';
            if (this.aiMode === 'ask') {
                const files = await this.api.getMdFiles();
                const relevant = files.slice(0, 10);
                for (const f of relevant) {
                    try {
                        const c = await this.api.readFile(f.path);
                        context += '\n--- ' + f.path + ' ---\n' + c.substring(0, 500);
                    } catch (e) { /* skip */ }
                }
            } else if (this.aiMode === 'code') {
                context = 'Generate code based on this request. Output clean, production-quality code.';
            }
            const answer = await this.gemini.ask(q, context);
            const bubbles = chat.querySelectorAll('.ai-bubble');
            const lastBubble = bubbles[bubbles.length - 1];
            lastBubble.innerHTML = this.renderAiMarkdown(answer);
        } catch (e) {
            const bubbles = chat.querySelectorAll('.ai-bubble');
            const lastBubble = bubbles[bubbles.length - 1];
            lastBubble.textContent = '\u274C ' + e.message;
        }
        chat.scrollTop = chat.scrollHeight;
    }

    // =========== PINS ===========
    addPin() {
        const input = document.getElementById('pin-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        this.pins.unshift({ text, date: new Date().toISOString() });
        localStorage.setItem('vault_pins', JSON.stringify(this.pins));
        this.toast('\u{1F4CC} \u30D4\u30F3\u7559\u3081\u5B8C\u4E86');
        this.renderPins();
    }

    renderPins() {
        const list = document.getElementById('pin-list');
        if (!list) return;
        if (this.pins.length === 0) {
            list.innerHTML = '<div class="loading">\u{1F4CC} \u30D4\u30F3\u7559\u3081\u306A\u3057</div>';
            return;
        }
        list.innerHTML = this.pins.map((p, i) =>
            '<div class="pin-item">' +
            '<div class="pin-date">' + p.date.substring(0, 16).replace('T', ' ') +
            ' <span style="cursor:pointer;color:var(--red)" onclick="app.removePin(' + i + ')">\u2716</span></div>' +
            '<div class="pin-text">' + this.esc(p.text) + '</div></div>'
        ).join('');
    }

    removePin(i) {
        this.pins.splice(i, 1);
        localStorage.setItem('vault_pins', JSON.stringify(this.pins));
        this.renderPins();
    }

    // =========== TIMELINE ===========
    relativeTime(dateStr) {
        const now = new Date();
        const d = new Date(dateStr);
        const diffMs = now - d;
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return '\u305F\u3063\u305F\u4ECA';
        if (mins < 60) return mins + '\u5206\u524D';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + '\u6642\u9593\u524D';
        const days = Math.floor(hrs / 24);
        if (days < 7) return days + '\u65E5\u524D';
        if (days < 30) return Math.floor(days / 7) + '\u9031\u9593\u524D';
        return d.toLocaleDateString('ja-JP');
    }

    async loadTimeline() {
        const el = document.getElementById('timeline-content');
        el.innerHTML = this.loading();
        try {
            const commits = await this.api.getCommits(30);
            let lastDate = '';
            let html = '';
            commits.forEach(c => {
                const date = c.commit.author.date.substring(0, 10);
                if (date !== lastDate) {
                    html += '<div class="tl-date-header">\u{1F4C5} ' + date + '</div>';
                    lastDate = date;
                }
                const msg = c.commit.message.split('\n')[0];
                const rel = this.relativeTime(c.commit.author.date);
                // Extract file paths from commit message
                const files = c.files || [];
                html +=
                    '<div class="tl-item">' +
                    '<div class="tl-date">' + c.commit.author.date.substring(11, 16) + ' \u00B7 ' + rel + '</div>' +
                    '<div class="tl-msg">' + this.esc(msg) + '</div>' +
                    '<div class="tl-sha">' +
                    '<a href="https://github.com/' + this.api.repo + '/commit/' + c.sha + '" target="_blank" style="color:var(--accent-light);text-decoration:none">' +
                    c.sha.substring(0, 7) + '</a> by ' + this.esc(c.commit.author.name) +
                    '</div>';
                // File links extracted from commit message
                const pathMatch = msg.match(/(?:Update |Create |Delete |\u{1F4DD}|\u2705|\u{1F504}|\u{1F5D1})\s*(.+\.md)/u);
                if (pathMatch) {
                    const filePath = pathMatch[1].trim();
                    html += '<div style="margin-top:4px"><span class="tl-file-link" onclick="app.navigate(\'files\');app.previewFile(\'' + this.esc(filePath.replace(/'/g, "\\'")) + '\')" style="cursor:pointer;color:var(--cyan);font-size:12px;text-decoration:underline">\u{1F4C4} ' + this.esc(filePath) + '</span></div>';
                }
                html += '</div>';
            });
            el.innerHTML = html;
        } catch (e) { el.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    // =========== HEALTH ===========
    async runHealthCheck() {
        const el = document.getElementById('health-detail');
        el.innerHTML = this.loading();
        try {
            const h = await this.api.healthCheck();
            const color = h.score >= 80 ? 'var(--green)' : h.score >= 60 ? 'var(--yellow)' : 'var(--red)';
            const label = h.score >= 80 ? '\u{1F7E2} Excellent' : h.score >= 60 ? '\u{1F7E1} Good' : '\u{1F7E0} Needs Work';

            let html = '<div class="card"><div class="health-score-wrap">' +
                '<div class="health-score-num" style="color:' + color + '">' + h.score + '</div>' +
                '<div class="health-score-label">' + label + '</div>' +
                '</div><div class="health-bar"><div class="health-bar-fill" style="width:' + h.score + '%;background:' + color + '"></div></div></div>';

            html += '<div class="card"><div class="card-header">\u{1F4CA} \u7D71\u8A08</div>' +
                '<div class="bot-stat-row"><span>\u7DCF\u30CE\u30FC\u30C8\u6570</span><span>' + h.stats.total + '</span></div>' +
                '<div class="bot-stat-row"><span>\u7A7A\u30D5\u30A1\u30A4\u30EB</span><span>' + h.stats.empty + '</span></div>' +
                '<div class="bot-stat-row"><span>\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u6570</span><span>' + h.stats.projects + '</span></div></div>';

            if (h.issues.length > 0) {
                html += '<div class="card"><div class="card-header">\u26A0\uFE0F \u554F\u984C\u70B9</div>' +
                    h.issues.map(i => '<div class="health-issue">' + this.esc(i) + '</div>').join('') + '</div>';
            }

            html += '<div class="card"><div class="card-header">\u{1F4C2} \u30D5\u30A9\u30EB\u30C0\u5206\u5E03</div>' +
                Object.entries(h.folders).sort((a, b) => b[1] - a[1]).map(([f, c]) =>
                    '<div class="bot-stat-row"><span>' + this.esc(f) + '</span><span>' + c + '</span></div>'
                ).join('') + '</div>';

            el.innerHTML = html;
        } catch (e) { el.innerHTML = '<div class="loading">\u274C ' + this.esc(e.message) + '</div>'; }
    }

    // =========== TODO TOGGLE ===========
    async toggleTodo(idx) {
        const t = this._todosCache[idx];
        if (!t) { this.toast('\u274C \u30BF\u30B9\u30AF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093'); return; }
        this.toast('\u23F3 \u5207\u308A\u66FF\u3048\u4E2D...');
        try {
            // Use fresh=true to bypass all caches
            this.api.clearCache();
            const content = await this.api.readFile(t.file, true);
            let updated;
            if (t.done) {
                updated = content.replace('- [x] ' + t.task, '- [ ] ' + t.task);
            } else {
                updated = content.replace('- [ ] ' + t.task, '- [x] ' + t.task);
                if (updated === content) updated = content.replace('- [/] ' + t.task, '- [x] ' + t.task);
            }
            if (updated === content) {
                this.toast('\u274C \u30D5\u30A1\u30A4\u30EB\u5185\u306B\u30BF\u30B9\u30AF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093');
                return;
            }
            const msg = t.done
                ? '\u{1F504} Reopen: ' + t.task.substring(0, 30)
                : '\u2705 Done: ' + t.task.substring(0, 30);
            const userTag = this.currentUser ? '[' + this.currentUser.name + '] ' : '';
            await this.api.writeFile(t.file, updated, userTag + msg);
            this.api.clearCache();
            this.toast(t.done ? '\u{1F504} \u672A\u5B8C\u4E86\u306B\u623B\u3057\u307E\u3057\u305F' : '\u2705 \u5B8C\u4E86\uFF01');
            this.notifyWebhook(t.done ? '\u{1F504} TODO\u518D\u958B' : '\u2705 TODO\u5B8C\u4E86', t.task);
            this.loadTodos();
        } catch (e) {
            console.error('[toggleTodo]', e);
            this.toast('\u274C ' + e.message);
        }
    }

    // =========== TODO DELETE ===========
    async deleteTodo(idx) {
        const t = this._todosCache[idx];
        if (!t) { this.toast('\u274C \u30BF\u30B9\u30AF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093'); return; }
        this.toast('\u23F3 \u524A\u9664\u4E2D...');
        try {
            this.api.clearCache();
            const content = await this.api.readFile(t.file, true);
            const marker = t.done ? '- [x] ' : '- [ ] ';
            const altMarker = '- [/] ';
            const lines = content.split('\n');
            const filtered = lines.filter(line => {
                const trimmed = line.trim();
                return !(trimmed === marker + t.task || trimmed === altMarker + t.task);
            });
            if (filtered.length === lines.length) {
                this.toast('\u274C \u30D5\u30A1\u30A4\u30EB\u5185\u306B\u30BF\u30B9\u30AF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093');
                return;
            }
            const updated = filtered.join('\n');
            await this.api.writeFile(t.file, updated, '\u{1F5D1} Delete TODO: ' + t.task.substring(0, 30));
            this.api.clearCache();
            this.toast('\u{1F5D1}\uFE0F \u524A\u9664\u5B8C\u4E86: ' + t.task);
            this.notifyWebhook('\u{1F5D1} TODO\u524A\u9664', t.task);
            this.loadTodos();
        } catch (e) {
            console.error('[deleteTodo]', e);
            this.toast('\u274C ' + e.message);
        }
    }

    // =========== WEBHOOK NOTIFICATION ===========
    async notifyWebhook(action, detail) {
        // Log to notification center
        const userLabel = this.currentUser ? ' (' + this.currentUser.name + ')' : '';
        this.addNotification(action + userLabel, detail);
        if (!this.webhookUrl) return;
        try {
            const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: action,
                        description: detail,
                        color: 0x6366f1,
                        footer: { text: '\u{1F310} Vault Dashboard | ' + now },
                        thumbnail: { url: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/obsidian.png' }
                    }]
                })
            });
        } catch (e) { /* silent fail */ }
    }

    // =========== SETTINGS ===========
    updateGeminiKey() {
        const key = document.getElementById('setting-gemini').value.trim();
        if (key) {
            localStorage.setItem('vault_gemini', key);
            this.gemini = new GeminiAPI(key);
            this.toast('\u2705 Gemini API Key \u66F4\u65B0\u5B8C\u4E86');
        }
    }

    updateWebhook() {
        const url = document.getElementById('setting-webhook').value.trim();
        localStorage.setItem('vault_webhook', url);
        this.webhookUrl = url;
        this.toast('\u2705 Webhook URL \u66F4\u65B0\u5B8C\u4E86');
        if (url) this.notifyWebhook('\u{1F517} Webhook\u63A5\u7D9A\u30C6\u30B9\u30C8', 'Vault Dashboard\u304B\u3089\u306E\u901A\u77E5\u304C\u6709\u52B9\u306B\u306A\u308A\u307E\u3057\u305F');
    }

    clearCache() {
        if (this.api) this.api.clearCache();
        this.toast('\u{1F5D1}\uFE0F \u30AD\u30E3\u30C3\u30B7\u30E5\u30AF\u30EA\u30A2');
    }

    async syncNow() {
        this.toast('\u{1F504} Sync\u958B\u59CB...');
        try {
            // Try to trigger GitHub Actions workflow_dispatch for vault-sync
            if (this.api) {
                try {
                    const res = await fetch('https://api.github.com/repos/' + this.api.repo + '/dispatches', {
                        method: 'POST',
                        headers: {
                            'Authorization': 'token ' + this.api.token,
                            'Accept': 'application/vnd.github.v3+json',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ event_type: 'vault-sync' })
                    });
                    if (res.ok || res.status === 204) {
                        this.toast('\u2705 GitHub Sync\u30C8\u30EA\u30AC\u30FC\u6210\u529F\uFF01');
                        this.notifyWebhook('\u{1F504} Sync Now', '\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u304B\u3089\u624B\u52D5Sync\u3092\u5B9F\u884C');
                        // Reload dashboard data
                        if (this.api) this.api.clearCache();
                        setTimeout(() => this.loadDashboard(), 2000);
                        return;
                    }
                } catch (e) { /* fallback below */ }
            }
            // Fallback: copy git command to clipboard
            const cmd = 'cd "C:\\Users\\swamp\\.gemini\\Antigravity-workspace" && git pull && git add -A && git commit -m "sync" && git push';
            await navigator.clipboard.writeText(cmd);
            this.toast('\u{1F4CB} Git\u30B3\u30DE\u30F3\u30C9\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F\uFF01\u30BF\u30FC\u30DF\u30CA\u30EB\u306B\u8CBC\u308A\u4ED8\u3051\u3066\u304F\u3060\u3055\u3044');
            this.notifyWebhook('\u{1F504} Sync Now (\u624B\u52D5)', '\u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u306B\u30B3\u30DE\u30F3\u30C9\u30B3\u30D4\u30FC\u6E08\u307F');
        } catch (e) {
            console.error('[syncNow]', e);
            this.toast('\u274C Sync\u5931\u6557: ' + e.message);
        }
    }

    // ===========================================
    //  v3.0 — Evolution Features
    // ===========================================

    // =========== COMMAND PALETTE ===========
    openCmd() {
        const overlay = document.getElementById('cmd-overlay');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        const input = document.getElementById('cmd-input');
        input.value = '';
        input.focus();
        this._cmdIdx = 0;
        this.renderCmdResults('');
    }

    closeCmd() {
        document.getElementById('cmd-overlay')?.classList.add('hidden');
    }

    renderCmdResults(query) {
        const results = document.getElementById('cmd-results');
        if (!results) return;
        const pages = [
            { icon: '\u{1F4CA}', label: '\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9', action: 'dashboard', hint: '1' },
            { icon: '\u{1F4CB}', label: 'TODO', action: 'todos', hint: '2' },
            { icon: '\u{1F4C1}', label: '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8', action: 'projects', hint: '3' },
            { icon: '\u{1F4C2}', label: '\u30D5\u30A1\u30A4\u30EB', action: 'files', hint: '4' },
            { icon: '\u{1F50D}', label: '\u691C\u7D22', action: 'search', hint: '5' },
            { icon: '\u{1F916}', label: 'AI \u30A2\u30B7\u30B9\u30BF\u30F3\u30C8', action: 'ai', hint: '6' },
            { icon: '\u{1F4CC}', label: '\u30D4\u30F3\u7559\u3081', action: 'pins', hint: '7' },
            { icon: '\u{1F4C5}', label: '\u30BF\u30A4\u30E0\u30E9\u30A4\u30F3', action: 'timeline', hint: '8' },
            { icon: '\u{1F3E5}', label: '\u30D8\u30EB\u30B9\u30C1\u30A7\u30C3\u30AF', action: 'health', hint: '9' },
            { icon: '\u{1F517}', label: '\u30B5\u30FC\u30D3\u30B9\u30CF\u30D6', action: 'services', hint: '' },
            { icon: '\u{1F4E1}', label: 'Bot\u7BA1\u7406', action: 'bot', hint: '' },
            { icon: '\u2699\uFE0F', label: '\u8A2D\u5B9A', action: 'settings', hint: '0' },
            { icon: '\u{1F5D1}', label: '\u30AD\u30E3\u30C3\u30B7\u30E5\u30AF\u30EA\u30A2', action: 'clearCache', hint: '' },
            { icon: '\u{1F514}', label: '\u901A\u77E5\u30BB\u30F3\u30BF\u30FC', action: 'notifications', hint: '' },
            { icon: '\u{1F504}', label: 'Sync Now', action: 'syncNow', hint: '' },
        ];
        const q = query.toLowerCase();
        const filtered = q ? pages.filter(p => p.label.toLowerCase().includes(q) || p.action.includes(q)) : pages;
        this._cmdItems = filtered;
        this._cmdIdx = Math.min(this._cmdIdx, Math.max(filtered.length - 1, 0));

        results.innerHTML = filtered.map((p, i) =>
            '<div class="cmd-item' + (i === this._cmdIdx ? ' active' : '') + '" data-idx="' + i + '">' +
            '<span class="cmd-item-icon">' + p.icon + '</span>' +
            '<span class="cmd-item-label">' + this.esc(p.label) + '</span>' +
            (p.hint ? '<span class="cmd-item-hint"><kbd>' + p.hint + '</kbd></span>' : '') +
            '</div>'
        ).join('');

        results.querySelectorAll('.cmd-item').forEach(item => {
            item.addEventListener('click', () => this.execCmdItem(parseInt(item.dataset.idx)));
        });
    }

    execCmdItem(idx) {
        const item = this._cmdItems[idx];
        if (!item) return;
        this.closeCmd();
        if (item.action === 'clearCache') { this.clearCache(); }
        else if (item.action === 'notifications') { this.toggleNotifPanel(); }
        else if (item.action === 'syncNow') { this.syncNow(); }
        else { this.navigate(item.action); }
    }

    handleCmdKey(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._cmdIdx = Math.min(this._cmdIdx + 1, (this._cmdItems || []).length - 1);
            this.renderCmdResults(document.getElementById('cmd-input')?.value || '');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._cmdIdx = Math.max(this._cmdIdx - 1, 0);
            this.renderCmdResults(document.getElementById('cmd-input')?.value || '');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            this.execCmdItem(this._cmdIdx);
        } else if (e.key === 'Escape') {
            this.closeCmd();
        }
    }

    // =========== KEYBOARD SHORTCUTS ===========
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore when typing in inputs
            const tag = document.activeElement?.tagName;
            const isCmd = document.getElementById('cmd-overlay')?.classList.contains('hidden') === false;

            if (isCmd) {
                this.handleCmdKey(e);
                return;
            }

            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            // Ctrl+K or Cmd+K — Command Palette
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                this.openCmd();
                return;
            }

            // Number keys for page navigation
            const pageMap = { '1': 'dashboard', '2': 'todos', '3': 'projects', '4': 'files', '5': 'search', '6': 'ai', '7': 'pins', '8': 'timeline', '9': 'health', '0': 'settings' };
            if (pageMap[e.key] && !e.ctrlKey && !e.metaKey) {
                this.navigate(pageMap[e.key]);
                return;
            }

            // / — Focus search
            if (e.key === '/') {
                e.preventDefault();
                this.navigate('search');
                setTimeout(() => document.getElementById('search-input')?.focus(), 100);
            }
        });
    }

    // =========== CONTRIBUTION GRAPH ===========
    async renderContribGraph() {
        const el = document.getElementById('contrib-graph');
        if (!el || !this.api) return;
        try {
            const commits = await this.api.getCommits(100);
            // Count commits per day for last 12 weeks
            const counts = {};
            const now = new Date();
            commits.forEach(c => {
                const d = c.commit.author.date.substring(0, 10);
                counts[d] = (counts[d] || 0) + 1;
            });

            let html = '<div class="contrib-grid">';
            for (let w = 11; w >= 0; w--) {
                html += '<div class="contrib-week">';
                for (let d = 0; d < 7; d++) {
                    const date = new Date(now);
                    date.setDate(date.getDate() - (w * 7 + (6 - d)));
                    const key = date.toISOString().substring(0, 10);
                    const count = counts[key] || 0;
                    const level = count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 7 ? 3 : 4;
                    html += '<div class="contrib-cell" data-level="' + level + '" title="' + key + ': ' + count + ' commits"></div>';
                }
                html += '</div>';
            }
            html += '</div>';
            html += '<div class="contrib-legend">Less ';
            for (let i = 0; i <= 4; i++) html += '<div class="contrib-cell" data-level="' + i + '" style="display:inline-block;width:10px;height:10px"></div>';
            html += ' More</div>';
            el.innerHTML = html;
        } catch (e) { el.innerHTML = '<span style="color:var(--text-4);font-size:12px">\u30C7\u30FC\u30BF\u53D6\u5F97\u5931\u6557</span>'; }
    }

    // =========== NOTIFICATION CENTER ===========
    toggleNotifPanel() {
        document.getElementById('notif-panel')?.classList.toggle('open');
        this.renderNotifications();
    }

    addNotification(title, detail) {
        const notifs = JSON.parse(localStorage.getItem('vault_notifs') || '[]');
        notifs.unshift({ title, detail, time: new Date().toISOString() });
        if (notifs.length > 50) notifs.length = 50;
        localStorage.setItem('vault_notifs', JSON.stringify(notifs));
    }

    renderNotifications() {
        const list = document.getElementById('notif-list');
        if (!list) return;
        const notifs = JSON.parse(localStorage.getItem('vault_notifs') || '[]');
        if (notifs.length === 0) {
            list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-4)">\u{1F514} \u901A\u77E5\u306A\u3057</div>';
            return;
        }
        list.innerHTML = notifs.map(n =>
            '<div class="notif-item">' +
            '<div class="notif-title">' + this.esc(n.title) + '</div>' +
            '<div class="notif-detail">' + this.esc(n.detail) + '</div>' +
            '<div class="notif-time">' + this.relativeTime(n.time) + '</div>' +
            '</div>'
        ).join('');
    }

    // =========== AI MARKDOWN RENDERING ===========
    renderAiMarkdown(text) {
        // Simple markdown: code blocks, inline code, bold, lists
        let html = this.esc(text);
        // Code blocks ```
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Lists
        html = html.replace(/^- (.+)$/gm, '<div style="padding-left:12px">\u2022 $1</div>');
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    // =========== ENHANCED DASHBOARD ===========
    async loadDashboardExtras() {
        // Contribution graph
        this.renderContribGraph();

        // Recent files from commits
        try {
            const commits = await this.api.getCommits(5);
            const recentEl = document.getElementById('recent-mini');
            if (recentEl && commits.length) {
                recentEl.innerHTML = commits.map(c => {
                    const msg = c.commit.message.substring(0, 45);
                    const time = this.relativeTime(c.commit.author.date);
                    const sha = c.sha.substring(0, 7);
                    return '<div class="recent-file">' +
                        '<span class="rf-icon">\u{1F4DD}</span>' +
                        '<span class="rf-name">' + this.esc(msg) + '</span>' +
                        '<span class="rf-time">' + time + '</span>' +
                        '</div>';
                }).join('');
            }
        } catch (e) { }

        // TODO count for health mini
        try {
            const healthEl = document.getElementById('health-mini');
            if (healthEl && this._todosCache) {
                const pending = this._todosCache.filter(t => !t.done).length;
                const done = this._todosCache.filter(t => t.done).length;
                const pct = (pending + done) > 0 ? Math.round(done / (pending + done) * 100) : 0;
                healthEl.innerHTML =
                    '<div style="font-size:28px;font-weight:800;background:var(--grad-1);-webkit-background-clip:text;-webkit-text-fill-color:transparent">' + pct + '%</div>' +
                    '<div style="font-size:12px;color:var(--text-4);margin-top:4px">' + pending + ' \u672A\u5B8C\u4E86 / ' + done + ' \u5B8C\u4E86</div>' +
                    '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
            }
        } catch (e) { }
    }
}

// Boot — use var so inline onclick="app.xxx()" handlers can find it
var app = new VaultApp();

// Global keyboard shortcuts
app.setupKeyboardShortcuts();

// Command palette input handler
document.getElementById('cmd-input')?.addEventListener('input', (e) => {
    app._cmdIdx = 0;
    app.renderCmdResults(e.target.value);
});
