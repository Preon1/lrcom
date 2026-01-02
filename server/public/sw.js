self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }

  const title = data.title || 'Last';
  const body = data.body || '';
  const tag = data.tag || 'lrcom';
  const url = data.url || '/';
  const requireInteraction = Boolean(data.requireInteraction);
  const vibrate = Array.isArray(data.vibrate) ? data.vibrate : [200, 100, 200];

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction,
      vibrate,
      icon: './web-app-manifest-192x192.png',
      badge: './web-app-manifest-192x192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })(),
  );
});
