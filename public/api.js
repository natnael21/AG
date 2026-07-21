/* ============================================================
   AG Shop Pro — Shared frontend API layer
   Wraps AUTH.apiFetch with JSON handling, workspace scoping,
   error normalisation and small render helpers for the
   loading / empty / error states every page needs.
   ============================================================ */

const API = {

  /* ── Core request ── */

  /**
   * Perform an authenticated JSON request.
   * Throws ApiError with a user-safe .message on any non-2xx.
   */
  async request(path, { method = 'GET', body, query, workspace = true } = {}) {
    const params = new URLSearchParams();

    if (workspace) {
      const wsId = AUTH.getActiveWorkspaceId();
      if (wsId != null) params.set('workspaceId', wsId);
    }
    Object.entries(query || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    });

    const qs = params.toString();
    const url = `${AUTH.API_BASE}${path}${qs ? `?${qs}` : ''}`;

    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      // Workspace-scoped writes carry the id in the body too, since the
      // API reads workspaceId from either query or body.
      const payload = workspace && !Array.isArray(body)
        ? Object.assign({ workspaceId: AUTH.getActiveWorkspaceId() }, body)
        : body;
      options.body = JSON.stringify(payload);
    }

    let res;
    try {
      res = await AUTH.apiFetch(url, options);
    } catch (e) {
      if (e.message === 'Session expired' || e.message === 'Unauthorized') throw e;
      throw new ApiError('Unable to reach the server. Check your connection.', 0);
    }

    if (res.status === 204) return null;

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        if (!res.ok) throw new ApiError(this.messageForStatus(res.status), res.status);
        throw new ApiError('The server returned an unreadable response.', res.status);
      }
    }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || this.messageForStatus(res.status);
      throw new ApiError(msg, res.status, data);
    }

    return data;
  },

  messageForStatus(status) {
    switch (status) {
      case 400: return 'That request was not valid. Please check the form and try again.';
      case 403: return 'You do not have permission to do that.';
      case 404: return 'That record could not be found.';
      case 409: return 'That record already exists.';
      case 429: return 'Too many requests. Please wait a moment and try again.';
      case 503: return 'The service is temporarily unavailable. Please try again shortly.';
      default:  return status >= 500
        ? 'Something went wrong on our end. Please try again.'
        : 'The request failed. Please try again.';
    }
  },

  get(path, query, opts)        { return this.request(path, { ...opts, method: 'GET', query }); },
  post(path, body, opts)        { return this.request(path, { ...opts, method: 'POST', body }); },
  patch(path, body, opts)       { return this.request(path, { ...opts, method: 'PATCH', body }); },
  del(path, opts)               { return this.request(path, { ...opts, method: 'DELETE' }); },

  /* ── Endpoints ── */

  customers:      (q)          => API.get('/api/customers', q),
  customer:       (id)         => API.get(`/api/customers/${id}`),
  customerHistory:(id)         => API.get(`/api/customers/${id}/history`),
  createCustomer: (b)          => API.post('/api/customers', b),

  vehicles:       (q)          => API.get('/api/vehicles', q),
  createVehicle:  (b)          => API.post('/api/vehicles', b),

  repairOrders:   (q)          => API.get('/api/repair-orders', q),
  repairOrder:    (id)         => API.get(`/api/repair-orders/${id}`),
  createRO:       (b)          => API.post('/api/repair-orders', b),
  updateRO:       (id, b)      => API.patch(`/api/repair-orders/${id}`, b),
  setROStatus:    (id, status) => API.patch(`/api/repair-orders/${id}/status`, { status }),
  addPart:        (id, b)      => API.post(`/api/repair-orders/${id}/parts`, b),
  addLabor:       (id, b)      => API.post(`/api/repair-orders/${id}/labor`, b),
  clockIn:        (id, b)      => API.post(`/api/repair-orders/${id}/time/clock-in`, b || {}),
  clockOut:       (id, b)      => API.post(`/api/repair-orders/${id}/time/clock-out`, b || {}),

  parts:          (q)          => API.get('/api/parts', q),
  workspaceUsers: ()           => API.get('/api/users/workspace'),

  financialSummary: (q)        => API.get('/api/reports/financial-summary', q),
  customerAnalytics:(q)        => API.get('/api/reports/customer-analytics', q),
  revenueTrends:    (q)        => API.get('/api/reports/revenue-trends', q),
  shopKPIs:         (q)        => API.get('/api/reports/shop-kpis', q),
  techPerformance:  (q)        => API.get('/api/reports/technician-performance', q),

  mitchellStatus: ()           => API.get('/api/integrations/mitchell/status'),

  /* ── Formatting ── */

  money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$0.00';
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  },

  /**
   * Format a date for display.
   *
   * A bare "YYYY-MM-DD" (what the API sends for DATE columns, e.g. an
   * appointment's preferred_date) is a calendar date, not an instant.
   * `new Date('2026-07-20')` parses it as UTC midnight, which renders as the
   * 19th anywhere west of UTC — so build it in local time instead.
   */
  date(value) {
    if (!value) return '—';
    const d = this.toDate(value);
    return d
      ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '—';
  },

  dateTime(value) {
    if (!value) return '—';
    const d = this.toDate(value);
    return d ? d.toLocaleString('en-US') : '—';
  },

  /** Parse an API date value, honouring calendar dates. Returns null if invalid. */
  toDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  /** Format a "HH:MM[:SS]" TIME column. Returns '—' when absent. */
  time(value) {
    if (!value) return '—';
    const m = /^(\d{2}):(\d{2})/.exec(String(value));
    if (!m) return '—';
    const h = Number(m[1]);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${m[2]} ${suffix}`;
  },

  statusLabel(status) {
    return String(status || '')
      .split('_')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ') || '—';
  },

  vehicleLabel(v) {
    if (!v) return '—';
    return [v.year, v.make, v.model].filter(Boolean).join(' ') || '—';
  },

  escape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  },

  /* ── State rendering ── */

  /**
   * Render into `el` while `fn` runs, showing a loading state first and an
   * error state (with Retry) if it throws. Returns the resolved value, or
   * undefined when the call failed.
   */
  async load(el, fn, { colspan, empty, onEmpty } = {}) {
    if (!el) return fn();
    this.showLoading(el, colspan);
    try {
      const data = await fn();
      const isEmpty = data == null || (Array.isArray(data) && data.length === 0);
      if (isEmpty && empty) {
        this.showEmpty(el, empty, colspan);
        if (onEmpty) onEmpty();
      }
      return data;
    } catch (e) {
      if (e.message === 'Session expired' || e.message === 'Unauthorized') return undefined;
      this.showError(el, e.message, colspan, () => this.load(el, fn, { colspan, empty, onEmpty }));
      return undefined;
    }
  },

  isTableTarget(el) {
    return el && (el.tagName === 'TBODY' || el.tagName === 'TABLE');
  },

  wrap(el, html, colspan) {
    if (this.isTableTarget(el)) {
      return `<tr><td colspan="${colspan || 6}" style="padding:24px;text-align:center;color:#6b7280">${html}</td></tr>`;
    }
    return `<div style="padding:24px;text-align:center;color:#6b7280">${html}</div>`;
  },

  showLoading(el, colspan) {
    if (!el) return;
    el.innerHTML = this.wrap(el, 'Loading…', colspan);
  },

  showEmpty(el, message, colspan) {
    if (!el) return;
    el.innerHTML = this.wrap(el, this.escape(message), colspan);
  },

  showError(el, message, colspan, retry) {
    if (!el) return;
    const id = `retry-${Math.random().toString(36).slice(2, 9)}`;
    el.innerHTML = this.wrap(
      el,
      `<div style="color:#b91c1c;margin-bottom:8px">${this.escape(message)}</div>` +
      `<button id="${id}" type="button" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer">Retry</button>`,
      colspan
    );
    const btn = el.querySelector(`#${id}`);
    if (btn && retry) btn.addEventListener('click', retry);
  },

  /* ── Toast ── */

  toast(message, type = 'info') {
    let host = document.getElementById('api-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'api-toast-host';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;gap:8px';
      document.body.appendChild(host);
    }
    const colors = {
      success: '#065f46', error: '#b91c1c', info: '#1f2937', warn: '#92400e',
    };
    const node = document.createElement('div');
    node.setAttribute('role', 'status');
    node.style.cssText =
      `background:${colors[type] || colors.info};color:#fff;padding:10px 16px;border-radius:8px;` +
      'font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:360px';
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), type === 'error' ? 6000 : 3500);
  },

  /* ── Forms ── */

  /**
   * Wire a submit handler with validation, button disabling and error surfacing.
   * `handler` receives a plain object of the form's named fields.
   */
  onSubmit(form, handler, { validate } = {}) {
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const data = Object.fromEntries(new FormData(form).entries());

      this.clearFieldErrors(form);
      const errors = validate ? validate(data) || {} : {};
      if (Object.keys(errors).length) {
        this.showFieldErrors(form, errors);
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

  clearFieldErrors(form) {
    form.querySelectorAll('.field-error').forEach((n) => n.remove());
    form.querySelectorAll('[data-invalid]').forEach((n) => n.removeAttribute('data-invalid'));
  },

  showFieldErrors(form, errors) {
    Object.entries(errors).forEach(([name, message]) => {
      const field = form.querySelector(`[name="${name}"]`);
      if (!field) return this.toast(message, 'error');
      field.setAttribute('data-invalid', 'true');
      const note = document.createElement('div');
      note.className = 'field-error';
      note.style.cssText = 'color:#b91c1c;font-size:12px;margin-top:4px';
      note.textContent = message;
      field.insertAdjacentElement('afterend', note);
    });
  },
};

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

window.API = API;
window.ApiError = ApiError;
