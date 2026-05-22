// 휴가증 자동 반영 프로그램 — Service Worker (PWA 자격용)
// 캐시는 사용하지 않음 — 항상 네트워크에서 최신 버전을 받음 (캐시버스터와 별개)

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  // 네트워크 우선 — 캐시 안 함
  event.respondWith(fetch(event.request));
});
