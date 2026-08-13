// SERVICE WORKER KILL SWITCH. This file exists only to remove itself.
//
// Spec: docs/modules/no-cache.md
//
// It used to cache the app shell. Peter, 2026-08-13: "we should be browser cache
// free ... NOTHING is cached." A service worker IS a cache — no-store response
// headers do not restrain Cache Storage, so leaving this in place while claiming
// the app is cache-free would have been false.
//
// WHY THIS FILE STILL EXISTS RATHER THAN BEING DELETED. Removing the
// register() call from index.html stops NEW installs; it does nothing about the
// browsers that already have this worker and will keep running it forever. A
// browser re-fetches /sw.js on navigation within scope, so shipping a worker
// that destroys itself is the only route that reaches them. Delete this file and
// every existing install survives, serving month-old assets.
//
// There is deliberately NO fetch handler: while winding down it must intercept
// nothing.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Every cache, not just this app's — the shell was stored under a versioned
    // key ('mesh-gw-dash-v4') and older deployments left their own behind.
    for (const key of await caches.keys()) await caches.delete(key);

    await self.registration.unregister();
    await self.clients.claim();

    // Controlled tabs are still holding a dead worker's page. Reload them so the
    // user lands on a genuinely uncached document rather than whatever the
    // worker last served. Without this the fix is invisible until they navigate.
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url).catch(() => {});
    }
  })());
});
