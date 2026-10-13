// Entry point: unlock this device's keys, then draw the app.
import { boot } from './app.js';
import { mount } from './views.js';

const status = document.getElementById('boot-status');
boot((text) => {
  status.textContent = text;
}).then(mount, (err) => {
  console.error(err);
  status.textContent = err.message || 'Tailchat could not start';
});
