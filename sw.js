/**
 * SafeShores - Service Worker
 * ============================
 * Enables offline support and PWA install capability.
 * Modeled on the CliffWatch service worker architecture.
 *
 * Caching Strategy:
 * -----------------
 * - Network-first for HTML pages (ensures users get the latest version)
 * - Cache-first for static assets like CSS, JS, and images (performance)
 * - Network-only for ArcGIS API requests (real-time data must be fresh)
 *
 * Version Notes:
 * - Increment CACHE_NAME when deploying updates so the activate event
 *   automatically clears the old cache and serves fresh assets.
 */

// ================================================================
// CACHE CONFIGURATION
// ================================================================
// Change the version number when you deploy updates.
// The activate handler will purge any cache whose name doesn't match.
const CACHE_NAME = 'safeshores-v1';

// Static assets to pre-cache during install.
// These are loaded on first visit so the app works offline.
const STATIC_ASSETS = [
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    // ArcGIS JS API (light theme — SafeShores uses the light Esri theme)
    'https://js.arcgis.com/4.28/esri/themes/light/main.css',
    'https://js.arcgis.com/4.28/'
];


// ================================================================
// INSTALL EVENT
// ================================================================
// Fires when the browser first registers this service worker.
// We open our named cache and pre-fetch the static assets listed above.
// skipWaiting() forces the new SW to take over immediately (no reload).
self.addEventListener('install', (event) => {
    console.log('[SW] Installing SafeShores service worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Pre-caching static assets');
                // Use allSettled so a single 404 doesn't break the entire install
                return Promise.allSettled(
                    STATIC_ASSETS.map(url =>
                        cache.add(url).catch(err =>
                            console.log('[SW] Failed to cache:', url, err)
                        )
                    )
                );
            })
            .then(() => self.skipWaiting())
    );
});


// ================================================================
// ACTIVATE EVENT
// ================================================================
// Fires after install (or when a new version takes over).
// We delete any caches that don't match CACHE_NAME so old assets
// don't linger. clients.claim() ensures all open tabs use this SW.
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating SafeShores service worker...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Removing old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});


// ================================================================
// FETCH EVENT
// ================================================================
// Intercepts every network request and applies the appropriate
// caching strategy based on the request type:
//
//   1. ArcGIS API requests → NETWORK ONLY (real-time data)
//   2. HTML pages → NETWORK FIRST (fresh content, offline fallback)
//   3. Everything else → CACHE FIRST (performance for CSS/JS/images)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests (POST, PUT, etc. should go straight to network)
    if (event.request.method !== 'GET') return;

    // ----- NETWORK ONLY: ArcGIS feature layer / API requests -----
    // These are real-time queries (beach status, user reports) that must
    // always be fresh. Let the browser handle them without caching.
    if (event.request.url.includes('arcgis.com') ||
        event.request.url.includes('services.arcgis.com') ||
        event.request.url.includes('services3.arcgis.com')) {
        return; // Don't intercept — let the browser fetch normally
    }

    // ----- NETWORK FIRST: HTML pages -----
    // Try the network so users get the latest version. If offline,
    // fall back to the cached version.
    if (event.request.headers.get('accept')?.includes('text/html') ||
        url.pathname === '/' ||
        url.pathname.endsWith('.html')) {
        event.respondWith(networkFirstStrategy(event.request));
        return;
    }

    // ----- CACHE FIRST: Static assets (CSS, JS, images, fonts) -----
    // Serve from cache for speed; fetch from network only on cache miss.
    event.respondWith(cacheFirstStrategy(event.request));
});


// ================================================================
// NETWORK-FIRST STRATEGY
// ================================================================
// 1. Try to fetch from the network.
// 2. If successful, cache the response for future offline use.
// 3. If the network fails (offline), serve the cached version.
// 4. If nothing is cached either, try to serve /index.html as a fallback.
async function networkFirstStrategy(request) {
    try {
        const networkResponse = await fetch(request);

        // Cache successful responses for offline fallback
        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }

        return networkResponse;
    } catch (error) {
        // Network failed — try the cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            console.log('[SW] Serving HTML from cache (offline)');
            return cachedResponse;
        }

        // Last resort: serve cached index.html (SPA fallback)
        const fallback = await caches.match('/index.html');
        if (fallback) {
            return fallback;
        }

        throw error;
    }
}


// ================================================================
// CACHE-FIRST STRATEGY
// ================================================================
// 1. Check the cache first (fast).
// 2. If not cached, fetch from network and cache the result.
async function cacheFirstStrategy(request) {
    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
        return cachedResponse;
    }

    try {
        const networkResponse = await fetch(request);

        // Only cache same-origin responses to avoid CORS issues
        if (networkResponse.ok && networkResponse.type === 'basic') {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }

        return networkResponse;
    } catch (error) {
        console.log('[SW] Fetch failed for:', request.url);
        throw error;
    }
}


// ================================================================
// PUSH NOTIFICATION EVENT (future feature)
// ================================================================
// SafeShores does not use email alerts, but push notifications
// could be added in the future for HAB warnings.
self.addEventListener('push', (event) => {
    console.log('[SW] Push received:', event);

    let data = {
        title: 'SafeShores Alert',
        body: 'Beach conditions have changed',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'safeshores-alert',
        data: { url: '/' }
    };

    if (event.data) {
        try {
            data = { ...data, ...event.data.json() };
        } catch (e) {
            data.body = event.data.text();
        }
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon,
            badge: data.badge,
            tag: data.tag,
            data: data.data,
            vibrate: [200, 100, 200],
            requireInteraction: data.title.includes('Danger')
        })
    );
});


// ================================================================
// NOTIFICATION CLICK EVENT
// ================================================================
// When the user taps a push notification, focus the app if open
// or open a new window if not.
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event);

    event.notification.close();

    const urlToOpen = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // If the app is already open, focus it
                for (const client of clientList) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Otherwise open a new window
                if (clients.openWindow) {
                    return clients.openWindow(urlToOpen);
                }
            })
    );
});


// ================================================================
// BACKGROUND SYNC (future feature)
// ================================================================
// Could be used to retry failed report submissions when connectivity
// is restored. Not implemented in v1.
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-report-data') {
        console.log('[SW] Background sync triggered for reports');
        // Future: retry queued report submissions
    }
});


// ================================================================
// MESSAGE HANDLER
// ================================================================
// Allows the main page to communicate with the service worker.
// Supported messages:
//   - 'skipWaiting': Force the new SW to activate immediately
//   - 'clearCache':  Wipe the entire cache (for debugging)
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    if (event.data === 'clearCache') {
        caches.delete(CACHE_NAME).then(() => {
            console.log('[SW] Cache cleared');
        });
    }
});


console.log('[SW] SafeShores Service Worker loaded - v1');
