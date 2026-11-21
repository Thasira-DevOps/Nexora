const CACHE_NAME = "nexora-v4";
const FILES_TO_CACHE = [
    "./",
    "index.html",
    "css/style.css",
    "js/app.js",
    "manifest.json",
    "icons/icon-192.png",
    "icons/icon-512.png"
];

// Save app files so the app works offline
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
    );
    self.skipWaiting();
});

// Remove old caches when the version changes
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

// Serve from cache first, fall back to network
self.addEventListener("fetch", (event) => {
    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});