// 入口網頁的 service worker：讓瀏覽器可以「安裝為應用程式」。
// 只處理本站（candyhsucoding.github.io）的檔案，而且一律先上網抓最新版，網路斷了才用上次的備份。
// 排班資料（script.google.com）等外部網址完全不經過這裡，維持原本直接連線。
const CACHE = "portal-v1";
const FILES = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "../v2/calendar.js?v=1"];

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(fetch(request)
        .then(response => {
            if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then(cache => cache.put(request, copy));
            }
            return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match("./"))));
});
