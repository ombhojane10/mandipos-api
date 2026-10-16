/*
 * The app shell, kept on the phone so the app opens at once — even on a weak mandi network —
 * and shows the last screens offline. Only this site's own files are cached; the API (another
 * origin) is never touched, so figures are always live.
 *  - pages: network first (a deploy shows on the next open), the cached shell if offline;
 *  - /assets/*: hashed by the build, so cached forever once fetched;
 *  - icons, manifest: served from cache, refreshed in the background.
 */
const SHELL = 'shell-v1'
const ASSETS = 'assets-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.json', '/icon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req)
        if (fresh.ok) (await caches.open(SHELL)).put('/', fresh.clone())
        return fresh
      } catch {
        return (await caches.match('/')) ?? Response.error()
      }
    })())
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      const fresh = await fetch(req)
      if (fresh.ok) (await caches.open(ASSETS)).put(req, fresh.clone())
      return fresh
    })())
    return
  }

  e.respondWith((async () => {
    const hit = await caches.match(req)
    const update = fetch(req).then(async (fresh) => {
      if (fresh.ok) (await caches.open(SHELL)).put(req, fresh.clone())
      return fresh
    }).catch(() => hit)
    return hit ?? update
  })())
})
