// Buckets offline copy. Keeps the game saved on the iPad so it still opens if the website is slow,
// offline, or a filter starts blocking the page. Online play still needs the game server to be reachable.
//  - the game page: always loaded fresh from the internet first (so updates show up right away); the saved
//    copy is only used when the site can't load or a filter answers with its own block page
//  - game files (scripts, icons): same idea
//  - control.json (admin emergency switch): always tries the network first
const CACHE = 'buckets-v2';
const CORE = ['./', 'index.html', 'peerjs.min.js', 'nostr.bundle.js', 'firebase-app-compat.js', 'firebase-database-compat.js', 'firebase-config.txt', 'icon-192.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => fetch(u, { cache: 'no-store' }).then(r => { if (r.ok) return c.put(u, r); }).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// is this really our game (and not a filter's block page)?
async function realGame(res) {
  if (!res || !res.ok) return false;
  const t = await res.clone().text();
  return t.includes('<title>Buckets</title>') && t.includes('@@SIM-BEGIN');
}
async function refreshPage(cache) {
  try {
    const res = await fetch('index.html', { cache: 'no-store' });
    if (!(await realGame(res))) return;
    const old = await cache.match('index.html'), oldT = old ? await old.text() : '', neu = await res.clone().text();
    await cache.put('index.html', res.clone()); await cache.put('./', res);
    if (oldT && oldT !== neu) for (const c of await self.clients.matchAll()) c.postMessage({ t: 'bk-updated' });
  } catch (e) {}
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  const same = url.origin === self.location.origin;
  // the game page
  if (req.mode === 'navigate' || (same && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([fetch(req.url, { cache: 'no-store' }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 6000))]);
        if (await realGame(res)) { cache.put('index.html', res.clone()); return res; }
      } catch (err) {}
      const hit = await cache.match('index.html'); if (hit) return hit;
      try { return await fetch(req); } catch (err) { return new Response("Buckets can't load right now. Check your Wi-Fi.", { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
    })());
    return;
  }
  // admin emergency switch: network first
  if (same && url.pathname.endsWith('control.json')) {
    e.respondWith(fetch(req).catch(() => caches.match(req).then(r => r || new Response('{}', { headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // our own files + Google Fonts: saved copy first, refreshed in the background (never with an HTML block page)
  if (same || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE), hit = await cache.match(req);
      const net = fetch(req).then(res => { const ct = res.headers.get('content-type') || ''; if ((res.ok || res.type === 'opaque') && !(same && ct.includes('text/html'))) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response('', { status: 504 });
    })());
  }
});
