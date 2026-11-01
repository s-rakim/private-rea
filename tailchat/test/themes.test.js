import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEYS, PRESETS, cleanTheme, contrast, copyTheme, parseThemeCode, readability, textOn, themeCode } from '../public/themes.js';

test('built-in themes are complete and readable in both modes', () => {
  assert.equal(new Set(PRESETS.map((t) => t.id)).size, PRESETS.length);
  for (const t of PRESETS) {
    for (const mode of ['light', 'dark']) {
      assert.deepEqual(Object.keys(t[mode]).sort(), KEYS.map(([k]) => k).sort(), `${t.id} ${mode}`);
      assert.deepEqual(readability(t[mode]), [], `${t.id} ${mode}`);
      assert.ok(contrast(t[mode].accent, textOn(t[mode].accent)) >= 4.5, `${t.id} ${mode} button text`);
    }
  }
});

test('only #rrggbb colours get through from a theme code', () => {
  const t = parseThemeCode(JSON.stringify({
    tailchatTheme: 1,
    name: 'Mine\u0007',
    base: 'grape',
    light: { accent: '#AABBCC', panel: 'url(https://example.com/x)', text: 'red;background:url(x)', out: '#123' },
    dark: 'nope',
  }));
  assert.equal(t.name, 'Mine');
  assert.equal(t.base, 'grape');
  const grape = PRESETS.find((x) => x.id === 'grape');
  assert.equal(t.light.accent, '#aabbcc');
  assert.equal(t.light.panel, grape.light.panel);
  assert.equal(t.light.text, grape.light.text);
  assert.equal(t.light.out, grape.light.out);
  assert.deepEqual(t.dark, grape.dark);
  assert.match(t.id, /^c-[a-z0-9]+$/);
  for (const bad of ['', 'hello', '{"name":"x"}', JSON.stringify({ tailchatTheme: 2 })]) assert.equal(parseThemeCode(bad), null, bad);
});

test('editing a built-in theme makes a copy that round-trips through its code', () => {
  const copy = copyTheme(PRESETS[0], { themes: [] });
  assert.equal(copy.name, 'Tailscale (edited)');
  assert.equal(copy.base, 'tailscale');
  assert.notEqual(copy.id, 'tailscale');
  assert.equal(copyTheme(PRESETS[0], { themes: [copy] }).name, 'Tailscale (edited 2)');
  const back = parseThemeCode(themeCode({ ...copy, name: 'Night' }));
  assert.equal(back.name, 'Night');
  assert.deepEqual([back.light, back.dark], [copy.light, copy.dark]);
  assert.equal(cleanTheme(null), null);
});
