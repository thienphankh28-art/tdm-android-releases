// Cập nhật: 28/11/2026 — v0.26.0 (giống DoseHint.kt và Tab 4 V28.11.26d trên máy tính)
// Cập nhật: 28/11/2026 20:50 — v0.26.1: chế độ tự nhập làm mờ ô AUC/khoảng cách/làm tròn/liều nạp (giống desktop); nhãn liều nạp ngắn
// «💡 Gợi ý liều khởi đầu»: SCr/urê LÚC BẮT ĐẦU dùng vancomycin. Hai chế độ: gợi ý theo AUC đích / tự nhập liều
// -> ước tính AUC từng mô hình. Tính toán do Python (mobile_vanco.v_dose_hint) -> cùng kết quả với bản máy tính.
// Dùng các hàm chung của ui.js / app.js: ui, Col, g, el, add, openModal, py.
function doseHint(vs) {
  const ORANGE = '#BC4C00';
  const TAU_A = [['Theo eCrCl (PNT)', 'ecrcl'], ['Theo t½ từng mô hình', 'thalf'], ['q8h', '8'], ['q12h', '12'], ['q24h', '24'], ['q48h', '48']];
  const TAU_C = [['q6h', '6'], ['q8h', '8'], ['q12h', '12'], ['Theo t½ từng mô hình', 'thalf']];
  const RND_A = [['250 mg', '250'], ['125 mg', '125'], ['500 mg', '500']];
  const RND_C = [['10 mg', '10'], ['25 mg', '25'], ['50 mg', '50']];
  const LD_A = [['25 mg/kg (≤ 3 g)', '25'], ['20 mg/kg (≤ 3 g)', '20'], ['30 mg/kg (≤ 3 g)', '30'],
    ['35 mg/kg (≤ 3 g)', '35'], ['Không liều nạp', '0']];
  const LD_C = [['Không liều nạp', '0'], ['20 mg/kg (≤ 3 g)', '20']];
  const opts = (a, c) => (vs.child ? c : a);
  const pick = (o, cur) => (o.some((x) => x[0] === cur) ? cur : o[0][0]);
  const code = (o, cur) => o.find((x) => x[0] === pick(o, cur))[1];
  const f = (x, d = 0) => (typeof x !== 'number' || isNaN(x) ? '--' : x.toFixed(d).replace('.', ','));
  const h = (x) => g(Math.round(x * 100) / 100).replace('.', ',');
  const tinfOf = (dose) => (dose > 0 ? Math.max(1, Math.ceil(dose / 1000 - 1e-9)) : 0);
  let lastTb = null, res = null;
  const m = openModal('💡 Gợi ý liều khởi đầu', [{ label: '✖ Đóng', color: Col.gray, onClick: (close) => close() }]);
  m.body.parentNode.classList.add('full');
  const body = m.body;
  const msgBox = (s, ok) => {
    const t = ui.text(res, s, 14, ok ? Col.green : Col.amber, false, 8);
    t.style.background = ok ? '#DAFBE1' : '#FFF8C5'; t.style.borderRadius = '8px'; t.style.padding = '8px 10px';
  };
  const kv = (p, k, v, color) => { ui.text(p, k, 12, Col.muted, false, 4); ui.text(p, v, 16, color, true, 0); };
  const aucColor = (x) => (typeof x !== 'number' || isNaN(x) ? Col.text : (x >= 400 && x <= 600 ? Col.green : Col.red));
  const card = (o, custom, child) => {
    const c = ui.card(res, 8);
    if (o.tb) c.style.border = '2px solid ' + (custom ? ORANGE : Col.green);
    const t = ui.text(c, '', 15, o.tb ? (custom ? ORANGE : Col.green) : Col.text, false, 0);
    add(t, el('b', null, o.label));
    const sm = add(t, el('span', null, ` · CL ${f(o.cl, 2)} L/h · V ${f(o.v, 0)} L · t½ ${f(o.t_half, 1)} h`));
    sm.style.fontSize = '12px'; sm.style.color = Col.muted;
    const ldTi = o.ld_tinf != null ? o.ld_tinf : tinfOf(o.ld);
    let line = (o.ld > 0 ? `Nạp ${g(o.ld)} mg (${h(ldTi)} h) → ` : '') + `${g(o.md)} mg q${g(o.tau)}h (${h(o.tinf)} h)`;
    if (child) line += ` · ${f(o.mgkg_day, 0)} mg/kg/ngày`;
    ui.text(c, line, 16, Col.text, true, 4);
    const r3 = ui.row(c);
    kv(ui.cell(r3), 'AUC24 ổn định', f(o.auc_ss), custom ? aucColor(o.auc_ss) : Col.text);
    kv(ui.cell(r3), 'AUC ngày 1', f(o.auc_day1), custom ? aucColor(o.auc_day1) : Col.text);
    kv(ui.cell(r3), 'Đáy / đỉnh', `${f(o.trough, 1)} / ${f(o.peak, 1)}`, Col.text);
  };
  const show = (r) => {
    res.innerHTML = '';
    if (!r.ok) { msgBox(r.message || 'Không tính được.', false); return; }
    ui.hint(res, r.info || '');
    const rows = r.rows || [];
    lastTb = rows.find((x) => x.tb) || rows[0] || null;
    rows.filter((x) => x.tb).concat(rows.filter((x) => !x.tb)).forEach((o) => card(o, r.custom, r.child));
    (r.msgs || []).forEach((o) => msgBox(o.text, o.ok));
  };
  const calc = () => {
    res.innerHTML = ''; ui.hint(res, 'Đang tính…');
    const req = Object.assign(vs.json(), {
      dh_auc: vs.dhAuc, dh_tau: code(opts(TAU_A, TAU_C), vs.dhTau), dh_round: code(opts(RND_A, RND_C), vs.dhRound),
      dh_ld_mgkg: code(opts(LD_A, LD_C), vs.dhLd),
      dh_custom: vs.dhCustom ? { ld: vs.cLd, ld_ti: vs.cLdTi, md: vs.cMd, md_ti: vs.cMdTi, tau: vs.cTau } : null });
    py('v_dose_hint', req, show);
  };
  const build = () => {
    body.innerHTML = '';
    const c = ui.card(body, 6);
    const r1 = ui.row(c);
    const e1 = ui.field(ui.cell(r1), 'AUC24 đích (mg·h/L)', vs.dhAuc, (v) => { vs.dhAuc = v; });
    const to = opts(TAU_A, TAU_C);
    const s1 = ui.choice(ui.cell(r1, 1.4), 'Khoảng cách', to.map((x) => x[0]), pick(to, vs.dhTau), (_, v) => { vs.dhTau = v; calc(); });
    const r2 = ui.row(c);
    const ro = opts(RND_A, RND_C);
    const s2 = ui.choice(ui.cell(r2), 'Làm tròn', ro.map((x) => x[0]), pick(ro, vs.dhRound), (_, v) => { vs.dhRound = v; calc(); });
    const lo = opts(LD_A, LD_C);
    const s3 = ui.choice(ui.cell(r2, 1.6), 'Liều nạp', lo.map((x) => x[0]), pick(lo, vs.dhLd), (_, v) => { vs.dhLd = v; calc(); });
    // v0.26.1: chế độ tự nhập -> làm mờ các ô của phần gợi ý (giống desktop)
    [e1, s1, s2, s3].forEach((w) => { w.disabled = vs.dhCustom; w.style.opacity = vs.dhCustom ? '0.45' : ''; });
    const seg = ui.row(c);
    ui.button(ui.cell(seg), 'Gợi ý theo AUC', vs.dhCustom ? Col.gray : Col.greenBtn, 8, () => {
      if (vs.dhCustom) { vs.dhCustom = false; build(); calc(); }
    });
    ui.button(ui.cell(seg), '✍ Tự nhập liều', vs.dhCustom ? ORANGE : Col.gray, 8, () => {
      if (vs.dhCustom) return;
      vs.dhCustom = true;
      if (lastTb && !String(vs.cMd).trim()) {      // điền sẵn theo chế độ TB 3 mô hình đang gợi ý
        vs.cLd = g(lastTb.ld || 0); vs.cLdTi = g(lastTb.ld_tinf != null ? lastTb.ld_tinf : tinfOf(lastTb.ld || 0));
        vs.cMd = g(lastTb.md || 0); vs.cMdTi = g(lastTb.tinf || 1); vs.cTau = g(lastTb.tau || 12);
      }
      build(); calc();
    });
    if (vs.dhCustom) {
      const cc = ui.card(body, 6);
      ui.text(cc, '✍ Chế độ liều tự nhập', 15, ORANGE, true, 0);
      const a1 = ui.row(cc);
      ui.field(ui.cell(a1, 1.4), 'Liều nạp (mg)', vs.cLd, (v) => { vs.cLd = v; }, { hint: '0 = không' });
      ui.field(ui.cell(a1), 'Tinf (h)', vs.cLdTi, (v) => { vs.cLdTi = v; });
      const a2 = ui.row(cc);
      ui.field(ui.cell(a2, 1.4), 'Duy trì (mg)', vs.cMd, (v) => { vs.cMd = v; });
      ui.field(ui.cell(a2), 'Tinf (h)', vs.cMdTi, (v) => { vs.cMdTi = v; });
      ui.field(ui.cell(a2), 'mỗi (h)', vs.cTau, (v) => { vs.cTau = v; });
      ui.button(cc, 'Tính AUC', ORANGE, 10, calc);
    } else {
      ui.button(c, 'Tính lại', Col.blue, 8, calc);
    }
    res = add(body, el('div', 'vbox'));
  };
  build(); calc();
}
