// chart.js -- Do thi nong do (giong ChartView.kt): duong C(t), diem Cobs, duong muc tieu. Ve bang canvas.
// v0.15.1: > 3 ngay -> cham de doi «Toan bo» / «3 ngay cuoi»; nhan truc x theo ngay khi > 48 gio.
'use strict';

function niceStep(range, target) {
  if (range <= 0) return 1;
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return p * (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10);
}

function drawChart(parent, chart, color) {
  const wrap = add(parent, el('div', 'chart'));
  const cv = add(wrap, el('canvas'));
  let lastDays = false;
  const render = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth || 320, H = Math.round(W * 0.68);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const xs = chart.x || [], ys = chart.y || [], px = chart.px || [], pyv = chart.py || [];
    if (!xs.length) return;
    let xmin = Math.min(...xs), xmax = Math.max(...xs);
    if (px.length) { xmin = Math.min(xmin, ...px); xmax = Math.max(xmax, ...px); }
    const zoomable = xmax - xmin > 72;
    cv.style.cursor = zoomable ? 'pointer' : '';
    const left = 40, right = W - 10, top = zoomable ? 26 : 12, bottom = H - 34;
    if (zoomable && lastDays) xmin = xmax - 72;
    let ymax = 0;
    xs.forEach((x, i) => { if (x >= xmin) ymax = Math.max(ymax, ys[i]); });
    px.forEach((x, i) => { if (x >= xmin) ymax = Math.max(ymax, pyv[i]); });
    (chart.hlines || []).forEach((h) => { ymax = Math.max(ymax, h.y); });
    ymax *= 1.08; if (ymax <= 0) ymax = 1;
    if (xmax <= xmin) xmax = xmin + 1;
    const sx = (x) => left + (x - xmin) / (xmax - xmin) * (right - left);
    const sy = (y) => bottom - y / ymax * (bottom - top);
    c.font = '10.5px -apple-system, system-ui, sans-serif';
    c.lineWidth = 1;
    // luoi + truc y
    const ys0 = niceStep(ymax, 5);
    for (let yv = 0; yv <= ymax; yv += ys0) {
      c.strokeStyle = '#EEF1F4'; c.beginPath(); c.moveTo(left, sy(yv)); c.lineTo(right, sy(yv)); c.stroke();
      c.fillStyle = Col.muted; c.fillText(g(Math.round(yv * 100) / 100), 2, sy(yv) + 4);
    }
    // truc x
    const t0 = chart.t0 ? parseIso(chart.t0) : null;
    const tick = (xv, txt) => {
      c.strokeStyle = '#EEF1F4'; c.beginPath(); c.moveTo(sx(xv), top); c.lineTo(sx(xv), bottom); c.stroke();
      const w = c.measureText(txt).width;
      c.fillStyle = Col.muted;
      c.fillText(txt, Math.min(Math.max(sx(xv) - w / 2, left - 6), right - w), bottom + 14);
    };
    if (t0 && xmax - xmin > 48) {
      // moc 0h moi ngay (hoac moi 2-3 ngay neu dai), nhan dd/MM
      const offH = t0.getHours() + t0.getMinutes() / 60;
      const step = 24 * Math.max(1, Math.ceil((xmax - xmin) / 24 / 7));
      for (let xv = Math.ceil((xmin + offH) / step) * step - offH; xv <= xmax + 1e-9; xv += step) {
        const d = new Date(t0.getTime() + xv * 3600000);
        tick(xv, `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`);
      }
    } else {
      const xs0 = niceStep(xmax - xmin, 4);
      for (let xv = Math.ceil(xmin / xs0) * xs0; xv <= xmax + 1e-9; xv += xs0) {
        let txt;
        if (t0) { const d = new Date(t0.getTime() + xv * 3600000); txt = `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h`; }
        else txt = g(Math.round(xv * 10) / 10);
        tick(xv, txt);
      }
    }
    if (zoomable) {
      const tip = lastDays ? '3 ngày cuối · chạm để xem toàn bộ' : 'Toàn bộ · chạm để xem 3 ngày cuối';
      c.fillStyle = color; c.fillText(tip, right - c.measureText(tip).width, 14);
    }
    c.fillStyle = Col.muted;
    if (chart.x_label) { c.fillText(chart.x_label, right - c.measureText(chart.x_label).width, bottom + 28); }
    c.strokeStyle = Col.border; c.beginPath(); c.moveTo(left, bottom); c.lineTo(right, bottom); c.moveTo(left, top); c.lineTo(left, bottom); c.stroke();
    // duong muc tieu
    (chart.hlines || []).forEach((h) => {
      const colr = h.color === 'green' ? Col.green : '#BC4C00';
      c.strokeStyle = colr; c.lineWidth = 1.6; c.setLineDash([8, 6]);
      c.beginPath(); c.moveTo(left, sy(h.y)); c.lineTo(right, sy(h.y)); c.stroke();
      c.setLineDash([]); c.lineWidth = 1;
      c.fillStyle = colr; c.fillText(`${h.label || ''} (${g(h.y)})`, left + 4, sy(h.y) - 3);
    });
    // duong nong do (cat theo khung khi xem 3 ngay cuoi)
    c.save(); c.beginPath(); c.rect(left, 0, right - left + 6, bottom); c.clip();
    c.strokeStyle = color; c.lineWidth = 2.2; c.beginPath();
    xs.forEach((x, i) => { if (i === 0) c.moveTo(sx(x), sy(ys[i])); else c.lineTo(sx(x), sy(ys[i])); });
    c.stroke();
    c.fillStyle = Col.red;
    px.forEach((x, i) => { if (x >= xmin) { c.beginPath(); c.arc(sx(x), sy(pyv[i]), 4.5, 0, Math.PI * 2); c.fill(); } });
    c.restore();
  };
  cv.addEventListener('click', () => { lastDays = !lastDays; render(); });
  requestAnimationFrame(render);
  window.addEventListener('resize', render);
  return wrap;
}
