// sw.js — service worker mínimo, solo para recibir Web Push (ver plan, 5.11).
// No cachea nada de la app (no es un service worker offline-first);
// su única responsabilidad es mostrar la notificación entrante.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: '⚠️ Disparo entrante', body: 'Revisa el mapa.', shotId: null };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    /* si el payload no es JSON válido, se usa el mensaje por defecto */
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png',
      data: { shotId: payload.shotId },
      tag: payload.shotId || 'geostrike-notif',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      if (clientList.length > 0) return clientList[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
