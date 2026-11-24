const CACHE_NAME = "nexora-v8";
const FILES_TO_CACHE = [
    "./",
    "index.html",
    "css/style.css",
    "js/app.js",
    "manifest.json",
    "icons/icon-192.png",
    "icons/icon-512.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            cache.addAll(FILES_TO_CACHE.map((file) => new Request(file, { cache: "reload" })))
        )
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

// Network first: use the latest files when online, fall back to the cache when offline
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// Open the app when a notification is tapped
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
            for (const client of windows) {
                if ("focus" in client) return client.focus();
            }
            return self.clients.openWindow("./index.html");
        })
    );
});