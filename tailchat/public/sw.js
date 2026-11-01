// Tailchat's service worker. It only shows notifications (phones and
// installed apps can't show them from the page itself) and opens the chat a
// notification is about. It caches nothing.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = windows.find((w) => 'focus' in w);
    if (win) {
      await win.focus();
      if (chatId) win.postMessage({ type: 'open-chat', chatId });
      return;
    }
    await self.clients.openWindow(chatId ? `/#chat=${encodeURIComponent(chatId)}` : '/');
  })());
});
