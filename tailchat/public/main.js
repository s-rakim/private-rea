// Entry point: unlock this device's keys, then draw the app.
import { boot, openChat, callAction } from './app.js';
import { mount } from './views.js';

const status = document.getElementById('boot-status');
boot((text) => {
  status.textContent = text;
}).then(() => {
  mount();
  // A notification clicked while Tailchat was closed opens it at /#chat=<id>.
  const chatId = new URLSearchParams(location.hash.slice(1)).get('chat');
  if (chatId) {
    history.replaceState(null, '', location.pathname + location.search);
    openChat(chatId);
  }
}, (err) => {
  console.error(err);
  status.textContent = err.message || 'Tailchat could not start';
});

// Notifications are shown through the service worker where the page can't
// show them itself (phones, the installed app).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'open-chat' && typeof m.chatId === 'string') openChat(m.chatId);
    // Answer, Decline or swipe-away on a ringing call's notification.
    else if (m?.type === 'call-action' && typeof m.callId === 'string') callAction(m.action, m.callId);
  });
  navigator.serviceWorker.startMessages?.();
}
