/* ============================================================
   AG Shop Pro — Auth & Workspace System
   All state lives in localStorage (persists) + sessionStorage
   ============================================================ */

const AUTH = {

  /* ── Demo data: workspaces + users ── */
  WORKSPACES: [
    { id:'ws-001', name:'Capitol Auto Body',      address:'1234 Main St, Silver Spring MD', type:'body_shop',  plan:'pro',     active:true },
    { id:'ws-002', name:'Silver Spring Mechanics', address:'500 Georgia Ave, Silver Spring MD',type:'mechanic',  plan:'pro',     active:true },
    { id:'ws-003', name:'Bethesda Quick Lube',     address:'900 Wisconsin Ave, Bethesda MD',  type:'quick_lube', plan:'starter', active:true },
  ],

  USERS: [
    { id:'u-001', email:'naod@agholdingcorp.com',     password:'Admin123!',  name:'Naod Mekonnen',  role:'super_admin',     workspaces:['ws-001','ws-002','ws-003'], phone:'3015550100' },
    { id:'u-002', email:'abraham@agholdingcorp.com',  password:'Admin123!',  name:'Abraham Lema',   role:'super_admin',     workspaces:['ws-001','ws-002','ws-003'], phone:'2405550102' },
    { id:'u-003', email:'maria@capitolauto.com',      password:'Manager1!',  name:'Maria Gonzalez', role:'manager',         workspaces:['ws-001'],                  phone:'2405550120' },
    { id:'u-004', email:'alex@capitolauto.com',       password:'Tech1234!',  name:'Alex Torres',    role:'technician',      workspaces:['ws-001'],                  phone:'2405550181' },
    { id:'u-005', email:'james@capitolauto.com',      password:'Tech1234!',  name:'James Reed',     role:'technician',      workspaces:['ws-001'],                  phone:'3015550155' },
    { id:'u-006', email:'david@silverspringmech.com', password:'Advisor1!',  name:'David Park',     role:'service_advisor', workspaces:['ws-002'],                  phone:'3015550210' },
    { id:'u-007', email:'sarah@silverspringmech.com', password:'Tech1234!',  name:'Sarah Johnson',  role:'technician',      workspaces:['ws-002'],                  phone:'2405550245' },
    { id:'u-008', email:'mike@bethesda.com',          password:'Tech1234!',  name:'Mike Santos',    role:'technician',      workspaces:['ws-003'],                  phone:'5715550188' },
    /* quick demo accounts */
    { id:'u-d1',  email:'demo@manager.com',           password:'demo',       name:'Demo Manager',   role:'manager',         workspaces:['ws-001'],                  phone:'0000000000' },
    { id:'u-d2',  email:'demo@tech.com',              password:'demo',       name:'Demo Tech',      role:'technician',      workspaces:['ws-001'],                  phone:'0000000001' },
    { id:'u-d3',  email:'demo@service.com',           password:'demo',       name:'Demo Advisor',   role:'service_advisor', workspaces:['ws-001'],                  phone:'0000000002' },
    { id:'u-d4',  email:'demo@admin.com',             password:'demo',       name:'Demo Admin',     role:'super_admin',     workspaces:['ws-001','ws-002','ws-003'], phone:'0000000003' },
  ],

  ROLE_PORTAL: {
    super_admin:    'superadmin.html',
    manager:        'manager.html',
    service_advisor:'service.html',
    technician:     'tech.html',
  },

  /* ── Reset tokens stored in localStorage (simulated) ── */
  _resetTokenKey: 'agshopro_reset_tokens',

  getUsers()    { return JSON.parse(localStorage.getItem('agshopro_users')    || 'null') || this.USERS; },
  getWS()       { return JSON.parse(localStorage.getItem('agshopro_ws')       || 'null') || this.WORKSPACES; },
  saveUsers(u)  { localStorage.setItem('agshopro_users', JSON.stringify(u)); },
  saveWS(w)     { localStorage.setItem('agshopro_ws',    JSON.stringify(w)); },

  getSession()  {
    try { return JSON.parse(sessionStorage.getItem('agshopro_session') || 'null'); }
    catch(e) { return null; }
  },
  setSession(data) { sessionStorage.setItem('agshopro_session', JSON.stringify(data)); },
  clearSession()   { sessionStorage.removeItem('agshopro_session'); },

  login(email, password) {
    const users = this.getUsers();
    const u = users.find(x => x.email.toLowerCase() === email.toLowerCase() && x.password === password);
    if (!u) return { ok: false, error: 'Incorrect email or password.' };
    const ws = this.getWS();
    const myWS = ws.filter(w => u.workspaces.includes(w.id));
    const activeWS = myWS[0] || null;
    this.setSession({ id:u.id, name:u.name, email:u.email, role:u.role, workspaces:u.workspaces, activeWorkspaceId: activeWS?.id || null, activeWorkspaceName: activeWS?.name || '', loginTime: Date.now() });
    return { ok: true, role: u.role };
  },

  logout() { this.clearSession(); window.location.replace('login.html'); },

  requireAuth() {
    const s = this.getSession();
    if (!s) { window.location.replace('login.html'); return null; }
    return s;
  },

  /* Password reset — generates token, "sends email" (shows in console + alert for demo) */
  requestReset(email) {
    const users = this.getUsers();
    const u = users.find(x => x.email.toLowerCase() === email.toLowerCase());
    if (!u) return { ok: false, error: 'No account found with that email.' };
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const expiry = Date.now() + 3600000; // 1 hour
    const tokens = JSON.parse(localStorage.getItem(this._resetTokenKey) || '{}');
    tokens[token] = { userId: u.id, email: u.email, expiry };
    localStorage.setItem(this._resetTokenKey, JSON.stringify(tokens));
    /* In production this calls your API → sends real email via SES/Nodemailer.
       For demo we show the link in an alert. */
    const resetURL = window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'reset.html?token=' + token;
    console.log('[AG Shop Pro] Password reset link:', resetURL);
    /* Simulate email delivery notification */
    setTimeout(() => {
      alert('📧 Demo mode: A password reset link has been sent to ' + u.email + '\n\nIn this demo, the link is:\n' + resetURL + '\n\n(In production this would arrive in your real inbox via AWS SES)');
    }, 300);
    return { ok: true };
  },

  validateResetToken(token) {
    const tokens = JSON.parse(localStorage.getItem(this._resetTokenKey) || '{}');
    const t = tokens[token];
    if (!t) return null;
    if (Date.now() > t.expiry) { delete tokens[token]; localStorage.setItem(this._resetTokenKey, JSON.stringify(tokens)); return null; }
    return t;
  },

  resetPassword(token, newPassword) {
    const tokenData = this.validateResetToken(token);
    if (!tokenData) return { ok: false, error: 'Reset link is invalid or expired.' };
    if (newPassword.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
    const users = this.getUsers();
    const idx = users.findIndex(u => u.id === tokenData.userId);
    if (idx === -1) return { ok: false, error: 'User not found.' };
    users[idx].password = newPassword;
    this.saveUsers(users);
    const tokens = JSON.parse(localStorage.getItem(this._resetTokenKey) || '{}');
    delete tokens[token];
    localStorage.setItem(this._resetTokenKey, JSON.stringify(tokens));
    return { ok: true };
  },

  /* Workspace helpers */
  getMyWorkspaces(session) {
    const ws = this.getWS();
    if (session.role === 'super_admin') return ws;
    return ws.filter(w => (session.workspaces || []).includes(w.id));
  },

  switchWorkspace(wsId) {
    const s = this.getSession();
    if (!s) return;
    const ws = this.getWS().find(w => w.id === wsId);
    if (!ws) return;
    s.activeWorkspaceId = ws.id;
    s.activeWorkspaceName = ws.name;
    this.setSession(s);
  },

  addUserToWorkspace(userId, workspaceId) {
    const users = this.getUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return false;
    if (!users[idx].workspaces.includes(workspaceId)) users[idx].workspaces.push(workspaceId);
    this.saveUsers(users);
    return true;
  },

  createWorkspace(data) {
    const ws = this.getWS();
    const newWS = { id:'ws-' + Date.now(), name:data.name, address:data.address, type:data.type, plan:data.plan||'starter', active:true };
    ws.push(newWS);
    this.saveWS(ws);
    return newWS;
  },

  createUser(data) {
    const users = this.getUsers();
    if (users.find(u => u.email.toLowerCase() === data.email.toLowerCase())) return { ok:false, error:'Email already exists.' };
    const newUser = { id:'u-' + Date.now(), email:data.email, password:data.password || this._tempPassword(), name:data.name, role:data.role, workspaces:data.workspaces||[], phone:data.phone||'' };
    users.push(newUser);
    this.saveUsers(users);
    return { ok:true, user:newUser };
  },

  _tempPassword() { return 'Temp' + Math.random().toString(36).slice(2,8) + '!'; },
};

window.AUTH = AUTH;
