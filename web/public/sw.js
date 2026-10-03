// Cachea la app para que la vista abra aunque el campo no tenga señal. Los
// datos en vivo van por Supabase Realtime; el último estado conocido lo guarda
// la propia vista en localStorage.
//
// Con Vite los archivos de la app llevan un hash en el nombre y cambian en
// cada deploy, así que no hay una lista fija que precargar: se guarda lo que se
// va pidiendo (red primero, caché si no hay red) y, para cualquier ruta de la
// SPA sin red, se devuelve el index.html cacheado.
const CACHE = 'revtrack-v4';
const SHELL = ['/', '/manifest.webmanifest', '/icono.svg'];

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
      .catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
