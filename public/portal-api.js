/* ============================================================
   AG Shop Pro — Customer portal session & API layer
   Separate from AUTH/API: a portal session authenticates a
   customer (customer_sessions), not a staff user, and must never
   be interchangeable with a staff token.
   ============================================================ */

const PORTAL = {

  API_BASE: '',
  sessionKey: 'agshopro_portal_session',

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

  /** Shops a customer can sign in to. Public endpoint. */
  async workspaces() {
    const res = await fetch(`${this.API_BASE}/api/customer/workspaces`);
    if (!res.ok) throw new PortalError('Unable to load shops. Please try again.');
    return res.json();
  },

  async login(email, password, workspaceId) {
    let res;
    try {
      res = await fetch(`${this.API_BASE}/api/customer/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, workspaceId }),
      });
    } catch (e) {
      return { ok: false, error: 'Unable to reach the server. Check your connection.' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Sign in failed.' };

    this.setSession({
      token: data.sessionToken,
      customer: data.customer,
      workspaceId,
      loginTime: Date.now(),
    });
    return { ok: true };
  },

  logout() {
    const s = this.getSession();
    if (s && s.token) {
      fetch(`${this.API_BASE}/api/customer/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}` },
      }).catch(() => {});
    }
    this.clearSession();
    window.location.replace('portal-login.html');
  },

  requireAuth() {
    const s = this.getSession();
    if (!s || !s.token) {
      window.location.replace('portal-login.html');
      return null;
    }
    return s;
  },

  /**
   * Authenticated JSON request. Throws PortalError with a user-safe message.
   */
  async request(path, { method = 'GET', body } = {}) {
    const s = this.requireAuth();
    if (!s) throw new PortalError('Unauthorized');

    const headers = { Authorization: `Bearer ${s.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`${this.API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortalError('Unable to reach the server. Check your connection.');
    }

    if (res.status === 401) {
      this.clearSession();
      window.location.replace('portal-login.html');
      throw new PortalError('Session expired');
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }

    if (!res.ok) {
      throw new PortalError((data && data.error) || 'Something went wrong. Please try again.', res.status);
    }
    return data;
  },

  get:   (p)        => PORTAL.request(p),
  post:  (p, body)  => PORTAL.request(p, { method: 'POST', body }),
  patch: (p, body)  => PORTAL.request(p, { method: 'PATCH', body }),
  del:   (p)        => PORTAL.request(p, { method: 'DELETE' }),

  /* ── Endpoints ── */
  profile:        ()        => PORTAL.get('/api/customer/profile'),
  updateProfile:  (b)       => PORTAL.patch('/api/customer/profile', b),
  changePassword: (b)       => PORTAL.patch('/api/customer/change-password', b),
  vehicles:       ()        => PORTAL.get('/api/customer/vehicles'),
  serviceHistory: ()        => PORTAL.get('/api/customer/service-history'),
  appointments:   ()        => PORTAL.get('/api/customer/appointments'),
  book:           (b)       => PORTAL.post('/api/customer/appointments', b),
  cancel:         (id)      => PORTAL.del(`/api/customer/appointments/${id}`),
  feedback:       (b)       => PORTAL.post('/api/customer/feedback', b),

  /* ── Formatting (mirrors api.js so the portal reads the same) ── */
  money(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '$0.00';
  },

  /**
   * A bare "YYYY-MM-DD" (an appointment's preferred_date) is a calendar date,
   * not an instant: new Date('2026-07-20') is UTC midnight and renders as the
   * 19th west of UTC. Build it in local time instead.
   */
  date(value) {
    if (!value) return '—';
    if (typeof value === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
      if (m) {
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
          .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      }
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  },

  statusLabel(status) {
    return String(status || '')
      .split('_').filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ') || '—';
  },

  vehicleLabel(v) {
    if (!v) return '—';
    return [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
  },

  escape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  },

  /* ── State rendering ── */
  async load(el, fn, { empty } = {}) {
    if (!el) return fn();
    el.innerHTML = '<div class="state">Loading…</div>';
    try {
      const data = await fn();
      if (empty && (data == null || (Array.isArray(data) && data.length === 0))) {
        el.innerHTML = `<div class="state">${this.escape(empty)}</div>`;
      }
      return data;
    } catch (e) {
      if (e.message === 'Session expired' || e.message === 'Unauthorized') return undefined;
      const id = `r${Math.random().toString(36).slice(2, 8)}`;
      el.innerHTML =
        `<div class="state state-error">${this.escape(e.message)}` +
        `<button id="${id}" class="btn btn-secondary" style="margin-top:10px">Retry</button></div>`;
      const btn = el.querySelector(`#${id}`);
      if (btn) btn.addEventListener('click', () => this.load(el, fn, { empty }));
      return undefined;
    }
  },

  toast(message, type = 'info') {
    let host = document.getElementById('portal-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'portal-toast-host';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;gap:8px';
      document.body.appendChild(host);
    }
    const colors = { success: '#065f46', error: '#b91c1c', info: '#1f2937' };
    const node = document.createElement('div');
    node.setAttribute('role', 'status');
    node.style.cssText =
      `background:${colors[type] || colors.info};color:#fff;padding:10px 16px;border-radius:8px;` +
      'font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:340px';
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), type === 'error' ? 6000 : 3500);
  },

  /** Submit wiring with validation + button disabling, mirroring API.onSubmit. */
  onSubmit(form, handler, { validate } = {}) {
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const data = Object.fromEntries(new FormData(form).entries());

      form.querySelectorAll('.field-error').forEach((n) => n.remove());
      const errors = validate ? validate(data) || {} : {};
      if (Object.keys(errors).length) {
        Object.entries(errors).forEach(([name, message]) => {
          const field = form.querySelector(`[name="${name}"]`);
          const note = document.createElement('div');
          note.className = 'field-error';
          note.textContent = message;
          if (field) field.insertAdjacentElement('afterend', note);
          else this.toast(message, 'error');
        });
        return;
      }

      const original = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
      try {
        await handler(data);
      } catch (e) {
        if (e.message !== 'Session expired' && e.message !== 'Unauthorized') {
          this.toast(e.message, 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = original; }
      }
    });
  },
};

class PortalError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
  }
}

window.PORTAL = PORTAL;
window.PortalError = PortalError;
