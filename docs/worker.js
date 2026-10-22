// worker.js -- Bo tinh Python cua app (cung cac file voi app Android) chay trong Web Worker bang Pyodide.
// Giao dien (app.js) gui {id, cmd, ...} -> worker tra {id, ok, result | error}. Python chay o day nen man hinh khong bi dung.
// Pyodide 0.27.7 = Python 3.12 -> goi .pyc phai bien dich bang Python 3.12 (tools/pwa_build.py kiem tra).
'use strict';
const PYODIDE_VERSION = '0.27.7';
let py = null;              // doi tuong Pyodide
let heavyLoaded = false;    // numpy + scipy da nap chua (chi can cho Tab 1 / Tab 4)
let progress = (m) => postMessage({ progress: m });

async function loadRuntime(base) {
  if (py) return;
  progress('Đang khởi động Python…');
  importScripts(base + 'pyodide/pyodide.js');
  py = await loadPyodide({ indexURL: base + 'pyodide/' });
}

async function loadHeavy() {
  if (heavyLoaded) return;
  progress('Đang nạp numpy + scipy (lần đầu tải khoảng 18 MB)…');
  await py.loadPackage(['numpy', 'scipy']);
  heavyLoaded = true;
}

// Cai goi bo tinh (zip da giai ma) vao /engine
function installEngine(zipBytes) {
  py.FS.writeFile('/tmp/engine.zip', zipBytes);
  py.runPython(`
import sys, zipfile, shutil, os, importlib
if os.path.isdir('/engine'):
    shutil.rmtree('/engine')
os.makedirs('/engine')
zipfile.ZipFile('/tmp/engine.zip').extractall('/engine')
os.remove('/tmp/engine.zip')
for m in [k for k in list(sys.modules) if k.split('.')[0] in ('mobile_api', 'mobile_db', 'mobile_vanco', 'mobile_lieu_ks',
          'ks_engine', 'lieu_ks_rules', 'xl_runtime', 'pk_calculations', 'amg_bayesian_calculations', 'vanco_calculations',
          'tucuxi_engine', 'pwa_glue')]:
    del sys.modules[m]
if '/engine' not in sys.path:
    sys.path.insert(0, '/engine')
importlib.invalidate_caches()
`);
}

// Lop "transport" cho mobile_db.py: XMLHttpRequest DONG BO (chi duoc phep trong Worker) -- giong lop Http.kt cua Android.
const GLUE = `
import json, sys
import mobile_db
from js import XMLHttpRequest

def _transport(method, url, headers, body):
    x = XMLHttpRequest.new()
    x.open(method, url, False)
    for k, v in headers.items():
        x.setRequestHeader(k, v)
    try:
        x.send(body)
    except Exception:
        return 0, "mất kết nối mạng"
    return int(x.status), str(x.responseText)

def pwa_setup(url, key, token, user, pw, role):
    mobile_db.configure(url, key, _transport)
    mobile_db._SESSION.update(token=token, u=user, p=pw, gateway=bool(token), role=role or "")

def pwa_logout():
    mobile_db.logout()

def pwa_call(fn, req):
    # Giong Py.kt: ham "v_" / run_vanco_demo -> mobile_vanco; "ks_" -> mobile_lieu_ks; con lai -> mobile_api
    if fn.startswith("v_") or fn == "run_vanco_demo":
        import mobile_vanco as m
    elif fn.startswith("ks_"):
        import mobile_lieu_ks as m
    elif fn.startswith("cl_"):
        import mobile_chuoi_lieu as m
    else:
        import mobile_api as m
    f = getattr(m, fn)
    return f() if fn in ("run_demo_case", "run_vanco_demo") else f(req)
`;

async function handle(msg) {
  switch (msg.cmd) {
    case 'init':
      await loadRuntime(msg.base);
      return { python: py.runPython('import sys; sys.version.split()[0]') };
    case 'engine':
      installEngine(msg.zip);
      py.runPython(GLUE);
      py.globals.get('pwa_setup')(msg.url, msg.key, msg.token, msg.user, msg.pw, msg.role);
      return { installed: true };
    case 'ks_engine':          // v0.12.0: goi tinh lieu KS (chua dang nhap) -- khong ma phien
      installEngine(msg.zip);
      py.runPython(GLUE);
      py.globals.get('pwa_setup')(msg.url, msg.key, null, null, null, '');
      return { installed: true };
    case 'heavy':
      await loadHeavy();
      return { heavy: true };
    case 'call': {
      // Tab 1 / Tab 4 (mobile_api, mobile_vanco) can numpy + scipy; Tinh lieu KS thi khong
      if (!msg.fn.startsWith('ks_') && !msg.fn.startsWith('cl_')) await loadHeavy();
      const out = py.globals.get('pwa_call')(msg.fn, msg.req || '{}');
      return JSON.parse(String(out));
    }
    case 'logout':
      try { py.globals.get('pwa_logout')(); } catch (e) { /* bo qua */ }
      return { ok: true };
    default:
      throw new Error('Lệnh không hợp lệ: ' + msg.cmd);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const result = await handle(msg);
    postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    postMessage({ id: msg.id, ok: false, error: String(err && err.message || err).slice(-1500) });
  }
};
