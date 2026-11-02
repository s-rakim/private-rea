// Tailchat's service worker. It only shows notifications (phones and
// installed apps can't show them from the page itself), opens the chat a
// notification is about and passes Answer and Decline on a ringing call back
// to the page. It caches nothing.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The Tailchat window to talk to: the one in front, else any.
async function tailchatWindow() {
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((w) => 'focus' in w);
  return windows.find((w) => w.focused) || windows.find((w) => w.visibilityState === 'visible') || windows[0] || null;
}

self.addEventListener('notificationclick', (event) => {
  const { chatId, callId } = event.notification.data || {};
  event.notification.close();
  event.waitUntil((async () => {
    const win = await tailchatWindow();
    if (callId) {
      // A ringing call. Declining doesn't need Tailchat in front of you;
      // answering, or tapping the notification, brings it up.
      const action = event.action === 'decline' ? 'decline' : event.action === 'answer' ? 'accept' : null;
      if (win) {
        if (action !== 'decline') await win.focus().catch(() => {});
        if (action) win.postMessage({ type: 'call-action', action, callId });
        return;
      }
      if (action !== 'decline') await self.clients.openWindow('/');
      return;
    }
    if (win) {
      await win.focus();
      if (chatId) win.postMessage({ type: 'open-chat', chatId });
      return;
    }
    await self.clients.openWindow(chatId ? `/#chat=${encodeURIComponent(chatId)}` : '/');
  })());
});

// Swiping a ringing call away quiets it, without declining.
self.addEventListener('notificationclose', (event) => {
  const { callId } = event.notification.data || {};
  if (!callId) return;
  event.waitUntil(tailchatWindow().then((win) => win?.postMessage({ type: 'call-action', action: 'silence', callId })));
});
