// ui.js -- Bo cong cu giao dien (giong Ui.kt cua app Android) bang HTML thuan, khong thu vien ngoai.
'use strict';

const Col = {
  text: '#1F2328', muted: '#59636E', bg: '#F6F8FA', card: '#FFFFFF', border: '#D1D9E0', blue: '#0969DA',
  green: '#1A7F37', greenBtn: '#2F6F4F', red: '#D1242F', amber: '#9A6700', purple: '#8250DF', gray: '#6E7781',
};

// ---------------------------------------------------------------- ngay gio (chuoi 'yyyy-MM-dd HH:mm' giong app)
const pad = (n) => String(n).padStart(2, '0');
function fmtIso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowHourIso() { const d = new Date(); d.setMinutes(0, 0, 0); return fmtIso(d); }
function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec((s || '').trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
function isoPlusHours(s, h) { const d = parseIso(s); return d ? fmtIso(new Date(d.getTime() + h * 3600000)) : s; }
function showIso(s) { const d = parseIso(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s; }

// ---------------------------------------------------------------- so
function num(x, d) { return (x === null || x === undefined || typeof x !== 'number' || isNaN(x)) ? '--' : x.toFixed(d); }
function g(x) {
  if (typeof x !== 'number' || isNaN(x)) return '--';
  if (x === Math.round(x) && Math.abs(x) < 1e15) return String(Math.round(x));
  return String(Number(x.toPrecision(6)));
}
function optNum(o, k, d) { return (!o || o[k] === null || o[k] === undefined) ? '--' : num(Number(o[k]), d); }
function optStr(o, k, def = '') {
  if (!o || o[k] === null || o[k] === undefined) return def;
  return typeof o[k] === 'number' ? g(o[k]) : String(o[k]);
}
const toNum = (s) => { const v = parseFloat(String(s).replace(',', '.')); return isNaN(v) ? null : v; };

// ---------------------------------------------------------------- phan tu
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function add(parent, child) { parent.appendChild(child); return child; }

const ui = {
  vbox() { return el('div', 'vbox'); },
  card(parent, top = 8) { const c = add(parent, el('div', 'card')); c.style.marginTop = top + 'px'; return c; },
  text(parent, s, size = 15, color = Col.text, bold = false, top = 4) {
    const t = add(parent, el('div', 'txt', s));
    t.style.fontSize = size + 'px'; t.style.color = color; t.style.marginTop = top + 'px';
    if (bold) t.style.fontWeight = '700';
    return t;
  },
  header(parent, s) { const t = ui.text(parent, s, 17, Col.text, true, 14); t.style.marginBottom = '4px'; return t; },
  hint(parent, s) { const t = ui.text(parent, s, 13, Col.muted, false, 2); t.style.marginBottom = '4px'; return t; },
  levelColor(level, msg = '') {
    if (level === 'error') return Col.red;
    if (level === 'warn' || level === 'warning') return Col.amber;
    return String(msg).startsWith('✅') ? Col.green : Col.muted;
  },
  status(parent) { const t = ui.text(parent, '', 14, Col.muted, false, 6); t.style.display = 'none'; return t; },
  setStatus(t, msg, level = 'info') {
    t.textContent = msg || ''; t.style.color = ui.levelColor(level, msg || '');
    t.style.display = (msg && String(msg).trim()) ? '' : 'none';
  },
  label(parent, label) { if (label) { const l = ui.text(parent, label, 13, Col.muted, false, 8); l.classList.add('lbl'); } },
  field(parent, label, value, onChange, opt = {}) {
    ui.label(parent, label);
    const e = add(parent, el('input', 'inp'));
    e.type = 'text'; e.value = value ?? '';
    if (opt.numeric !== false) { e.inputMode = 'decimal'; }
    if (opt.hint) e.placeholder = opt.hint;
    if (opt.password) e.type = 'password';
    e.autocapitalize = 'off'; e.autocomplete = opt.autocomplete || 'off'; e.spellcheck = false;
    e.addEventListener('input', () => onChange(e.value));
    return e;
  },
  area(parent, label, value, lines, onChange) {
    ui.label(parent, label);
    const e = add(parent, el('textarea', 'inp'));
    e.rows = lines; e.value = value ?? ''; e.spellcheck = false;
    e.addEventListener('input', () => onChange(e.value));
    return e;
  },
  row(parent) { return add(parent, el('div', 'row')); },
  cell(row, weight = 1) { const c = add(row, el('div', 'cell')); c.style.flex = String(weight); return c; },
  choice(parent, label, options, selected, onChange) {
    ui.label(parent, label);
    const s = add(parent, el('select', 'inp'));
    options.forEach((o, i) => { const op = el('option', null, o); op.value = String(i); s.appendChild(op); });
    const idx = options.indexOf(selected);
    s.value = String(idx >= 0 ? idx : 0);
    s.addEventListener('change', () => { const i = +s.value; onChange(i, options[i]); });
    return s;
  },
  check(parent, label, checked, onChange) {
    const l = add(parent, el('label', 'chk'));
    const c = add(l, el('input')); c.type = 'checkbox'; c.checked = !!checked;
    add(l, el('span', null, label));
    c.addEventListener('change', () => onChange(c.checked));
    return c;
  },
  button(parent, label, color = Col.blue, top = 8, onClick = () => {}) {
    const b = add(parent, el('button', 'btn', label));
    b.style.background = color; b.style.marginTop = top + 'px';
    b.addEventListener('click', (ev) => { ev.preventDefault(); onClick(); });
    return b;
  },
  smallButton(parent, label, color = Col.gray, onClick = () => {}) {
    const b = add(parent, el('button', 'sbtn', label));
    b.style.background = color;
    b.addEventListener('click', (ev) => { ev.preventDefault(); onClick(); });
    return b;
  },
  /** O chon ngay gio. Gia tri luu dang 'yyyy-MM-dd HH:mm'. allowEmpty -> co nut xoa. */
  dateTime(parent, label, value, onChange, allowEmpty = false) {
    ui.label(parent, label);
    const r = add(parent, el('div', 'dtrow'));
    const e = add(r, el('input', 'inp'));
    e.type = 'datetime-local';
    e.value = value ? value.replace(' ', 'T').slice(0, 16) : '';
    e.addEventListener('change', () => onChange(e.value ? e.value.replace('T', ' ').slice(0, 16) : ''));
    if (allowEmpty) {
      const x = add(r, el('button', 'sbtn', '✖'));
      x.style.background = Col.gray;
      x.title = 'Xóa';
      x.addEventListener('click', (ev) => { ev.preventDefault(); e.value = ''; onChange(''); });
    }
    return e;
  },
  metrics(parent, items) {
    const grid = add(parent, el('div', 'metrics'));
    items.forEach(([title, value]) => {
      const c = add(grid, el('div', 'metric'));
      add(c, el('div', 'mt', title));
      add(c, el('div', 'mv', value));
    });
    return grid;
  },
  divider(parent) { return add(parent, el('div', 'divider')); },
};

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
