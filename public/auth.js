/* ============================================================
   AG Shop Pro — Auth & workspace session
   Staff sessions are issued by the API (Bearer token) and every
   page gate is advisory only: the API re-checks the token and the
   caller's role on every request.
   ============================================================ */

const AUTH = {

  API_BASE: '',

  ROLE_PORTAL: {
    super_admin:     'superadmin.html',
    manager:         'manager.html',
    service_advisor: 'service.html',
    technician:      'tech.html',
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
    if (!s || !s.role || !s.token) {
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

  getActiveWorkspaceId() {
    const s = this.getSession();
    return s ? s.activeWorkspaceId : null;
  },

  switchWorkspace(wsId) {
    const s = this.getSession();
    if (!s) return null;
    const list = this.getMyWorkspaces(s);
    const ws = list.find((w) => String(w.id) === String(wsId));
    if (!ws) return null;
    s.activeWorkspaceId = ws.id;
    s.activeWorkspaceName = ws.name;
    this.setSession(s);
    return ws;
  },
};

window.AUTH = AUTH;
