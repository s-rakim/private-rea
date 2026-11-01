'use strict';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

function showForm(value) {
  $('failed').hidden = true;
  $('form').hidden = false;
  $('server').value = value || '';
  $('server').focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  const result = await window.setup.connect($('server').value);
  if (!result?.ok) $('error').textContent = result?.error || 'Enter your server address.';
});
$('server').addEventListener('input', () => { $('error').textContent = ''; });
$('retry').addEventListener('click', () => window.setup.retry());
$('change').addEventListener('click', () => showForm(params.get('server')));

if (params.get('mode') === 'error' && params.get('server')) {
  $('where').textContent = params.get('server');
  $('failed').hidden = false;
} else {
  showForm(params.get('server'));
}
