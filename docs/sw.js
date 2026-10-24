// sw.js -- Service Worker: luu san giao dien + Python (Pyodide) de mo nhanh va dung duoc khi mat mang.
// * Giao dien + manifest bo tinh: lay MANG TRUOC (luon nhan ban moi nhat), mat mang -> dung ban da luu.
// * Pyodide (ten file co so phien ban) + goi bo tinh (engine-<phien ban>.bin): lay BO NHO TRUOC.
// 20261024-7f43af4d-bbb3ed duoc tools/pwa_build.py thay bang ma phien ban -> moi lan dang ban moi, cache cu duoc don.
const BUILD = '20261024-7f43af4d-bbb3ed';
const SHELL = 'tdm-shell-' + BUILD;
const BIG = 'tdm-big-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tdm-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;     // Supabase, ... -> khong can thiep
  const big = url.pathname.includes('/pyodide/') || /\/engine\/(engine-[^/]+\.bin|ks-[^/]+\.zip)$/.test(url.pathname);
  if (big) {
    e.respondWith((async () => {
      const c = await caches.open(BIG);
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) {
        if (url.pathname.includes('/engine/')) {            // chi giu goi bo tinh moi nhat
          const pre = url.pathname.includes('/engine/ks-') ? '/engine/ks-' : '/engine/engine-';
          for (const k of await c.keys()) if (k.url.includes(pre)) await c.delete(k);
        }
        c.put(e.request, r.clone());
      }
      return r;
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
