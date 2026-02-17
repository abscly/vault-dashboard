const CACHE_NAME = 'abscl-portal-v2';
const ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/css/components.css',
    '/js/app.js',
    '/js/tools_config.json',
    '/tools/roulette.html',
    '/tools/ai_chat.html',
    '/tools/proto_builder.html',
    '/tools/template.html',
    '/manifest.json'
];

// インストール時にキャッシュ
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

// 古いキャッシュ削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// ネットワークファースト → キャッシュフォールバック（AI系はオンライン必須）
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // API呼び出しはキャッシュしない
    if (url.hostname.includes('googleapis.com')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // その他はキャッシュファースト
    event.respondWith(
        caches.match(event.request)
            .then(cached => cached || fetch(event.request))
    );
});
