// app.js -- Ban iPhone (PWA) cua app TDM. Giao dien chuyen tu app Android (MainActivity.kt, SzSteps.kt, BayesSteps.kt,
// VancoSteps.kt, KsSteps.kt); MOI phep tinh / kiem tra / thong bao / luu Cloud do CUNG bo tinh Python cua app lam
// (chay trong worker.js bang Pyodide). File nay chi lo giao dien, dang nhap, tai + giai ma bo tinh.
'use strict';

const CFG = window.TDM_CONFIG || {};
const BASE = new URL('./', location.href).href;

// ================================================================== cau noi toi Python (worker)
const worker = new Worker(BASE + 'worker.js');
let msgId = 0;
const pending = new Map();
let progressCb = null;
worker.onmessage = (e) => {
  const d = e.data;
  if (d.progress) { if (progressCb) progressCb(d.progress); return; }
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  d.ok ? p.resolve(d.result) : p.reject(new Error(d.error));
};
function callWorker(cmd, data = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, ...data }, transfer);
  });
}
let runtimeReady = null;
function ensureRuntime() {
  if (!runtimeReady) {
    runtimeReady = callWorker('init', { base: BASE });
    runtimeReady.then(() => { if (!busyCount) setBusyText(''); }, () => { runtimeReady = null; if (!busyCount) setBusyText(''); });
  }
  return runtimeReady;
}

// ================================================================== Supabase (chi dung truc tiep cho dang nhap + khoa bo tinh)
async function rpc(fn, body) {
  const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: CFG.key, Authorization: `Bearer ${CFG.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    let m = text;
    try { m = JSON.parse(text).message || text; } catch (e) { /* giu nguyen */ }
    throw new Error(`Lỗi Cloud (${r.status}): ${m}`);
  }
  return text ? JSON.parse(text) : null;
}

// ================================================================== luu tru tren may (IndexedDB) + MA HOA (Web Crypto)
// Khoa AES-GCM tao 1 lan, dat che do KHONG XUAT RA DUOC (extractable = false), luu trong IndexedDB cua trang:
// chi trang nay tren chinh trinh duyet nay giai ma duoc ban sao bang lieu (giong KsCache.kt dung Android Keystore).
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('tdm-pwa', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  async set(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },
  async del(k) {
    const db = await this.open();
    return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => res(); });
  },
};
const Secure = {
  async key() {
    let k = await IDB.get('aes_key');
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await IDB.set('aes_key', k);
    }
    return k;
  },
  async save(name, text) {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(text));
      await IDB.set(name, { iv, ct });
    } catch (e) { /* luu that bai -> lan sau tai lai tu may chu */ }
  },
  async load(name) {
    try {
      const v = await IDB.get(name);
      if (!v) return null;
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.iv }, await this.key(), v.ct);
      return new TextDecoder().decode(pt);
    } catch (e) { await IDB.del(name); return null; }
  },
};

// ================================================================== tai + giai ma bo tinh
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
let engineInfo = null;

async function loadEngine(session) {
  setBusyText('Đang tải bộ tính…');
  const man = await (await fetch(BASE + 'engine/manifest.json', { cache: 'no-cache' })).json();
  const binP = fetch(BASE + 'engine/' + man.file).then((r) => { if (!r.ok) throw new Error('Không tải được gói bộ tính'); return r.arrayBuffer(); });
  const jwkText = await rpc('amg_engine_get_key', { p_token: session.token });
  if (!jwkText) throw new Error('Máy chủ chưa có khóa bộ tính (chưa chạy file SQL E1).');
  const priv = await crypto.subtle.importKey('jwk', JSON.parse(jwkText), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64(man.key));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const zip = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(man.iv) }, aes, await binP);
  if (hex(await crypto.subtle.digest('SHA-256', zip)) !== man.sha256) throw new Error('Gói bộ tính bị lỗi (sai mã kiểm tra).');
  await ensureRuntime();
  setBusyText('Đang cài bộ tính…');
  await callWorker('engine', { zip: new Uint8Array(zip), url: CFG.url, key: CFG.key, token: session.token,
    user: session.user, pw: session.pw, role: session.role }, []);
  engineInfo = man;
}

// v0.12.0: goi tinh lieu khang sinh (khong ma hoa) cho nguoi CHUA dang nhap. Da dang nhap -> bo tinh day du da co san.
let ksEngineReady = null;
function loadKsEngine() {
  if (engineInfo) return Promise.resolve();
  if (!ksEngineReady) {
    ksEngineReady = (async () => {
      setBusyText('Đang tải bộ tính liều kháng sinh…');
      const man = await (await fetch(BASE + 'engine/manifest.json', { cache: 'no-cache' })).json();
      if (!man.ks) throw new Error('Bản này chưa có gói tính liều không cần đăng nhập.');
      const r = await fetch(BASE + 'engine/' + man.ks.file);
      if (!r.ok) throw new Error('Không tải được gói tính liều');
      const zip = await r.arrayBuffer();
      if (hex(await crypto.subtle.digest('SHA-256', zip)) !== man.ks.sha256) throw new Error('Gói tính liều bị lỗi (sai mã kiểm tra).');
      await ensureRuntime();
      await callWorker('ks_engine', { zip: new Uint8Array(zip), url: CFG.url, key: CFG.key }, []);
    })();
    ksEngineReady.catch(() => { ksEngineReady = null; });
  }
  return ksEngineReady;
}
function goHome() { if (App.user) showHome(); else showLogin(); }

// ================================================================== khung man hinh
const $ = (id) => document.getElementById(id);
let busyCount = 0;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const b = busyCount > 0;
  $('spin').style.display = b ? '' : 'none';
  $('back').disabled = b; $('next').disabled = b;
  if (!b) setBusyText('');
}
function setBusyText(s) { const t = $('busytext'); t.textContent = s || ''; t.style.display = s ? '' : 'none'; }
progressCb = (m) => setBusyText(m);

/** Goi bo tinh Python (giong a.py(...) cua app Android). */
function py(fn, req, done) {
  busy(true);
  callWorker('call', { fn, req: JSON.stringify(req || {}) })
    .then((r) => { busy(false); done(r); })
    .catch((e) => { busy(false); done({ ok: false, level: 'error', message: '❌ Lỗi gọi bộ tính: ' + e.message }); });
}

const App = {
  user: null, meta: null, vmeta: null, st: null, vs: null, ks: null,
  module: 'amg', steps: [], stepIdx: -2, amgStarted: false, vancoStarted: false,
};

function page(title, sub, showNav) {
  $('title').textContent = title; $('sub').textContent = sub;
  const body = $('body');
  body.innerHTML = '';
  $('nav').style.display = showNav ? '' : 'none';
  window.scrollTo(0, 0);
  return body;
}
function scrollToBottom() { setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 50); }

// ================================================================== dang nhap
const AppInfo = {
  AUTHOR: 'Thiên Phan Tại', TITLE: 'Dược sĩ', YEAR: '2026', EMAIL: 'thienphankh28@gmail.com',
  DISCLAIMER: 'Phần mềm là công cụ hỗ trợ tính toán, không thay thế đánh giá và quyết định lâm sàng của dược sĩ, bác sĩ. ' +
    'Người sử dụng cần kiểm tra lại dữ liệu nhập và đối chiếu kết quả với tình trạng lâm sàng của người bệnh ' +
    'trước khi áp dụng. Tác giả không chịu trách nhiệm đối với các quyết định điều trị dựa trên kết quả của phần mềm.',
};

function showLogin() {
  App.stepIdx = -2;
  const body = page('TDM Aminoglycosid', 'Tính liều kháng sinh · Đăng nhập để làm TDM', false);
  // v0.12.0: tinh lieu + chuc nang than KHONG can dang nhap
  const k = ui.card(body, 12);
  ui.header(k, '🧪 Tính liều kháng sinh');
  ui.hint(k, 'Chức năng thận (Cockcroft–Gault / Schwartz) và chế độ liều kháng sinh, cách pha truyền. Không cần đăng nhập, không lưu dữ liệu.');
  const kst = ui.status(k);
  ui.button(k, 'Mở tính liều kháng sinh', Col.greenBtn, 10, () => {
    busy(true);
    loadKsEngine().then(() => { busy(false); App.module = 'ks'; startWizard(); })
      .catch((e) => {
        busy(false);
        const offline = !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(e.message);
        ui.setStatus(kst, offline ? '❌ Chưa tải được bộ tính — cần có mạng ở lần mở đầu tiên.' : '❌ ' + e.message, 'error');
      });
  });
  const c = ui.card(body, 16);
  ui.header(c, '🔐 Đăng nhập');
  ui.hint(c, 'Đăng nhập để làm TDM (Aminoglycosid, Vancomycin) hoặc quản lý bảng liều (admin).');
  let u = localStorage.getItem('tdm_user') || '';
  let p = '';
  ui.field(c, 'Tên đăng nhập', u, (v) => { u = v; }, { numeric: false, autocomplete: 'username' });
  const pw = ui.field(c, 'Mật khẩu', '', (v) => { p = v; }, { numeric: false, password: true, autocomplete: 'current-password' });
  const status = ui.status(c);
  const go = async () => {
    u = u.trim();
    if (!u || !p) { ui.setStatus(status, '⚠️ Nhập tên đăng nhập và mật khẩu.', 'warn'); return; }
    ui.setStatus(status, 'Đang đăng nhập…');
    busy(true);
    try {
      const rows = await rpc('amg_login_session', { p_username: u, p_password: p });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row || !row.token) { busy(false); ui.setStatus(status, '❌ Sai tên đăng nhập hoặc mật khẩu.', 'error'); return; }
      const session = { token: row.token, user: u, pw: p, role: row.role || '' };
      await loadEngine(session);
      App.user = { username: u, fullname: row.fullname || u, role: row.role || '' };
      try { localStorage.setItem('tdm_user', u); } catch (e) { /* bo qua */ }
      busy(false);
      showHome();
    } catch (e) {
      busy(false);
      const offline = !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(e.message);
      ui.setStatus(status, offline ? '❌ Không kết nối được máy chủ — kiểm tra mạng (cần có mạng khi đăng nhập).' : '❌ ' + e.message, 'error');
    }
  };
  pw.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  ui.button(c, 'Đăng nhập', Col.greenBtn, 14, go);
  const info = ui.card(body, 16);
  ui.header(info, 'ℹ️ Thông tin phần mềm & Bản quyền');
  ui.text(info, '💊 Phần mềm TDM Aminoglycosid', 15, Col.text, true, 2);
  [`Phiên bản: bản iPhone (web)${CFG.build ? ' — ' + CFG.build : ''}`,
    `Tác giả: ${AppInfo.TITLE} ${AppInfo.AUTHOR}`, `Năm phát triển: ${AppInfo.YEAR}`,
    `Bản quyền sở hữu và phát triển: ${AppInfo.AUTHOR} — ${AppInfo.EMAIL}`,
    'Cơ sở dữ liệu: Supabase Cloud Database'].forEach((s) => ui.text(info, '•  ' + s, 14, Col.text, false, 2));
  ui.text(info, '⚠️ Miễn trừ trách nhiệm', 14, Col.amber, true, 10);
  ui.text(info, AppInfo.DISCLAIMER, 13, Col.muted, false, 2);
  ui.hint(body, '\nTài khoản do quản trị viên cấp (giống phần mềm trên máy tính và app Android).');
  ensureRuntime().catch(() => {});      // khoi dong Python ngay trong luc nguoi dung go mat khau
}

// ================================================================== man hinh chinh
function ensureMeta(done) {
  if (App.meta && App.vmeta) { done(); return; }
  py('meta', {}, (m) => {
    if (!m.ok && m.ok !== undefined && m.message) { toast(m.message); return; }
    App.meta = m;
    py('v_meta', {}, (vm) => { App.vmeta = vm; done(); });
  });
}

function showHome() {
  App.stepIdx = -1;
  const body = page('TDM — Trang chính', 'Xin chào ' + (App.user ? App.user.fullname : ''), false);
  const st = App.st || (App.st = new Tab1State());
  ui.text(body, '💊 TAB 1 — AMINOGLYCOSID', 14, Col.blue, true, 10);
  const c = ui.card(body, 6);
  ui.header(c, '🔍 Tra cứu bệnh nhân từ Cloud');
  let msyt = '';
  ui.field(c, 'MSYT', '', (v) => { msyt = v.trim(); }, { numeric: false });
  let method = st.method;
  ui.choice(c, 'Phương pháp', ['Sawchuk–Zaske', 'Bayesian'], method === 'sz' ? 'Sawchuk–Zaske' : 'Bayesian', (i) => { method = i === 0 ? 'sz' : 'bayes'; });
  const status = ui.status(c);
  ui.button(c, 'Tải dữ liệu bệnh nhân', Col.blue, 8, () => ensureMeta(() => {
    py('lookup', { msyt, method }, (r) => {
      if (r.ok) {
        App.st = new Tab1State(); App.st.msyt = msyt;
        App.st.applyForm(r.method, r.form || {});
        if (!App.st.msyt) App.st.msyt = msyt;
        App.st.history = r.history || null;
        toast(r.message || ''); App.module = 'amg'; startWizard();
      } else ui.setStatus(status, r.message, r.level || 'error');
    });
  }));
  const c2 = ui.card(body, 12);
  ui.header(c2, '➕ Bệnh nhân mới');
  ui.hint(c2, 'Nhập lần lượt từng bước: thông tin bệnh nhân → liều → nồng độ → kết quả → hiệu chỉnh liều.');
  ui.button(c2, 'Bắt đầu nhập bệnh nhân mới', Col.greenBtn, 8, () => ensureMeta(() => {
    App.st = new Tab1State(); App.st.method = method; App.module = 'amg'; startWizard();
  }));
  if (App.amgStarted) ui.button(c2, `↩ Tiếp tục bệnh nhân đang nhập (${App.st.msyt || 'chưa có MSYT'})`, Col.gray, 8, () => { App.module = 'amg'; startWizard(); });

  ui.text(body, '💉 TAB 4 — VANCOMYCIN', 14, Col.purple, true, 18);
  const v = ui.card(body, 6);
  ui.header(v, '🔍 Tra cứu bệnh nhân Vancomycin');
  let vmsyt = '';
  ui.field(v, 'MSYT', '', (x) => { vmsyt = x.trim(); }, { numeric: false });
  const vstatus = ui.status(v);
  ui.button(v, 'Tải dữ liệu bệnh nhân', Col.blue, 8, () => ensureMeta(() => {
    py('v_load', { msyt: vmsyt }, (r) => {
      if (r.ok) {
        App.vs = new VancoState(); App.vs.applyForm(r.form || {}); App.vs.history = r.history || null;
        toast(r.message || ''); App.module = 'vanco'; startWizard();
      } else ui.setStatus(vstatus, r.message, r.level || 'error');
    });
  }));
  ui.button(v, 'Bắt đầu bệnh nhân Vancomycin mới', Col.greenBtn, 8, () => ensureMeta(() => { App.vs = new VancoState(); App.module = 'vanco'; startWizard(); }));
  if (App.vancoStarted && App.vs) ui.button(v, `↩ Tiếp tục bệnh nhân đang nhập (${App.vs.msyt || 'chưa có MSYT'})`, Col.gray, 8, () => { App.module = 'vanco'; startWizard(); });

  ui.text(body, '🧪 TÍNH LIỀU KHÁNG SINH', 14, Col.green, true, 18);
  const k = ui.card(body, 6);
  ui.hint(k, 'Chức năng thận (Cockcroft–Gault / Schwartz) và chế độ liều kháng sinh theo bảng của tổ Dược lâm sàng. Không lưu dữ liệu.');
  ui.button(k, 'Mở tính liều kháng sinh', Col.greenBtn, 8, () => { App.module = 'ks'; startWizard(); });
  if ((App.user.role || '').trim().toLowerCase() === 'admin')
    ui.hint(k, 'Quản lý bảng liều & cách pha truyền (admin): dùng app Android.');

  const c3 = ui.card(body, 18);
  ui.hint(c3, `Bản iPhone (web) — tự cập nhật khi mở. Bộ tính phiên bản ${engineInfo ? engineInfo.version : '?'}.`);
  const chk = ui.status(c3);
  const r = ui.row(c3);
  ui.smallButton(r, 'Kiểm tra bộ tính (ca mẫu)', Col.gray, () => {
    ui.setStatus(chk, 'Đang chạy ca mẫu…');
    py('run_demo_case', {}, (res) => py('run_vanco_demo', {}, (vres) => {
      const ok = res.ok && vres.ok;
      ui.setStatus(chk, (res.ok ? `✅ Aminoglycosid khớp bản máy tính (${res.seconds} s).` : '❌ Aminoglycosid KHÔNG khớp bản máy tính.') + '\n' +
        (vres.ok ? `✅ Vancomycin (4 mô hình) khớp bản máy tính (${vres.seconds} s).` : `❌ Vancomycin KHÔNG khớp bản máy tính. ${vres.err || vres.message || ''}`),
      ok ? 'info' : 'error');
    }));
  });
  ui.smallButton(r, 'Đăng xuất', Col.red, () => {
    busy(true);
    callWorker('logout').finally(() => {
      busy(false);
      App.user = null; App.st = null; App.vs = null; App.ks = null; App.amgStarted = false; App.vancoStarted = false;
      showLogin();
    });
  });
}

// ================================================================== dieu huong tung buoc
function startWizard() {
  if (App.module === 'vanco') App.vancoStarted = true; else if (App.module === 'amg') App.amgStarted = true;
  rebuildSteps();
  go(0);
}
function rebuildSteps() {
  if (App.module === 'ks') App.steps = KsSteps.steps();
  else if (App.module === 'vanco') App.steps = VancoSteps.steps();
  else App.steps = [{ title: 'Bệnh nhân & thuốc', build: buildPatient }].concat(App.st.method === 'sz' ? SzSteps.steps() : BayesSteps.steps());
}
function go(i) {
  App.stepIdx = i;
  const s = App.steps[i];
  const st = App.st, vs = App.vs;
  const sub = App.module === 'ks' ? 'Chức năng thận & liều kháng sinh'
    : App.module === 'vanco' ? `Vancomycin · ${vs.method}${vs.msyt ? ' · MSYT ' + vs.msyt : ''}`
      : `${st.method === 'sz' ? 'Sawchuk–Zaske' : 'Bayesian'} · ${st.drug}${st.msyt ? ' · MSYT ' + st.msyt : ''}`;
  const body = page(`Bước ${i + 1}/${App.steps.length}: ${s.title}`, sub, true);
  $('back').textContent = i === 0 ? '🏠 Trang chính' : '◀ Quay lại';
  $('next').textContent = i === App.steps.length - 1 ? '✔ Xong' : 'Tiếp ▶';
  s.build(body);
}
function redraw(keep = true) {
  const y = window.scrollY;
  go(App.stepIdx);
  if (keep) setTimeout(() => window.scrollTo(0, y), 0);
}
function next() { if (App.stepIdx < 0) return; if (App.stepIdx < App.steps.length - 1) go(App.stepIdx + 1); else goHome(); }
function back() { if (App.stepIdx > 0) go(App.stepIdx - 1); else if (App.stepIdx === 0) goHome(); }

function saveWithConfirm(fn, req, status, after = () => {}) {
  py(fn, req, (r) => {
    if (r.need_confirm) {
      if (confirm('Xác nhận ghi đè\n\n' + r.message)) {
        req.overwrite = true;
        py(fn, req, (r2) => { ui.setStatus(status, r2.message, r2.level); after(r2); });
      } else ui.setStatus(status, 'Đã hủy thao tác lưu.', 'info');
    } else { ui.setStatus(status, r.message, r.level); after(r); }
  });
}

// ================================================================== du lieu nhap (giong Model.kt)
class SzBlock {
  constructor(o = {}) {
    this.start = o.start ?? nowHourIso(); this.scr = o.scr ?? '80'; this.dose = o.dose ?? '400'; this.tau = o.tau ?? '24';
    this.tinf = o.tinf ?? '1'; this.s1t = o.s1t ?? ''; this.s1c = o.s1c ?? ''; this.s2t = o.s2t ?? ''; this.s2c = o.s2c ?? '';
    this.resultText = ''; this.resultLevel = 'info';
  }
  toJson() {
    return { start: this.start, scr_umol: this.scr, dose_mg: this.dose, tau_h: this.tau, t_inf_h: this.tinf,
      s1_time: this.s1t, s1_conc: this.s1c, s2_time: this.s2t, s2_conc: this.s2c };
  }
  static fromJson(o) {
    const t = (v) => (v === null || v === undefined || v === 'null') ? '' : String(v).slice(0, 16);
    return new SzBlock({ start: t(o.start), scr: optStr(o, 'scr_umol'), dose: optStr(o, 'dose_mg'), tau: optStr(o, 'tau_h', '24'),
      tinf: optStr(o, 't_inf_h', '1'), s1t: t(o.s1_time), s1c: optStr(o, 's1_conc'), s2t: t(o.s2_time), s2c: optStr(o, 's2_conc') });
  }
}
const ScrRow = (value = '80', unit = 'μmol/L', at = nowHourIso()) => ({ value, unit, at, toJson() { return { scr: this.value, unit: this.unit, measured_at: this.at }; } });
const DoseRow = (at = nowHourIso(), dose = '400', tinf = '1', tau = '24') => ({ at, dose, tinf, tau, toJson() { return { given_at: this.at, dose_mg: this.dose, t_inf_h: this.tinf, tau_h: this.tau }; } });
const MeasRow = (cobs = '', at = nowHourIso()) => ({ cobs, at, assign: '', warn: false, toJson() { return { c_obs: this.cobs, t_obs: this.at }; } });
const NewDose = (dose = '', tau = '24', tinf = '1') => ({ dose, tau, tinf, result: '' });

class Tab1State {
  constructor() {
    this.msyt = ''; this.gender = 'nam'; this.age = '50'; this.weight = '70'; this.height = '170';
    this.drug = 'Gentamicin'; this.severity = 'Không đe dọa tính mạng'; this.targetCp = '20'; this.targetCtr = '1';
    this.mic = ''; this.method = 'sz';
    this.doseMgKg = '5'; this.pop = null; this.blocks = [new SzBlock()];
    this.szCalc = null; this.checkMsg = ''; this.checkLevel = 'info';
    this.newDose = '400'; this.newTau = '36'; this.newTinf = '1'; this.sz4 = null; this.cycles = 10;
    this.setting = ''; this.albumin = ''; this.urineCrcl = '';
    this.cf = false; this.ntm = false; this.openAbdomen = false; this.crrt = false; this.vanco = false;
    this.auto = true; this.modelKey = 'AA2020'; this.models = null;
    this.scr = [ScrRow()]; this.doses = [DoseRow()]; this.meas = [MeasRow()];
    this.bayes = null; this.newDoses = []; this.history = null;
  }
  patientJson() {
    return { msyt: this.msyt, gender: this.gender, age: this.age, weight: this.weight, height: this.height, drug: this.drug,
      severity: this.severity, target_cp: this.targetCp, target_ctr: this.targetCtr, mic: this.mic };
  }
  clinicalJson() {
    return { setting: this.setting, albumin_gl: this.albumin, urine_crcl: this.urineCrcl, cf: this.cf, ntm: this.ntm,
      open_abdomen: this.openAbdomen, crrt: this.crrt, vanco: this.vanco };
  }
  szJson() {
    return Object.assign(this.patientJson(), { dose_mg_kg: this.doseMgKg, blocks: this.blocks.map((b) => b.toJson()),
      total_dose_first: this.pop ? this.pop.total_dose : null, dosing_weight: this.pop ? this.pop.dosing_weight : null });
  }
  bayesJson() {
    return Object.assign(this.patientJson(), { clinical: this.clinicalJson(), auto: this.auto, model_key: this.modelKey,
      current: this.modelKey, scr: this.scr.map((r) => r.toJson()), doses: this.doses.map((r) => r.toJson()),
      measurements: this.meas.map((r) => r.toJson()) });
  }
  applyForm(method, f) {
    this.method = method;
    this.msyt = f.msyt || this.msyt; this.gender = f.gender || this.gender;
    if ('age' in f) this.age = optStr(f, 'age'); if ('weight' in f) this.weight = optStr(f, 'weight');
    if ('height' in f) this.height = optStr(f, 'height'); if ('drug' in f) this.drug = f.drug;
    this.mic = optStr(f, 'mic', '');
    if (method === 'sz') {
      if ('severity' in f) this.severity = f.severity;
      this.doseMgKg = optStr(f, 'dose_mg_kg', this.doseMgKg); this.targetCp = optStr(f, 'target_cp', this.targetCp);
      this.targetCtr = optStr(f, 'target_ctr', this.targetCtr);
      if (Array.isArray(f.blocks)) { this.blocks = f.blocks.map(SzBlock.fromJson); if (!this.blocks.length) this.blocks.push(new SzBlock()); }
      this.szCalc = null; this.sz4 = null; this.checkMsg = '';
    } else {
      this.modelKey = f.model_key || this.modelKey; this.auto = !!f.auto;
      const c = f.clinical;
      if (c) {
        this.setting = c.setting || ''; this.albumin = c.albumin_gl ?? ''; this.urineCrcl = c.urine_crcl ?? '';
        this.cf = !!c.cf; this.ntm = !!c.ntm; this.openAbdomen = !!c.open_abdomen; this.crrt = !!c.crrt; this.vanco = !!c.vanco;
      }
      this.scr = (f.scr || []).map((o) => ScrRow(optStr(o, 'scr'), o.unit || 'μmol/L', o.measured_at || ''));
      this.doses = (f.doses || []).map((o) => DoseRow(o.given_at || '', optStr(o, 'dose_mg'), optStr(o, 't_inf_h', '1'), optStr(o, 'tau_h', '24')));
      this.meas = (f.measurements || []).map((o) => MeasRow(optStr(o, 'c_obs'), o.t_obs || ''));
      if (!this.scr.length) this.scr.push(ScrRow()); if (!this.doses.length) this.doses.push(DoseRow()); if (!this.meas.length) this.meas.push(MeasRow());
      this.bayes = null; this.newDoses = [];
    }
  }
}

const VDoseRow = (at = nowHourIso(), dose = '1000', tau = '12', tinf = '1') => ({ at, dose, tau, tinf, toJson() { return { given_at: this.at, dose_mg: this.dose, tau_h: this.tau, t_inf_h: this.tinf }; } });
const VMeasRow = (cobs = '15', at = nowHourIso(), groupNext = false) => ({ cobs, at, groupNext, toJson() { return { c_obs: this.cobs, t_obs: this.at, group_next: this.groupNext }; } });

class VancoState {
  constructor() {
    this.msyt = ''; this.gender = 'nam'; this.age = '50'; this.height = '165'; this.weight = '60';
    this.method = 'Goti 2018'; this.dialysis = false; this.malignancy = false; this.heelprick = false; this.gpos = true;
    this.scr = [ScrRow()]; this.doses = []; this.meas = [];
    this.newDose = '1000'; this.newTau = '12'; this.newTinf = '1'; this.target = '';
    this.result = null; this.newRes = null; this.history = null; this.selected = new Set();
    const now = nowHourIso();
    this.doses.push(VDoseRow(now, '1000', '12')); this.doses.push(VDoseRow(isoPlusHours(now, 12), '1000', '12'));
    this.meas.push(VMeasRow('15', isoPlusHours(now, 13)));
  }
  json() {
    return { msyt: this.msyt, gender: this.gender, age: this.age, height: this.height, weight: this.weight, method: this.method,
      dialysis: this.dialysis, malignancy: this.malignancy, heelprick: this.heelprick, gpos: this.gpos,
      new_dose: this.newDose, new_tau: this.newTau, scr: this.scr.map((r) => r.toJson()),
      doses: this.doses.map((r) => r.toJson()), measurements: this.meas.map((r) => r.toJson()) };
  }
  applyForm(f) {
    this.msyt = f.msyt ?? this.msyt; this.gender = f.gender ?? this.gender;
    if ('age' in f) this.age = optStr(f, 'age'); if ('height' in f) this.height = optStr(f, 'height');
    if ('weight' in f) this.weight = optStr(f, 'weight');
    this.method = f.method || this.method; this.dialysis = !!f.dialysis; this.malignancy = !!f.malignancy;
    this.heelprick = !!f.heelprick; this.gpos = f.gpos === undefined ? true : !!f.gpos;
    this.scr = (f.scr || []).map((o) => ScrRow(optStr(o, 'scr'), o.unit || 'μmol/L', o.measured_at || ''));
    this.doses = (f.doses || []).map((o) => VDoseRow(o.given_at || '', optStr(o, 'dose_mg'), optStr(o, 'tau_h', '12'), optStr(o, 't_inf_h', '1')));
    this.meas = (f.measurements || []).map((o) => VMeasRow(optStr(o, 'c_obs'), o.t_obs || '', !!o.group_next));
    if (!this.scr.length) this.scr.push(ScrRow()); if (!this.doses.length) this.doses.push(VDoseRow()); if (!this.meas.length) this.meas.push(VMeasRow());
    this.result = null; this.newRes = null; this.selected = new Set();
  }
}

const jsonList = (a) => Array.isArray(a) ? a.map(String) : [];
const headRow = (c, title) => { const h = ui.row(c); const t = ui.text(h, title, 16, Col.text, true, 0); t.style.flex = '1'; return h; };

// ================================================================== Nhap nhieu lieu (v0.10.1, giong MultiDose.kt)
function lastByTime(list, at) {
  let best = null, bt = -Infinity;
  list.forEach((x) => { const d = parseIso(at(x)); if (d && d.getTime() >= bt) { bt = d.getTime(); best = x; } });
  return best;
}
/** «📋 Nhập nhiều liều»: chuỗi liều giống nhau, chỉ khác giờ bắt đầu truyền. Lập lịch do Python (mobile_chuoi_lieu). */
function multiDose(o) {
  const S = Object.assign({ mode: 'last', last: '', count: '' }, o);
  const form = () => {
    const m = openModal('📋 Nhập nhiều liều', [
      { label: 'Hủy', color: Col.gray, onClick: (close) => close() },
      { label: 'Xem trước ▶', color: Col.blue, onClick: (close) => {
        const dv = toNum(S.dose);
        if (dv === null || dv <= 0) { toast('⚠️ Liều phải là số > 0.'); return; }
        if (S.scr !== null && S.scr !== undefined && String(S.scr).trim() && toNum(S.scr) === null) { toast('⚠️ SCr phải là số (hoặc để trống).'); return; }
        py('cl_plan', { first: S.first, tau: S.tau, tinf: S.tinf, mode: S.mode, last: S.last, count: S.count,
          existing: S.existing.map(([at, tinf]) => ({ at, tinf })) }, (r) => {
          if (!r.ok) { toast(r.message); return; }
          close(); preview(r);
        });
      } }]);
    const b = m.body;
    const draw = () => {
      b.innerHTML = '';
      ui.hint(b, 'Các liều giống nhau, chỉ khác thời điểm bắt đầu truyền.');
      const r1 = ui.row(b);
      ui.field(ui.cell(r1), 'Liều (mg)', S.dose, (v) => { S.dose = v; });
      ui.field(ui.cell(r1), 'τ (h)', S.tau, (v) => { S.tau = v; });
      ui.field(ui.cell(r1), 'Tinf (h)', S.tinf, (v) => { S.tinf = v; });
      if (S.scr !== null && S.scr !== undefined) ui.field(b, 'SCr (μmol/L)', S.scr, (v) => { S.scr = v; });
      ui.dateTime(b, 'Bắt đầu truyền LIỀU ĐẦU', S.first, (v) => { S.first = v; });
      const opts = ['Giờ bắt đầu truyền LIỀU CUỐI', 'Số liều'];
      ui.choice(b, 'Kết thúc chuỗi theo', opts, S.mode === 'last' ? opts[0] : opts[1], (i) => { S.mode = i === 0 ? 'last' : 'count'; draw(); });
      if (S.mode === 'last') ui.dateTime(b, 'Bắt đầu truyền LIỀU CUỐI', S.last, (v) => { S.last = v; }, true);
      else ui.field(b, 'Số liều', S.count, (v) => { S.count = v; }, { hint: 'vd 5' });
    };
    draw();
  };
  const preview = (r) => {
    let checks = [];
    const m = openModal('Xác nhận các liều sẽ thêm', [
      { label: '◀ Sửa lại', color: Col.gray, onClick: (close) => { close(); form(); } },
      { label: 'Thêm', color: Col.greenBtn, onClick: (close) => {
        const times = r.items.filter((_, i) => checks[i].checked).map((x) => x.at);
        if (!times.length) return;
        close(); S.onAdd(times, S.dose, S.tau, S.tinf, S.scr ?? '');
      } }]);
    const b = m.body;
    const summary = ui.text(b, '', 14, Col.text, false, 4);
    if (r.notes && r.notes.length) { const t = ui.text(b, r.notes.map((x) => 'ℹ️ ' + x).join('\n'), 13, Col.amber, false, 6); t.style.whiteSpace = 'pre-line'; }
    const refresh = () => {
      const k = checks.filter((c) => c.checked).length;
      summary.textContent = `Sẽ thêm ${k}/${checks.length} liều ${g(toNum(S.dose))} mg, Tinf ${S.tinf} h, cách nhau τ = ${S.tau} h. Bỏ tick liều bị bỏ hoặc trễ thực tế (sửa giờ sau khi thêm).`;
      m.btns[1].textContent = `Thêm ${k} liều`; m.btns[1].disabled = k === 0;
    };
    r.items.forEach((it, i) => {
      checks.push(ui.check(b, `${i + 1}. ${it.label}`, it.on, refresh));
      if (it.warn) ui.text(b, '⚠️ ' + it.warn, 12, Col.amber, false, 0).style.paddingLeft = '28px';
    });
    refresh();
  };
  form();
}

// ================================================================== Tab 1: buoc 1 benh nhan
function invalidateResults() { const st = App.st; st.pop = null; st.szCalc = null; st.sz4 = null; st.bayes = null; }
function buildPatient(p) {
  const st = App.st;
  const c = ui.card(p);
  ui.field(c, 'MSYT (bắt buộc để lưu)', st.msyt, (v) => { st.msyt = v.trim(); }, { numeric: false });
  const r1 = ui.row(c);
  ui.choice(ui.cell(r1), 'Giới tính', ['nam', 'nữ'], st.gender, (_, v) => { st.gender = v; invalidateResults(); });
  ui.field(ui.cell(r1), 'Tuổi', st.age, (v) => { st.age = v; invalidateResults(); });
  const r2 = ui.row(c);
  ui.field(ui.cell(r2), 'Cân nặng (kg)', st.weight, (v) => { st.weight = v; invalidateResults(); });
  ui.field(ui.cell(r2), 'Chiều cao (cm)', st.height, (v) => { st.height = v; invalidateResults(); });
  const drugs = jsonList(App.meta.drugs).length ? jsonList(App.meta.drugs) : ['Gentamicin', 'Tobramycin', 'Amikacin'];
  ui.choice(c, 'Aminoglycosid', drugs, st.drug, (_, v) => { st.drug = v; invalidateResults(); st.models = null; });
  ui.field(c, 'MIC (mg/L) — bỏ trống = mặc định 4', st.mic, (v) => { st.mic = v; st.newDoses.forEach((n) => { n.result = ''; }); }, { hint: '4' });
  const c2 = ui.card(p);
  ui.choice(c2, 'Phương pháp tính TDM', ['Sawchuk–Zaske', 'Bayesian'], st.method === 'sz' ? 'Sawchuk–Zaske' : 'Bayesian', (i) => {
    st.method = i === 0 ? 'sz' : 'bayes'; rebuildSteps(); go(0);
  });
  if (st.method === 'sz') {
    const sev = jsonList(App.meta.severities).length ? jsonList(App.meta.severities) : [st.severity];
    ui.choice(c2, 'Mức độ nhiễm khuẩn', sev, st.severity, (_, v) => { st.severity = v; st.pop = null; });
    const r3 = ui.row(c2);
    ui.field(ui.cell(r3), 'Cp kỳ vọng (μg/mL)', st.targetCp, (v) => { st.targetCp = v; });
    ui.field(ui.cell(r3), 'Ctr kỳ vọng (μg/mL)', st.targetCtr, (v) => { st.targetCtr = v; });
    ui.hint(c2, 'Sawchuk–Zaske: 2 mẫu trong cùng một khoảng liều; phần mềm tự cộng dồn tồn dư các liều trước.');
  } else {
    ui.hint(c2, 'Bayesian: dùng mô hình dược động học quần thể làm tiền nghiệm; nhập được nhiều lần đo SCr, nhiều liều, nhiều mẫu. Các mô hình chỉ dành cho người lớn.');
  }
}

// ================================================================== Tab 1: Sawchuk-Zaske (SzSteps.kt)
const SzSteps = {
  steps() {
    return [{ title: 'Liều khởi đầu theo quy trình', build: this.buildPopulation.bind(this) },
      { title: 'Các liều thực tế & mẫu TDM', build: this.buildBlocks.bind(this) },
      { title: 'Kết quả cá thể hóa', build: this.buildResult.bind(this) },
      { title: 'Hiệu chỉnh liều', build: this.buildAdjust.bind(this) }];
  },
  timer: null,
  schedule(f) { clearTimeout(this.timer); this.timer = setTimeout(f, 350); },
  buildPopulation(p) {
    const st = App.st;
    const c = ui.card(p);
    let box, note;
    ui.field(c, 'Liều khởi đầu (mg/kg) — người dùng nhập', st.doseMgKg, (v) => { st.doseMgKg = v; this.schedule(() => this.refreshPop(box, note)); });
    box = add(c, ui.vbox());
    note = ui.status(c);
    this.refreshPop(box, note);
    ui.hint(p, 'Cân nặng tính liều, giới hạn liều tối đa và bước làm tròn theo quy trình (giống bản máy tính). Liều này được điền sẵn cho liều thứ 1 ở bước sau.');
  },
  refreshPop(box, note) {
    const st = App.st;
    py('sz_population', st.szJson(), (r) => {
      if (!r.ok) { ui.setStatus(note, r.message, 'error'); return; }
      st.pop = r;
      box.innerHTML = '';
      ui.metrics(box, [['BMI', num(r.bmi, 2)], ['IBW (kg)', num(r.ibw, 2)], ['Cân nặng tính liều (kg)', num(r.dosing_weight, 2)],
        ['Tổng liều đầu (mg)', g(r.total_dose)]]);
      ui.setStatus(note, r.note, r.level);
      const b0 = st.blocks[0];
      if (st.blocks.length === 1 && b0 && !b0.s1c && !b0.s2c) b0.dose = g(r.total_dose);
    });
  },
  hoursBetween(a0, b0) {
    const x = parseIso(a0), y = parseIso(b0);
    return (x && y) ? ` = ${num((y - x) / 3600000, 2)} h kể từ lúc bắt đầu truyền` : '';
  },
  changed() { App.st.szCalc = null; App.st.sz4 = null; },
  buildBlocks(p) {
    const st = App.st;
    ui.hint(p, 'Nhập LẦN LƯỢT từng liều thực tế (kể cả liều không lấy máu). Với liều có lấy máu, nhập thêm 2 thời điểm định lượng + nồng độ. Phần mềm tự sắp theo thời gian, tự cộng dồn tồn dư các liều trước.');
    st.blocks.forEach((b, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Liều thứ ${i + 1}`);
      ui.smallButton(head, '🗑 Xóa', Col.red, () => { st.blocks.splice(i, 1); if (!st.blocks.length) st.blocks.push(new SzBlock()); this.changed(); redraw(); });
      ui.dateTime(c, 'Bắt đầu truyền', b.start, (v) => { b.start = v; this.changed(); });
      const r1 = ui.row(c);
      ui.field(ui.cell(r1), 'SCr (μmol/L)', b.scr, (v) => { b.scr = v; this.changed(); });
      ui.field(ui.cell(r1), 'Tổng liều thực tế (mg)', b.dose, (v) => { b.dose = v; this.changed(); });
      const r2 = ui.row(c);
      ui.field(ui.cell(r2), 'τ (h)', b.tau, (v) => { b.tau = v; this.changed(); });
      ui.field(ui.cell(r2), 'Tinf (h)', b.tinf, (v) => { b.tinf = v; this.changed(); });
      let h1, h2;
      ui.dateTime(c, 'Thời điểm định lượng 1', b.s1t, (v) => { b.s1t = v; this.changed(); h1.textContent = v ? 'T1' + this.hoursBetween(b.start, v) : ''; }, true);
      h1 = ui.text(c, b.s1t ? 'T1' + this.hoursBetween(b.start, b.s1t) : '', 12, Col.muted, false, 2);
      ui.field(c, 'Nồng độ AG mẫu 1 (μg/mL)', b.s1c, (v) => { b.s1c = v; this.changed(); });
      ui.dateTime(c, 'Thời điểm định lượng 2', b.s2t, (v) => { b.s2t = v; this.changed(); h2.textContent = v ? 'T2' + this.hoursBetween(b.start, v) : ''; }, true);
      h2 = ui.text(c, b.s2t ? 'T2' + this.hoursBetween(b.start, b.s2t) : '', 12, Col.muted, false, 2);
      ui.field(c, 'Nồng độ AG mẫu 2 (μg/mL)', b.s2c, (v) => { b.s2c = v; this.changed(); });
      if (b.resultText) ui.text(c, b.resultText, 13, ui.levelColor(b.resultLevel, b.resultText), false, 8);
    });
    ui.button(p, '➕ Thêm liều kế tiếp', Col.blue, 12, () => {
      const prev = st.blocks[st.blocks.length - 1];
      const ok = prev && parseIso(prev.start) && toNum(prev.tau) !== null && toNum(prev.dose) !== null && toNum(prev.tinf) !== null;
      st.blocks.push(ok ? new SzBlock({ start: isoPlusHours(prev.start, toNum(prev.tau)), scr: prev.scr || '80', dose: prev.dose, tau: prev.tau, tinf: prev.tinf }) : new SzBlock());
      this.changed(); redraw(); scrollToBottom();
    });
    ui.button(p, '📋 Nhập nhiều liều', Col.gray, 8, () => {
      const valid = st.blocks.filter((b) => parseIso(b.start) && toNum(b.tau) !== null);
      const last = lastByTime(valid, (b) => b.start);
      const tau = (last && toNum(last.tau) > 0) ? toNum(last.tau) : 24;
      multiDose({ first: last ? isoPlusHours(last.start, tau) : nowHourIso(),
        dose: last ? last.dose : g(st.pop ? st.pop.total_dose : 400), tau: g(tau), tinf: last ? last.tinf : '1',
        scr: last ? (last.scr || '80') : '80', existing: valid.map((b) => [b.start, b.tinf]),
        onAdd: (times, dose, t, tinf, scr) => {
          if (st.blocks.length === 1 && !valid.length) st.blocks = [];
          times.forEach((at) => st.blocks.push(new SzBlock({ start: at, scr, dose, tau: t, tinf })));
          st.blocks.sort((x, y) => (parseIso(x.start) || new Date(8.64e15)) - (parseIso(y.start) || new Date(8.64e15)));
          this.changed(); redraw(); toast(`Đã thêm ${times.length} liều.`);
        } });
    });
    const status = ui.status(p);
    if (st.checkMsg) ui.setStatus(status, st.checkMsg, st.checkLevel);
    ui.button(p, '🔎 Kiểm tra T1/T2 theo SOP', Col.gray, 8, () => {
      py('sz_check', st.szJson(), (r) => { st.checkMsg = r.message; st.checkLevel = r.level; ui.setStatus(status, st.checkMsg, st.checkLevel); });
    });
  },
  buildResult(p) {
    const st = App.st;
    const status = ui.status(p);
    const box = add(p, ui.vbox());
    ui.setStatus(status, 'Đang tính…');
    py('sz_calc', st.szJson(), (r) => {
      if (Array.isArray(r.order)) { const sorted = r.order.map((k) => st.blocks[k]); st.blocks = sorted; }
      if (Array.isArray(r.blocks)) r.blocks.forEach((o, i) => { if (st.blocks[i]) { st.blocks[i].resultText = o.text || ''; st.blocks[i].resultLevel = o.level || 'info'; } });
      ui.setStatus(status, r.message, r.level);
      st.szCalc = r.ok ? r : null;
      if (!r.ok) { this.showPerBlock(box); return; }
      const s = r.sec3;
      ui.metrics(box, [['Ke cá thể (h⁻¹)', num(s.ke, 4)], ['T1/2 cá thể (h)', num(s.thalf, 2)], ['Vd cá thể (L)', num(s.vd, 2)],
        ['Cp thật (μg/mL)', num(s.cp, 2)], ['Ctrough thật (μg/mL)', num(s.ctr, 3)]]);
      if (r.auc) {
        ui.metrics(box, [['AUCτ liều đã đo (mg·h/L)', optNum(r.auc, 'auc_tau', 1)], ['AUC24 (mg·h/L)', optNum(r.auc, 'auc24', 1)], ['AUC24/MIC', optNum(r.auc, 'auc_mic', 1)]]);
        ui.hint(box, r.auc.note || '');
      }
      ui.hint(box, r.which || '');
      this.showPerBlock(box);
      const sv = ui.status(box);
      ui.button(box, '💾 Xác nhận & Lưu lên Cloud (kết quả cá thể hóa)', Col.greenBtn, 14, () => {
        saveWithConfirm('sz_save3', Object.assign(st.szJson(), { sec3: s, results: r.results || {} }), sv);
      });
    });
  },
  showPerBlock(box) {
    ui.header(box, 'Chi tiết từng liều');
    App.st.blocks.forEach((b, i) => {
      const t = b.resultText || `Liều thứ ${i + 1}: không có mẫu — chỉ dùng để cộng dồn.`;
      ui.text(box, t, 13, ui.levelColor(b.resultLevel, t), false, 6);
    });
  },
  buildAdjust(p) {
    const st = App.st;
    const calc = st.szCalc;
    if (!calc) { ui.text(p, '❌ Chưa có kết quả cá thể hóa hợp lệ — quay lại bước trước.', 15, Col.red, false, 12); return; }
    const c = ui.card(p);
    const r1 = ui.row(c);
    ui.field(ui.cell(r1), 'Liều mới (mg)', st.newDose, (v) => { st.newDose = v; });
    ui.field(ui.cell(r1), 'τ mới (h)', st.newTau, (v) => { st.newTau = v; });
    ui.field(c, "Thời gian truyền mới t' (h)", st.newTinf, (v) => { st.newTinf = v; });
    const status = ui.status(c);
    const res = add(c, ui.vbox());
    let chartBox;
    const compute = () => {
      const req = { sec3: calc.sec3, new_dose: st.newDose, new_tau: st.newTau, new_t_inf: st.newTinf, drug: st.drug,
        target_cp: st.targetCp, target_ctr: st.targetCtr, cycles: st.cycles, mic: st.mic };
      py('sz_newdose', req, (r) => {
        ui.setStatus(status, r.message, r.level);
        res.innerHTML = '';
        if (!r.ok) { st.sz4 = null; return; }
        st.sz4 = r;
        ui.metrics(res, [["C'p dự đoán SS (μg/mL)", num(r.cp_pred, 2)], ["C'tr dự đoán SS (μg/mL)", num(r.ctr_pred, 3)],
          ['AUC24 dự đoán SS (mg·h/L)', optNum(r, 'auc24', 1)], ['AUC24/MIC dự đoán', optNum(r, 'auc_mic', 1)]]);
        ui.hint(res, r.mic_note || '');
        chartBox.innerHTML = '';
        if (r.chart) drawChart(chartBox, r.chart, Col.blue);
      });
    };
    ui.button(c, '🧮 TÍNH TOÁN LIỀU MỚI', Col.blue, 10, compute);
    const cc = ui.card(p);
    ui.header(cc, 'Đồ thị nồng độ qua nhiều chu kỳ liều');
    ui.choice(cc, 'Số chu kỳ', Array.from({ length: 19 }, (_, i) => String(i + 2)), String(st.cycles), (_, v) => { st.cycles = +v; compute(); });
    chartBox = add(cc, ui.vbox());
    const sv = ui.status(p);
    ui.button(p, '💾 Xác nhận & Lưu phác đồ mới lên Cloud', Col.greenBtn, 14, () => {
      const s4 = st.sz4;
      if (!s4) { ui.setStatus(sv, '⚠️ Vui lòng tính liều mới trước.', 'warn'); return; }
      saveWithConfirm('sz_save4', Object.assign(st.szJson(), { sec3: calc.sec3, sec4: { cp_pred: s4.cp_pred, ctr_pred: s4.ctr_pred },
        new_dose: st.newDose, new_tau: st.newTau, new_t_inf: st.newTinf }), sv);
    });
    compute();
  },
};

// ================================================================== Tab 1: Bayesian (BayesSteps.kt)
const BayesSteps = {
  steps() {
    return [{ title: 'Các lần đo SCr', build: this.buildScr.bind(this) },
      { title: 'Lâm sàng & mô hình', build: this.buildClinical.bind(this) },
      { title: 'Liều đã dùng', build: this.buildDoses.bind(this) },
      { title: 'Nồng độ đo được', build: this.buildMeas.bind(this) },
      { title: 'Kết quả Bayesian', build: this.buildResult.bind(this) },
      { title: 'Liều mới & lưu', build: this.buildNewDose.bind(this) }];
  },
  changed() { App.st.bayes = null; },
  buildScr(p) {
    const st = App.st;
    ui.hint(p, 'Nhập mọi lần đo SCr trong đợt điều trị và chọn đúng đơn vị — phần mềm quy đổi sang mg/dL. Chức năng thận biến thiên theo các lần đo (nội suy theo thời gian).');
    st.scr.forEach((r, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Lần đo SCr thứ ${i + 1}`);
      ui.smallButton(head, '🗑 Xóa', Col.red, () => { st.scr.splice(i, 1); this.changed(); redraw(); });
      const r1 = ui.row(c);
      ui.field(ui.cell(r1), 'SCr', r.value, (v) => { r.value = v; this.changed(); });
      ui.choice(ui.cell(r1), 'Đơn vị', ['μmol/L', 'mg/dL'], r.unit, (_, v) => { r.unit = v; this.changed(); });
      ui.dateTime(c, 'Thời điểm đo', r.at, (v) => { r.at = v; this.changed(); });
    });
    ui.button(p, '➕ Thêm lần đo SCr', Col.blue, 12, () => {
      const last = st.scr[st.scr.length - 1];
      st.scr.push(ScrRow(last ? last.value : '80', last ? last.unit : 'μmol/L', nowHourIso()));
      this.changed(); redraw(); scrollToBottom();
    });
  },
  meta(k) {
    const arr = App.meta[k];
    if (!Array.isArray(arr)) return [['', '— chưa chọn —']];
    return arr.map((o) => [o.key, o.label]);
  },
  modelTimer: null,
  buildClinical(p) {
    const st = App.st;
    const c = ui.card(p);
    ui.hint(c, 'Để trống albumin / CrCl nước tiểu nếu chưa có. Thiếu thông tin cần thiết → phần mềm không tự chọn được, hãy tự chọn mô hình bên dưới.');
    const settings = this.meta('settings');
    const keys = settings.map((x) => x[0]), labels = settings.map((x) => x[1]);
    let modelBox;
    const later = () => { clearTimeout(this.modelTimer); this.modelTimer = setTimeout(() => this.refreshModels(modelBox), 450); };
    ui.choice(c, 'Bối cảnh điều trị', labels, labels[keys.indexOf(st.setting)] ?? labels[0], (i) => { st.setting = keys[i]; this.refreshModels(modelBox); });
    const r1 = ui.row(c);
    ui.field(ui.cell(r1), 'Albumin máu (g/L)', st.albumin, (v) => { st.albumin = v; later(); });
    ui.field(ui.cell(r1), 'CrCl nước tiểu 6 giờ (mL/phút)', st.urineCrcl, (v) => { st.urineCrcl = v; later(); });
    ui.check(c, 'Xơ nang (cystic fibrosis)', st.cf, (b) => { st.cf = b; this.refreshModels(modelBox); });
    ui.check(c, 'Bệnh phổi do NTM (mycobacteria không lao)', st.ntm, (b) => { st.ntm = b; this.refreshModels(modelBox); });
    ui.check(c, 'Bụng hở + hút áp lực âm (NPT)', st.openAbdomen, (b) => { st.openAbdomen = b; this.refreshModels(modelBox); });
    ui.check(c, 'Đang lọc máu liên tục (CRRT/CVVH)', st.crrt, (b) => { st.crrt = b; this.refreshModels(modelBox); });
    ui.check(c, 'Dùng kèm vancomycin', st.vanco, (b) => { st.vanco = b; this.refreshModels(modelBox); });
    const c2 = ui.card(p);
    ui.header(c2, 'Mô hình Bayesian');
    modelBox = add(c2, ui.vbox());
    this.refreshModels(modelBox);
  },
  refreshModels(box) {
    const st = App.st;
    this.changed();
    py('bayes_models', st.bayesJson(), (r) => {
      st.models = r;
      if (r.key && r.key !== 'null') st.modelKey = r.key;
      this.renderModels(box, r);
    });
  },
  renderModels(box, r) {
    const st = App.st;
    box.innerHTML = '';
    const ms = r.models;
    if (!Array.isArray(ms) || !ms.length) { ui.text(box, r.note || '', 14, Col.red); return; }
    const keys = ms.map((m) => m.key), labels = ms.map((m) => m.label);
    ui.choice(box, 'Mô hình', labels, labels[keys.indexOf(st.modelKey)] ?? labels[0], (i) => { st.modelKey = keys[i]; st.auto = false; this.refreshModels(box); });
    ui.check(box, 'Tự động chọn theo thông tin bệnh nhân', st.auto, (b) => { st.auto = b; this.refreshModels(box); });
    ui.text(box, r.note || '', 13, ui.levelColor(r.level), false, 6);
    const extra = [r.population, r.reference].filter((x) => x && String(x).trim());
    if (extra.length) ui.hint(box, extra.join('\n'));
  },
  buildDoses(p) {
    const st = App.st;
    ui.hint(p, 'Nhập đầy đủ các liều trước thời điểm lấy mẫu (mô hình giả định biết toàn bộ lịch sử liều). τ chỉ dùng cho nút «Liều kế tiếp» và tính Cpeak/Ctrough hiện tại. «📋 Nhập nhiều liều» thêm cả chuỗi liều giống nhau.');
    st.doses.sort((a, b) => (parseIso(a.at) || new Date(8.64e15)) - (parseIso(b.at) || new Date(8.64e15)));
    st.doses.forEach((d, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Liều thứ ${i + 1}`);
      ui.smallButton(head, '🗑', Col.red, () => { st.doses.splice(i, 1); this.changed(); redraw(); });
      ui.dateTime(c, 'Bắt đầu truyền', d.at, (v) => { d.at = v; this.changed(); });
      const r1 = ui.row(c);
      ui.field(ui.cell(r1), 'Liều (mg)', d.dose, (v) => { d.dose = v; this.changed(); });
      ui.field(ui.cell(r1), 'Tinf (h)', d.tinf, (v) => { d.tinf = v; this.changed(); });
      ui.field(ui.cell(r1), 'τ (h)', d.tau, (v) => { d.tau = v; this.changed(); });
      ui.smallButton(c, '➕ Liều kế tiếp (tự động, cách τ)', Col.blue, () => {
        const tau = (toNum(d.tau) > 0) ? toNum(d.tau) : 24;
        if (!parseIso(d.at) || toNum(d.dose) === null) { toast('⚠️ Liều dùng để nhân bản chưa hợp lệ — kiểm tra thời điểm/liều/Tinf.'); return; }
        st.doses.push(DoseRow(isoPlusHours(d.at, tau), d.dose, d.tinf, g(tau))); this.changed(); redraw();
      });
    });
    ui.button(p, '📋 Nhập nhiều liều', Col.gray, 12, () => {
      const last = lastByTime(st.doses, (d) => d.at);
      const tau = (last && toNum(last.tau) > 0) ? toNum(last.tau) : 24;
      multiDose({ first: last ? isoPlusHours(last.at, tau) : nowHourIso(), dose: last ? last.dose : '400', tau: g(tau),
        tinf: last ? last.tinf : '1', scr: null, existing: st.doses.map((d) => [d.at, d.tinf]),
        onAdd: (times, dose, t, tinf) => {
          times.forEach((at) => st.doses.push(DoseRow(at, dose, tinf, t)));
          this.changed(); redraw(); toast(`Đã thêm ${times.length} liều.`);
        } });
    });
  },
  buildMeas(p) {
    const st = App.st;
    ui.hint(p, 'Chỉ nhập Cobs và thời điểm lấy mẫu — phần mềm tự xác định mẫu thuộc liều thứ mấy. KHÔNG nhập mẫu dưới ngưỡng định lượng của máy đo (không có giá trị định lượng).');
    const lq = App.meta.lloq ? App.meta.lloq[st.drug] : null;
    ui.text(p, (lq !== null && lq !== undefined) ? `Ngưỡng định lượng ${st.drug}: ${g(lq)} mg/L — mẫu thấp hơn sẽ bị chặn.`
      : `⚠️ Chưa cấu hình ngưỡng định lượng (giới hạn phát hiện của máy) cho ${st.drug}: phần mềm chưa chặn được mẫu dưới ngưỡng, chỉ cảnh báo khi Cobs < 0,3 mg/L.`,
    13, (lq !== null && lq !== undefined) ? Col.muted : Col.amber);
    st.meas.forEach((m, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Mẫu ${i + 1}`);
      ui.smallButton(head, '🗑', Col.red, () => { st.meas.splice(i, 1); this.changed(); redraw(); });
      ui.field(c, 'Cobs (μg/mL)', m.cobs, (v) => { m.cobs = v; this.changed(); });
      ui.dateTime(c, 'Thời điểm lấy mẫu (Tobs)', m.at, (v) => { m.at = v; this.changed(); });
      if (m.assign) ui.text(c, m.assign, 13, m.warn ? Col.amber : Col.muted, false, 6);
    });
    ui.button(p, '➕ Thêm điểm đo', Col.blue, 12, () => { st.meas.push(MeasRow()); this.changed(); redraw(); scrollToBottom(); });
  },
  label(key) {
    const arr = App.meta.models;
    if (!Array.isArray(arr)) return key;
    const m = arr.find((o) => o.key === key);
    return m ? m.label : key;
  },
  buildResult(p) {
    const st = App.st;
    const head = ui.text(p, '', 16, Col.purple, true, 8);
    const note = ui.text(p, '', 13, Col.muted);
    const status = ui.status(p);
    const box = add(p, ui.vbox());
    ui.setStatus(status, 'Đang chạy tối ưu Bayesian…');
    py('bayes_models', st.bayesJson(), (m) => {
      st.models = m;
      if (st.auto && m.key && m.key !== 'null') st.modelKey = m.key;
      note.textContent = m.note || ''; note.style.color = ui.levelColor(m.level);
      py('bayes_solve', st.bayesJson(), (r) => this.show(r, head, status, box));
    });
  },
  show(r, head, status, box) {
    const st = App.st;
    head.textContent = '💊 Mô hình ' + this.label(r.model_key || st.modelKey);
    ui.setStatus(status, r.message, r.level);
    if (Array.isArray(r.assign)) r.assign.forEach((a, i) => { if (st.meas[i]) { st.meas[i].assign = a.text || ''; st.meas[i].warn = !!a.warn; } });
    if (r.warnings) ui.text(box, r.warnings, 13, ui.levelColor(r.warn_level), false, 8);
    if (!r.ok) {
      st.bayes = null;
      if (Array.isArray(r.assign)) ui.hint(box, 'Xem ghi chú dưới từng mẫu ở bước «Nồng độ đo được».');
      return;
    }
    st.bayes = r;
    const cards = r.cards, cur = r.current;
    const post = [['CL_post (L/h)', num(cards.cl, 4)], ['Vd_post / V1_post (L)', num(cards.vd, 2)], ['Ke (h⁻¹)', num(cards.ke, 4)], ['OFV_final', num(cards.ofv, 4)]];
    const items = [];
    if (cur) items.push(['Cpeak hiện tại (μg/mL)', num(cur.cpeak, 2)], ['Ctrough hiện tại (μg/mL)', num(cur.ctrough, 2)],
      ['Liều đang dùng (mg)', g(cur.dose)], ['τ đang dùng (h)', g(cur.tau)], ['AUC24h khi cân bằng (mg·h/L)', optNum(cur, 'auc24', 1)],
      ['AUC24h/MIC khi cân bằng', optNum(cur, 'auc_mic', 1)]);
    if (items.length) ui.metrics(box, items);
    if (cur) ui.hint(box, r.mic_note || '');
    // v0.11.1: tien nghiem (eta_text) + hau nghiem thu gon, bam de xem
    const fb = ui.fold(ui.card(box), 'Tham số tiền nghiệm / Kết quả hậu nghiệm');
    ui.metrics(fb, post);
    ui.text(fb, r.eta_text || '', 13, Col.muted, false, 10);
    ui.text(fb, r.points_text || '', 13, Col.muted, false, 8);
    if (r.chart) {
      const cc = ui.card(box);
      ui.header(cc, 'Đường cong nồng độ mô phỏng (hậu nghiệm)');
      ui.hint(cc, 'Đường tím: C(t) dự đoán; chấm đỏ: Cobs đo được.');
      drawChart(cc, r.chart, Col.purple);
    }
    if (!st.newDoses.length && cur) st.newDoses.push(NewDose(g(cur.dose), g(cur.tau), g(cur.tinf)));
  },
  buildNewDose(p) {
    const st = App.st;
    let histBox;
    if (!st.bayes) {
      ui.text(p, '⚠️ Chưa có kết quả Bayesian hợp lệ — quay lại bước «Kết quả Bayesian».', 15, Col.amber, false, 12);
    } else {
      ui.hint(p, 'Nhập nhiều tổ hợp (liều mới, τ mới, Tinf mới) để so sánh Cpeak/Ctrough dự đoán ở trạng thái ổn định (dùng thông số cá thể vừa tối ưu).');
      st.newDoses.forEach((nd, i) => {
        const c = ui.card(p, 8);
        const r1 = ui.row(c);
        ui.field(ui.cell(r1), 'Liều mới (mg)', nd.dose, (v) => { nd.dose = v; });
        ui.field(ui.cell(r1), 'τ mới (h)', nd.tau, (v) => { nd.tau = v; });
        ui.field(ui.cell(r1), 'Tinf mới (h)', nd.tinf, (v) => { nd.tinf = v; });
        const res = ui.text(c, nd.result || 'Cpeak: --   Ctrough: --', 15, Col.blue, true, 6);
        res.style.whiteSpace = 'pre-line';
        const r2 = ui.row(c);
        const calc = () => py('bayes_newdose', { dose: nd.dose, tau: nd.tau, tinf: nd.tinf, mic: st.mic }, (r) => {
          if (r.ok) {
            nd.result = `Cpeak: ${num(r.cpeak, 2)} μg/mL   Ctrough: ${num(r.ctrough, 2)} μg/mL\nAUC24h khi cân bằng: ${optNum(r, 'auc24', 1)} mg·h/L   AUC24h/MIC: ${optNum(r, 'auc_mic', 1)}`;
            res.textContent = nd.result;
          } else toast(r.message);
        });
        ui.smallButton(r2, '🧮 Tính', Col.blue, calc);
        ui.smallButton(r2, '🗑', Col.red, () => { st.newDoses.splice(i, 1); redraw(); });
        if (!nd.result) calc();
      });
      ui.button(p, '➕ Thêm tổ hợp liều mới', Col.gray, 10, () => {
        const cur = st.bayes && st.bayes.current;
        st.newDoses.push(cur ? NewDose(g(cur.dose), g(cur.tau), '1') : NewDose());
        redraw(); scrollToBottom();
      });
      const sv = ui.status(p);
      ui.button(p, '💾 Lưu kết quả TDM Bayesian lên Cloud', Col.greenBtn, 16, () => {
        py('bayes_save', st.bayesJson(), (r) => { ui.setStatus(sv, r.message, r.level); if (r.ok) this.loadHistory(histBox); });
      });
    }
    const hc = ui.card(p, 16);
    ui.header(hc, `Lịch sử kết quả Bayesian (MSYT ${st.msyt || '—'})`);
    histBox = add(hc, ui.vbox());
    this.renderHistory(histBox);
    if (st.msyt) ui.smallButton(hc, '↻ Tải lại lịch sử', Col.gray, () => this.loadHistory(histBox));
  },
  loadHistory(box) {
    const st = App.st;
    if (!st.msyt) return;
    py('bayes_history', { msyt: st.msyt }, (r) => { st.history = r.history || null; this.renderHistory(box); });
  },
  renderHistory(box) {
    box.innerHTML = '';
    const h = App.st.history;
    if (!Array.isArray(h) || !h.length) { ui.hint(box, 'Chưa có (tải bằng MSYT ở Trang chính hoặc sau khi lưu).'); return; }
    h.forEach((o) => {
      const d = (k, n) => (o[k] === null || o[k] === undefined) ? '--' : num(Number(o[k]), n);
      const t = ui.text(box, `${o.date || ''} · ${o.model || ''}\n   CL ${d('cl', 3)} · V ${d('vd', 2)} · Cpeak ${d('cpeak', 2)} · Ctrough ${d('ctrough', 2)} · Liều/τ ${o.dose_tau || ''}`, 13, Col.text, false, 6);
      t.style.whiteSpace = 'pre-line';
    });
  },
};

// ================================================================== Tab 4 Vancomycin (VancoSteps.kt)
const VancoSteps = {
  steps() {
    return [{ title: 'Bệnh nhân & mô hình', build: this.buildPatient.bind(this) },
      { title: 'Các lần đo SCr', build: this.buildScr.bind(this) },
      { title: 'Liều đã dùng', build: this.buildDoses.bind(this) },
      { title: 'Nồng độ đo được', build: this.buildMeas.bind(this) },
      { title: 'Kết quả Bayes', build: this.buildResult.bind(this) },
      { title: 'Liều mới & dự đoán', build: this.buildNewDose.bind(this) },
      { title: 'Lưu & lịch sử', build: this.buildSave.bind(this) }];
  },
  changed() { App.vs.result = null; App.vs.newRes = null; },
  methods() { return Array.isArray(App.vmeta.methods) ? App.vmeta.methods : ['Goti 2018', 'Collin 2019']; },
  buildPatient(p) {
    const vs = App.vs;
    const c = ui.card(p);
    ui.field(c, 'MSYT (bắt buộc để lưu / tải dữ liệu)', vs.msyt, (v) => { vs.msyt = v.trim(); }, { numeric: false });
    const r1 = ui.row(c);
    ui.choice(ui.cell(r1), 'Giới tính', ['nam', 'nữ'], vs.gender, (_, v) => { vs.gender = v; this.changed(); });
    ui.field(ui.cell(r1), 'Tuổi', vs.age, (v) => { vs.age = v; this.changed(); });
    const r2 = ui.row(c);
    ui.field(ui.cell(r2), 'Chiều cao (cm)', vs.height, (v) => { vs.height = v; this.changed(); });
    ui.field(ui.cell(r2), 'Cân nặng (kg)', vs.weight, (v) => { vs.weight = v; this.changed(); });
    const c2 = ui.card(p);
    ui.choice(c2, '⚙️ Phương pháp tính Bayes', this.methods(), vs.method, (_, v) => { vs.method = v; this.changed(); redraw(); });
    ui.text(c2, (App.vmeta.population || {})[vs.method] || '', 13, Col.muted, false, 8);
    const fl = ((App.vmeta.flags || {})[vs.method]) || [];
    if (fl.length) ui.divider(c2);
    if (fl.includes('dialysis')) ui.check(c2, 'Đang lọc máu (Hemodialysis)', vs.dialysis, (b) => { vs.dialysis = b; this.changed(); });
    if (fl.includes('malignancy')) ui.check(c2, 'Bệnh máu ác tính (STDY10)', vs.malignancy, (b) => { vs.malignancy = b; this.changed(); });
    if (fl.includes('heelprick')) ui.check(c2, 'Mẫu lấy gót chân - Heel-prick (STDY13)', vs.heelprick, (b) => { vs.heelprick = b; this.changed(); });
    if (fl.includes('gpos')) ui.check(c2, 'Nhiễm khuẩn Gram dương (dis_gpos — Yamamoto)', vs.gpos, (b) => { vs.gpos = b; this.changed(); });
  },
  buildScr(p) {
    const vs = App.vs;
    ui.hint(p, 'Chọn đúng đơn vị SCr cho từng dòng — phần mềm quy đổi tự động sang mg/dL để tính toán.');
    vs.scr.forEach((r, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Lần đo SCr thứ ${i + 1}`);
      ui.smallButton(head, '🗑 Xóa', Col.red, () => { vs.scr.splice(i, 1); this.changed(); redraw(); });
      const r1 = ui.row(c);
      ui.field(ui.cell(r1), 'SCr', r.value, (v) => { r.value = v; this.changed(); });
      ui.choice(ui.cell(r1), 'Đơn vị', ['μmol/L', 'mg/dL'], r.unit, (_, v) => { r.unit = v; this.changed(); });
      ui.dateTime(c, 'Thời điểm đo', r.at, (v) => { r.at = v; this.changed(); });
    });
    ui.button(p, '➕ Thêm lần đo SCr', Col.blue, 12, () => {
      const last = vs.scr[vs.scr.length - 1];
      vs.scr.push(ScrRow(last ? last.value : '80', last ? last.unit : 'μmol/L', nowHourIso())); this.changed(); redraw(); scrollToBottom();
    });
  },
  buildDoses(p) {
    const vs = App.vs;
    ui.hint(p, 'Nhập lịch sử truyền thuốc — MỖI LIỀU có thời gian truyền Tinf riêng. «➕ Liều kế tiếp» thêm liều ngay sau liều đó, cách τ giờ, cùng liều và Tinf. «📋 Nhập nhiều liều» thêm cả chuỗi liều giống nhau.');
    vs.doses.forEach((d, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Liều ${i + 1}`);
      ui.smallButton(head, '🗑', Col.red, () => { vs.doses.splice(i, 1); this.changed(); redraw(); });
      const r1 = ui.row(c);
      ui.field(ui.cell(r1), 'Liều (mg)', d.dose, (v) => { d.dose = v; this.changed(); });
      ui.field(ui.cell(r1), 'τ (h)', d.tau, (v) => { d.tau = v; this.changed(); });
      ui.field(ui.cell(r1), 'Tinf (h)', d.tinf, (v) => { d.tinf = v; this.changed(); });
      ui.dateTime(c, 'Bắt đầu truyền', d.at, (v) => { d.at = v; this.changed(); });
      ui.smallButton(c, '➕ Liều kế tiếp (tự động)', Col.blue, () => {
        const tau = toNum(d.tau) ?? 12;
        vs.doses.splice(i + 1, 0, VDoseRow(isoPlusHours(d.at, tau), d.dose, d.tau, d.tinf)); this.changed(); redraw();
      });
    });
    ui.button(p, '📋 Nhập nhiều liều', Col.gray, 12, () => {
      const last = lastByTime(vs.doses, (d) => d.at);
      const tau = (last && toNum(last.tau) > 0) ? toNum(last.tau) : 12;
      multiDose({ first: last ? isoPlusHours(last.at, tau) : nowHourIso(), dose: last ? last.dose : '1000', tau: g(tau),
        tinf: last ? last.tinf : '1', scr: null, existing: vs.doses.map((d) => [d.at, d.tinf]),
        onAdd: (times, dose, t, tinf) => {
          times.forEach((at) => vs.doses.push(VDoseRow(at, dose, t, tinf)));
          vs.doses.sort((x, y) => (parseIso(x.at) || new Date(8.64e15)) - (parseIso(y.at) || new Date(8.64e15)));
          this.changed(); redraw(); toast(`Đã thêm ${times.length} liều.`);
        } });
    });
  },
  buildMeas(p) {
    const vs = App.vs;
    ui.hint(p, 'Có thể nhập nhiều lần đo (nhiều lần TDM khác khoảng đưa liều, hoặc peak + trough cùng khoảng đưa liều). Thời gian truyền nhập ở bước «Liều đã dùng». Mẫu ĐÁY lấy ngay trước liều N+1 muốn tính chung một lần TDM với mẫu ĐỈNH sau liều N+1: đánh dấu «Gộp với liều kế tiếp» ở mẫu đáy (Goti/Collin chạy chung 1 OFV).');
    vs.meas.forEach((m, i) => {
      const c = ui.card(p, 10);
      const head = headRow(c, `Điểm đo ${i + 1}`);
      ui.smallButton(head, '🗑', Col.red, () => { vs.meas.splice(i, 1); this.changed(); redraw(); });
      ui.field(c, 'Cobs (μg/mL)', m.cobs, (v) => { m.cobs = v; this.changed(); });
      ui.dateTime(c, 'Tobs (thời điểm lấy mẫu)', m.at, (v) => { m.at = v; this.changed(); });
      ui.check(c, 'Gộp với liều kế tiếp (đáy trước liều N+1 + đỉnh sau liều N+1 = 1 lần TDM)', m.groupNext, (b) => { m.groupNext = b; this.changed(); });
    });
    ui.button(p, '➕ Thêm điểm đo', Col.blue, 12, () => { vs.meas.push(VMeasRow()); this.changed(); redraw(); scrollToBottom(); });
  },
  buildResult(p) {
    const vs = App.vs;
    const status = ui.status(p);
    const box = add(p, ui.vbox());
    ui.setStatus(status, 'Đang chạy tối ưu Bayes…');
    py('v_solve', vs.json(), (r) => {
      vs.result = r.ok ? r : null;
      vs.proj = null;
      ui.setStatus(status, r.message, r.level);
      if (r.priors) {
        const pr = r.priors;
        const c = ui.fold(ui.card(box), 'Tham số tiền nghiệm — ' + vs.method);
        ui.metrics(c, [['CrCl (mL/phút)', String(pr.crcl ?? '')], ['CLprior (L/h)', String(pr.cl ?? '')], ['Vc,prior (L)', String(pr.vc ?? '')], ['Vp,prior (L)', String(pr.vp ?? '')]]);
        ui.text(c, pr.info || '', 12, Col.muted, false, 8);
      }
      if (!r.ok) return;
      const k = r.cards;
      const c = ui.fold(ui.card(box), 'Kết quả hậu nghiệm');
      ui.metrics(c, [['CL_optimized (L/h)', k.cl], ['Vc_optimized (L)', k.vc], ['Vp_optimized (L)', k.vp], ['C_pred_final (μg/mL)', k.cpred],
        ['OFV_final', k.ofv], ['k10 (h⁻¹)', k.k10], ['k12 (h⁻¹)', k.k12], ['k21 (h⁻¹)', k.k21], ['α (h⁻¹)', k.alpha], ['β (h⁻¹)', k.beta]].map(([a, b]) => [a, String(b ?? '')]));
      const c2 = ui.card(box);
      ui.header(c2, 'AUC24h');
      ui.metrics(c2, [['AUC24h ngày TDM (mg·h/L)', String(r.auc_day ?? '')], ['AUC24h khi cân bằng (mg·h/L)', String(r.auc_current ?? '')]]);
      ui.text(c2, r.auc_day_info || '', 12, Col.muted, false, 6);
      if (r.chart) {
        const cc = ui.card(box);
        ui.header(cc, 'Đường cong nồng độ mô phỏng');
        ui.hint(cc, 'Đường tím: C(t) hậu nghiệm; chấm đỏ: Cobs của lần TDM cuối.');
        drawChart(cc, r.chart, Col.purple);
      }
    });
  },
  buildNewDose(p) {
    const vs = App.vs;
    if (!vs.result) { ui.text(p, '⚠️ Chưa có kết quả Bayes hợp lệ — quay lại bước «Kết quả Bayes».', 15, Col.amber, false, 12); return; }
    vs.extraRegs = vs.extraRegs || [];
    // ---- phac do so sanh (v0.13.0)
    const c = ui.card(p);
    ui.header(c, 'Phác đồ so sánh');
    ui.hint(c, 'Phác đồ mới bắt đầu từ: giờ liều cuối đã nhập + τ mới. Dòng «đang dùng» được thêm tự động.');
    const r1 = ui.row(c);
    ui.field(ui.cell(r1), 'Liều (mg)', vs.newDose, (v) => { vs.newDose = v; vs.proj = null; });
    ui.field(ui.cell(r1), 'τ (giờ)', vs.newTau, (v) => { vs.newTau = v; vs.proj = null; });
    ui.field(ui.cell(r1), 'Tinf (giờ)', vs.newTinf, (v) => { vs.newTinf = v; vs.proj = null; });
    vs.extraRegs.forEach((g, i) => {
      const rr = ui.row(c);
      ui.field(ui.cell(rr), 'Liều (mg)', g[0], (v) => { g[0] = v; vs.proj = null; });
      ui.field(ui.cell(rr), 'τ (giờ)', g[1], (v) => { g[1] = v; vs.proj = null; });
      ui.field(ui.cell(rr), 'Tinf (giờ)', g[2], (v) => { g[2] = v; vs.proj = null; });
      ui.smallButton(ui.cell(rr, 0.45), '✖', Col.gray, () => { vs.extraRegs.splice(i, 1); vs.proj = null; redraw(); });
    });
    if (vs.extraRegs.length < 4) ui.smallButton(c, '+ Thêm phác đồ', Col.purple, () => { vs.extraRegs.push([vs.newDose, vs.newTau, vs.newTinf]); vs.proj = null; redraw(); });
    const st = ui.status(c);
    const project = () => {
      const regs = [{ dose: vs.newDose, tau: vs.newTau, tinf: vs.newTinf }].concat(vs.extraRegs.map((g) => ({ dose: g[0], tau: g[1], tinf: g[2] })));
      py('v_project', { regimens: regs, include_current: true }, (r) => {
        if (!r.ok) { vs.proj = null; ui.setStatus(st, r.message, r.level || 'warn'); return; }
        vs.proj = r; vs.projSel = (r.items || []).length > 1 ? 1 : 0; redraw();
      });
    };
    ui.button(c, '🧮 TÍNH DỰ ĐOÁN', Col.purple, 10, project);
    if (vs.proj) { this.matrix(p, vs.proj); this.detail(p, vs.proj); } else project();
  },
  matrix(p, pr) {
    const vs = App.vs, items = pr.items || [];
    const c = ui.card(p, 10);
    ui.header(c, 'So sánh phác đồ — AUC24h (mg·h/L)');
    const d0 = items[0].days[0];
    ui.hint(c, `Ngày TDM (${d0.date}, liều đã dùng): ${d0.auc} · CL bệnh nhân ${pr.cl} L/h`);
    const head = add(c, el('div', 'pmx pmx-h'));
    ['Phác đồ', '+1', '+2', '+3', '+4', 'Cân bằng'].forEach((t, i) => add(head, el('div', i === 5 ? 'pmx-ss' : null, t)));
    items.forEach((it, i) => {
      const row = add(c, el('button', 'pmx pmx-row' + (i === vs.projSel ? ' sel' : '')));
      const lab = add(row, el('div', 'pmx-lab'));
      add(lab, el('b', null, it.label));
      const sub = it.current ? 'đang dùng' : (i === vs.projSel ? 'đang xem' : '');
      if (sub) add(lab, el('span', null, sub));
      for (let k = 1; k <= 4; k++) add(row, el('div', 'pchip st-' + it.days[k].status, String(it.days[k].auc)));
      add(row, el('div', 'pchip solid st-' + it.ss.status, it.ss.text));
      row.addEventListener('click', (ev) => { ev.preventDefault(); vs.projSel = i; redraw(); });
    });
    const anyRange = items.some((it) => it.ss.range);
    ui.hint(c, 'Nền xanh: 400–600 · đỏ: > 600 · vàng: < 400. Bấm 1 dòng để xem chi tiết từng ngày.' +
      (anyRange ? '\nτ không chia hết 24 h: AUC mỗi ngày khác nhau — cột «Cân bằng» ghi khoảng thấp nhất–cao nhất.' : '')).style.whiteSpace = 'pre-line';
  },
  detail(p, pr) {
    const vs = App.vs, items = pr.items || [];
    const it = items[Math.min(Math.max(vs.projSel || 0, 0), items.length - 1)];
    const c = ui.card(p, 10);
    ui.header(c, `Chi tiết: ${it.label}, Tinf ${g(it.tinf)} h`);
    ui.hint(c, 'Liều đầu của phác đồ: ' + it.start);
    const worst = it.days.slice(1).map((d) => d.status).concat([it.ss.status]);
    const tone = worst.includes('high') ? 'high' : (worst.includes('low') ? 'low' : 'ok');
    add(c, el('div', 'pban st-' + tone, it.summary));
    const tb = add(c, el('div', 'pdt'));
    const hd = add(tb, el('div', 'pdt-row pdt-h'));
    ['Ngày', 'AUC24h', 'Cmin', 'Đánh giá'].forEach((t) => add(hd, el('div', null, t)));
    it.days.forEach((d) => {
      const r = add(tb, el('div', 'pdt-row' + (d.k === 0 ? ' tdm' : '')));
      const l = add(r, el('div', 'pdt-lab')); add(l, el('b', null, d.label)); add(l, el('span', null, d.date + (d.k === 0 ? ' · đã dùng' : '')));
      add(r, el('div', 'pdt-auc st-' + d.status, String(d.auc)));
      add(r, el('div', 'pdt-num', num(d.cmin, 1)));
      const cc = add(r, el('div')); add(cc, el('span', 'pchip ' + (d.status === 'high' ? 'solid ' : '') + 'st-' + d.status, d.status_vi));
    });
    const rs = add(tb, el('div', 'pdt-row ss'));
    add(rs, el('div', 'pdt-lab', null)).appendChild(el('b', null, 'Khi cân bằng'));
    add(rs, el('div', 'pdt-auc big st-' + it.ss.status, it.ss.text));
    add(rs, el('div', 'pdt-num', ''));
    const cs = add(rs, el('div')); add(cs, el('span', 'pchip solid st-' + it.ss.status, it.ss.status_vi));
    ui.hint(c, 'Đạt: 400–600 · Cao: > 600 · Thấp: < 400 · Cmin: nồng độ thấp nhất trong ngày (μg/mL).');
    // ---- Cpred tai thoi diem chon
    const cc = ui.card(p, 10);
    ui.header(cc, 'Cpred tại thời điểm chọn');
    ui.dateTime(cc, 'Thời điểm (bỏ trống = 30 phút trước liều thứ 5 của phác đồ)', vs.target, (v) => { vs.target = v; }, true);
    const res = add(cc, ui.vbox());
    const calc = () => py('v_newdose', { new_dose: it.dose, new_tau: it.tau, new_tinf: it.tinf, target: vs.target }, (r) => {
      res.innerHTML = ''; vs.newRes = r;
      if (!r.ok) { ui.text(res, r.message || '', 14, Col.amber); return; }
      ui.metrics(res, [['Cpred dự đoán (μg/mL)', String(r.cpred ?? '')]]);
      ui.text(res, r.cpred_note || '', 12, Col.muted, false, 6);
    });
    ui.button(cc, 'Tính Cpred', Col.blue, 8, calc);
    calc();
  },
  hist: null, delStatus: null,
  buildSave(p) {
    const vs = App.vs;
    const sv = ui.status(p);
    ui.button(p, '💾 Lưu kết quả TDM Vancomycin lên Cloud', Col.greenBtn, 8, () => {
      py('v_save', vs.json(), (r) => { ui.setStatus(sv, r.message, r.level); if (r.ok) this.loadHistory(); });
    });
    const hc = ui.card(p, 16);
    ui.header(hc, `📋 Lịch sử kết quả TDM (MSYT ${vs.msyt || '—'})`);
    this.hist = add(hc, ui.vbox());
    this.renderHistory();
    const r = ui.row(hc);
    ui.smallButton(r, '↻ Tải lại', Col.gray, () => this.loadHistory());
    ui.smallButton(r, '🗑 Xóa các dòng đã chọn', Col.red, () => this.deleteSelected());
    this.delStatus = ui.status(hc);
    if (vs.history === null && vs.msyt) this.loadHistory();
  },
  loadHistory() {
    const vs = App.vs;
    if (!vs.msyt) return;
    py('v_history', { msyt: vs.msyt }, (r) => { vs.history = r.history || []; vs.selected = new Set(); this.renderHistory(); });
  },
  renderHistory() {
    const vs = App.vs, box = this.hist;
    box.innerHTML = '';
    const h = vs.history;
    if (!Array.isArray(h) || !h.length) { ui.hint(box, 'Chưa có kết quả nào.'); return; }
    h.forEach((o, i) => {
      const d = (k, n) => (o[k] === null || o[k] === undefined) ? '--' : num(Number(o[k]), n);
      const cb = ui.check(box, `${o.date || ''} · ${o.method || ''}\nCL ${d('cl', 4)} · Vc ${d('vc', 2)} · Vp ${d('vp', 2)} · AUC24h cân bằng ${d('auc', 2)}`, vs.selected.has(i),
        (b) => { if (b) vs.selected.add(i); else vs.selected.delete(i); });
      cb.parentNode.style.whiteSpace = 'pre-line';
    });
  },
  deleteSelected() {
    const vs = App.vs, st = this.delStatus;
    const h = vs.history;
    if (!h) return;
    const rows = [...vs.selected].sort((a, b) => a - b).map((i) => h[i]);
    if (!rows.length) { ui.setStatus(st, '⚠️ Chưa chọn dòng dữ liệu nào để xóa.', 'warn'); return; }
    const dates = rows.map((o) => `  • ${o.date} (${o.method})`).join('\n');
    if (!confirm(`Bạn sắp xóa ${rows.length} lần TDM Vancomycin của bệnh nhân ${vs.msyt}:\n${dates}\n\nTiếp tục?`)) return;
    if (!confirm('⚠️ Hành động này KHÔNG THỂ HOÀN TÁC. Dữ liệu sẽ bị xóa vĩnh viễn trên Cloud.\n\nBạn có chắc chắn muốn xóa?')) return;
    py('v_delete', { msyt: vs.msyt, rows }, (r) => {
      ui.setStatus(st, r.message, r.level);
      vs.history = r.history || []; vs.selected = new Set(); this.renderHistory();
    });
  },
};

// ================================================================== Tinh lieu khang sinh (KsSteps.kt)
class KsState {
  constructor() {
    this.sex = 'Nam'; this.ageMode = 'tuoi'; this.age = ''; this.birthYear = ''; this.weight = ''; this.height = '';
    this.scr = ''; this.scrUnit = 'µmol/L'; this.preterm = false; this.drug = ''; this.phaDrug = '';
    this.meta = null; this.result = null; this.syncNote = '';
  }
  json() {
    return { sex: this.sex, age_mode: this.ageMode, age: this.age, birth_year: this.birthYear, weight: this.weight,
      height: this.height, scr: this.scr, scr_unit: this.scrUnit, preterm: this.preterm, drug: this.drug };
  }
  ageNow() {
    if (this.ageMode === 'nam_sinh') { const y = parseInt(this.birthYear.trim(), 10); return isNaN(y) ? null : new Date().getFullYear() - y; }
    return toNum(this.age);
  }
}

/** Dong bo bang lieu: doc ban sao MA HOA tren may -> ks_sync (hoi may chu co ban moi) -> luu lai neu co -> ks_meta. */
function syncKs(done) {
  Secure.load('ks_data').then((cached) => {
    py('ks_sync', { cached: cached || '' }, (s) => {
      const after = () => py('ks_meta', {}, (m) => done(m, s));
      if (s.changed && s.data) Secure.save('ks_data', s.data).then(after); else after();
    });
  });
}

const KsSteps = {
  drugBox: null, resBox: null, status: null, drugGroup: '',
  steps() { return [{ title: 'Tính liều kháng sinh', build: this.build.bind(this) }]; },
  build(p) {
    const st = App.ks || (App.ks = new KsState());
    const c = ui.card(p);
    ui.header(c, '👤 Thông tin người bệnh');
    ui.choice(c, 'Giới tính', ['Nam', 'Nữ'], st.sex, (_, v) => { st.sex = v; this.dirty(); });
    ui.choice(c, 'Nhập theo', ['Tuổi', 'Năm sinh'], st.ageMode === 'tuoi' ? 'Tuổi' : 'Năm sinh', (i) => { st.ageMode = i === 0 ? 'tuoi' : 'nam_sinh'; this.dirty(); redraw(); });
    if (st.ageMode === 'tuoi') ui.field(c, 'Tuổi (năm)', st.age, (v) => { st.age = v; this.dirty(); this.refreshDrugs(); });
    else ui.field(c, 'Năm sinh', st.birthYear, (v) => { st.birthYear = v; this.dirty(); this.refreshDrugs(); }, { hint: 'VD 1955' });
    const r1 = ui.row(c);
    ui.field(ui.cell(r1), 'Cân nặng (kg)', st.weight, (v) => { st.weight = v; this.dirty(); });
    ui.field(ui.cell(r1), 'Chiều cao (cm)', st.height, (v) => { st.height = v; this.dirty(); });
    const r2 = ui.row(c);
    ui.field(ui.cell(r2, 1.4), 'Creatinin huyết thanh (SCr)', st.scr, (v) => { st.scr = v; this.dirty(); });
    ui.choice(ui.cell(r2, 1), 'Đơn vị SCr', ['µmol/L', 'mg/dL'], st.scrUnit, (_, v) => { st.scrUnit = v; this.dirty(); });
    const c2 = ui.card(p, 10);
    ui.header(c2, '💊 Kháng sinh');
    this.drugBox = add(c2, ui.vbox());
    this.drugGroup = '';
    this.status = ui.status(p);
    ui.button(p, '🧮 TÍNH', Col.blue, 10, () => this.compute());
    this.resBox = add(p, ui.vbox());
    ui.hint(p, 'Người ≥ 18 tuổi: Cockcroft–Gault; dưới 18 tuổi: Schwartz. Công thức và chế độ liều giữ nguyên file Excel «Tính liều và CN thận» của tổ Dược lâm sàng (Globalrph, MDCalc, UpToDate, Sanford, QĐ 2671/QĐ-BYT, Dược thư QG 2022, tờ HDSD). Không lưu dữ liệu người bệnh.');
    const lookBox = add(p, ui.vbox());
    const srcBox = add(p, ui.vbox());
    if (!st.meta) syncKs((m, s) => {
      if (m.ok) { st.meta = m; st.syncNote = s.note || ''; this.refreshDrugs(); this.phaLookup(lookBox); this.source(srcBox); }
      else ui.setStatus(this.status, m.message, 'error');
    });
    else { this.refreshDrugs(); this.phaLookup(lookBox); this.source(srcBox); }
    if (st.result) this.show(st.result);
  },
  source(p) {
    const st = App.ks;
    p.innerHTML = '';
    if (!st.meta) return;
    const t = ui.hint(p, '\n📚 ' + (st.meta.source_note || '') + (st.syncNote ? '\n⚠️ ' + st.syncNote : ''));
    t.style.whiteSpace = 'pre-line';
    ui.smallButton(p, '🔄 Tải lại bảng liều', Col.gray, () => { st.meta = null; st.result = null; this.drugGroup = ''; redraw(); });
  },
  dirty() { if (App.ks) App.ks.result = null; if (this.resBox) this.resBox.innerHTML = ''; },
  refreshDrugs() {
    const st = App.ks;
    const m = st.meta;
    if (!m) return;
    const age = st.ageNow();
    const group = age === null ? '?' : age >= 18 ? 'adult' : age < 1 ? 'infant' : 'ped';
    if (group === this.drugGroup) return;
    this.drugGroup = group;
    const box = this.drugBox;
    box.innerHTML = '';
    if (group === '?') { ui.hint(box, 'Nhập tuổi hoặc năm sinh để hiện danh sách kháng sinh.'); return; }
    const list = jsonList(group === 'adult' ? m.adult_drugs : m.ped_drugs);
    if (!list.includes(st.drug)) st.drug = '';
    ui.hint(box, group === 'adult' ? `Bảng liều người lớn (${list.length} thuốc)` : `Bảng liều trẻ em (${list.length} thuốc)`);
    if (group === 'infant') ui.check(box, 'Trẻ sinh non (dưới 1 tuổi)', st.preterm, (b) => { st.preterm = b; this.dirty(); });
    const opts = ['— Chọn kháng sinh —'].concat(list);
    ui.choice(box, 'Thuốc', opts, st.drug || opts[0], (i, v) => { st.drug = i === 0 ? '' : v; this.dirty(); if (st.drug) this.compute(); });
  },
  compute() {
    const st = App.ks;
    py('ks_calc', st.json(), (r) => {
      if (!r.ok) { st.result = null; this.resBox.innerHTML = ''; ui.setStatus(this.status, r.message, r.level || 'error'); return; }
      st.result = r; this.show(r);
    });
  },
  show(r) {
    const box = this.resBox;
    box.innerHTML = '';
    const w = jsonList(r.warnings);
    ui.setStatus(this.status, w.map((x) => '⚠️ ' + x).join('\n'), w.length ? 'warn' : 'info');
    this.status.style.whiteSpace = 'pre-line';
    const c = ui.card(box, 10);
    ui.header(c, '🩺 Chức năng thận');
    ui.hint(c, (r.formula || '') + (r.age_note ? ' · ' + r.age_note : '') + ` · SCr = ${num(r.scr_umol, 2)} µmol/L`);
    if (Array.isArray(r.cards)) ui.metrics(c, r.cards.map((x) => [x[0], x[1]]));
    const d = r.dose;
    const c2 = ui.card(box, 10);
    if (!d) { ui.hint(c2, 'Chọn kháng sinh để xem chế độ liều.'); return; }
    ui.header(c2, '💊 ' + d.drug);
    ui.text(c2, d.text, 18, Col.blue, true, 6).style.whiteSpace = 'pre-line';   // v0.12.0: LD / MD tren 2 dong
    const ct = d.cach_tinh;  // v0.11.0: cach tinh cho thuoc tinh theo mg/kg
    if (ct) {
      ui.text(c2, '🧮 Cách tính', 15, Col.text, true, 10);
      [['Cân nặng tính liều', 'can_nang'], ['Mức liều', 'muc_lieu'], ['Áp dụng khi', 'crcl'], ['Khoảng đưa liều', 'khoang']]
        .forEach(([lbl, k]) => { if (ct[k]) ui.text(c2, `• ${lbl}: ${ct[k]}`, 14, Col.text, false, 3).style.whiteSpace = 'pre-line'; });
    } else if (d.dong) ui.hint(c2, 'Áp dụng dòng: ' + d.dong);
    if (d.ghi_chu) ui.text(c2, '📝 ' + d.ghi_chu, 14, Col.amber, false, 4);
    ui.text(c2, '📖 Nguồn tham khảo: ' + (d.nguon || 'Dược lâm sàng PNT'), 13, Col.muted, false, 6);
    ui.text(c2, '💧 Cách pha truyền', 15, Col.text, true, 14);
    this.phaRows(c2, d.pha_truyen);
  },
  phaRows(parent, rows) {
    if (!Array.isArray(rows) || !rows.length) { ui.hint(parent, 'Chưa có dữ liệu pha truyền cho thuốc này.'); return; }
    rows.forEach((o) => {
      ui.text(parent, '• ' + (o.lieu || ''), 14, Col.green, true, 8);
      const t = ui.text(parent, o.huong_dan || '', 14, Col.text, false, 2);
      t.style.whiteSpace = 'pre-line';
    });
  },
  phaLookup(p) {
    const st = App.ks;
    const m = st.meta;
    if (!m) return;
    const c = ui.card(p, 14);
    ui.header(c, '📋 Tra cứu cách pha truyền');
    const list = jsonList(m.pha_drugs);
    const opts = ['— Chọn thuốc —'].concat(list);
    let box;
    const load = () => py('ks_pha', { drug: st.phaDrug }, (r) => { box.innerHTML = ''; this.phaRows(box, r.rows); });
    ui.choice(c, `Thuốc (${list.length})`, opts, st.phaDrug || opts[0], (i, v) => { st.phaDrug = i === 0 ? '' : v; box.innerHTML = ''; if (st.phaDrug) load(); });
    box = add(c, ui.vbox());
    if (st.phaDrug) load();
  },
};

// ================================================================== khoi dong
$('back').addEventListener('click', back);
$('next').addEventListener('click', next);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(BASE + 'sw.js').catch(() => {});
}
if (!CFG.url || !CFG.key) {
  page('TDM Aminoglycosid', 'Lỗi cấu hình', false);
  ui.text($('body'), '❌ Bản build này chưa có địa chỉ máy chủ (thiếu config.js).', 15, Col.red);
} else showLogin();
