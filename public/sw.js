// Cachea el shell para que la vista abra aunque el campo no tenga señal. Los
// datos en vivo van por Supabase Realtime; el último estado conocido lo
// guarda live.js en localStorage.
const CACHE = 'revtrack-v3';
const SHELL = ['/', '/ring.html', '/app.css', '/live.js', '/resultados.js', '/rt.js', '/manifest.webmanifest', '/icono.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/ring.html')))
  );
});
