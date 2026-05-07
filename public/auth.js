/* ============================================================
   AG Shop Pro — Auth & workspace session
   Production: API sessions (Bearer token) + /api/workspaces
   Local-only: optional demo accounts (localhost / 127.0.0.1)
   ============================================================ */

const AUTH = {

  API_BASE: '',

  ROLE_PORTAL: {
    super_admin:     'superadmin.html',
    manager:         'manager.html',
    service_advisor: 'service.html',
    technician:      'tech.html',
  },

  isDemoHost() {
    try {
      const h = window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1';
    } catch (e) {
      return false;
    }
  },

  isDemoSession(s) {
    return !!(s && s.demo === true);
  },

  sessionKey: 'agshopro_session',

  getSession() {
    try {
      return JSON.parse(sessionStorage.getItem(this.sessionKey) || 'null');
    } catch (e) {
      return null;
    }
  },

  setSession(data) {
    sessionStorage.setItem(this.sessionKey, JSON.stringify(data));
  },

  clearSession() {
    sessionStorage.removeItem(this.sessionKey);
  },

  async fetchWorkspaces(token) {
    const res = await fetch(`${this.API_BASE}/api/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
    });
    if (!res.ok) return [];
    return res.json();
  },

  async applyAuthPayload(payload) {
    const tok = payload.token;
    const u = payload.user;
    const workspaces = await this.fetchWorkspaces(tok);
    const first = workspaces[0];
    this.setSession({
      token: tok,
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      workspaceIds: u.workspaceIds || [],
      workspaces,
      activeWorkspaceId: first != null ? first.id : null,
      activeWorkspaceName: first != null ? first.name : '',
      loginTime: Date.now(),
    });
  },

  async loginWithApi(email, password) {
    try {
      const res = await fetch(`${this.API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || 'Sign in failed.' };
      }
      await this.applyAuthPayload({ token: data.token, user: data.user });
      return { ok: true, role: data.user.role };
    } catch (e) {
      return { ok: false, error: 'Unable to reach server. Check your connection.' };
    }
  },

  logout() {
    const s = this.getSession();
    const token = s && s.token;
    if (token) {
      fetch(`${this.API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
      }).catch(() => {});
    }
    this.clearSession();
    window.location.replace('login.html');
  },

  requireAuth() {
    const s = this.getSession();
    if (!s || !s.role) {
      window.location.replace('login.html');
      return null;
    }
    if (!s.token && !this.isDemoSession(s)) {
      window.location.replace('login.html');
      return null;
    }
    return s;
  },

  canAccessRole(session, allowedRoles) {
    const s = session || this.getSession();
    if (!s || !s.role) return false;
    return Array.isArray(allowedRoles) && allowedRoles.includes(s.role);
  },

  requireRoles(allowedRoles) {
    const s = this.requireAuth();
    if (!s) return null;
    if (!this.canAccessRole(s, allowedRoles)) {
      const fallback = this.ROLE_PORTAL[s.role] || 'login.html';
      window.location.replace(fallback);
      return null;
    }
    return s;
  },

  async apiFetch(url, options) {
    const s = this.requireAuth();
    if (!s) throw new Error('Unauthorized');
    const headers = Object.assign({}, options?.headers || {});
    if (s.token) headers.Authorization = `Bearer ${s.token}`;
    const res = await fetch(url, Object.assign({}, options || {}, {
      headers,
      credentials: 'same-origin',
    }));
    if (res.status === 401) {
      this.clearSession();
      window.location.replace('login.html');
      throw new Error('Session expired');
    }
    return res;
  },

  getMyWorkspaces(session) {
    const s = session || this.getSession();
    if (!s) return [];
    if (s.workspaces && Array.isArray(s.workspaces)) {
      if (s.role === 'super_admin') return s.workspaces;
      const ids = new Set((s.workspaceIds || []).map((x) => Number(x)));
      return s.workspaces.filter((w) => ids.has(Number(w.id)));
    }
    return [];
  },

  switchWorkspace(wsId) {
    const s = this.getSession();
    if (!s) return;
    const list = this.getMyWorkspaces(s);
    const ws = list.find((w) => String(w.id) === String(wsId));
    if (!ws) return;
    s.activeWorkspaceId = ws.id;
    s.activeWorkspaceName = ws.name;
    this.setSession(s);
  },

  /* ── Demo-only: seeded localStorage users (localhost) ── */
  WORKSPACES: [
    { id: 1, name: 'Capitol Auto Body',      address: '1234 Main St, Silver Spring MD', type: 'body_shop',  plan: 'pro',     active: true },
    { id: 2, name: 'Silver Spring Mechanics', address: '500 Georgia Ave, Silver Spring MD', type: 'mechanic',  plan: 'pro',     active: true },
    { id: 3, name: 'Bethesda Quick Lube',     address: '900 Wisconsin Ave, Bethesda MD',  type: 'quick_lube', plan: 'starter', active: true },
  ],

  USERS: [
    { id: 'u-001', email: 'naod@agholdingcorp.com',     password: 'Admin123!',  name: 'Naod Mekonnen',  role: 'super_admin',     workspaces: [1, 2, 3], phone: '3015550100' },
    { id: 'u-002', email: 'abraham@agholdingcorp.com',  password: 'Admin123!',  name: 'Abraham Lema',   role: 'super_admin',     workspaces: [1, 2, 3], phone: '2405550102' },
    { id: 'u-003', email: 'maria@capitolauto.com',      password: 'Manager1!',  name: 'Maria Gonzalez', role: 'manager',         workspaces: [1],                  phone: '2405550120' },
    { id: 'u-004', email: 'alex@capitolauto.com',       password: 'Tech1234!',  name: 'Alex Torres',    role: 'technician',      workspaces: [1],                  phone: '2405550181' },
    { id: 'u-005', email: 'james@capitolauto.com',      password: 'Tech1234!',  name: 'James Reed',     role: 'technician',      workspaces: [1],                  phone: '3015550155' },
    { id: 'u-006', email: 'david@silverspringmech.com', password: 'Advisor1!',  name: 'David Park',     role: 'service_advisor', workspaces: [2],                  phone: '3015550210' },
    { id: 'u-007', email: 'sarah@silverspringmech.com', password: 'Tech1234!',  name: 'Sarah Johnson',  role: 'technician',      workspaces: [2],                  phone: '2405550245' },
    { id: 'u-008', email: 'mike@bethesda.com',          password: 'Tech1234!',  name: 'Mike Santos',    role: 'technician',      workspaces: [3],                  phone: '5715550188' },
    { id: 'u-d1',  email: 'demo@manager.com',           password: 'demo',       name: 'Demo Manager',   role: 'manager',         workspaces: [1],                  phone: '0000000000' },
    { id: 'u-d2',  email: 'demo@tech.com',              password: 'demo',       name: 'Demo Tech',      role: 'technician',      workspaces: [1],                  phone: '0000000001' },
    { id: 'u-d3',  email: 'demo@service.com',           password: 'demo',       name: 'Demo Advisor',   role: 'service_advisor', workspaces: [1],                  phone: '0000000002' },
    { id: 'u-d4',  email: 'demo@admin.com',             password: 'demo',       name: 'Demo Admin',     role: 'super_admin',     workspaces: [1, 2, 3], phone: '0000000003' },
  ],

  getUsers() {
    return JSON.parse(localStorage.getItem('agshopro_users') || 'null') || this.USERS;
  },

  getWS() {
    return JSON.parse(localStorage.getItem('agshopro_ws') || 'null') || this.WORKSPACES;
  },

  login(email, password) {
    const users = this.getUsers();
    const u = users.find((x) => x.email.toLowerCase() === email.toLowerCase() && x.password === password);
    if (!u) return { ok: false, error: 'Incorrect email or password.' };
    const ws = this.getWS();
    const myWS = ws.filter((w) => u.workspaces.map(Number).includes(Number(w.id)));
    const activeWS = myWS[0] || null;
    this.setSession({
      demo: true,
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      workspaceIds: u.workspaces,
      workspaces: myWS,
      activeWorkspaceId: activeWS != null ? activeWS.id : null,
      activeWorkspaceName: activeWS != null ? activeWS.name : '',
      loginTime: Date.now(),
    });
    return { ok: true, role: u.role };
  },
};

window.AUTH = AUTH;
