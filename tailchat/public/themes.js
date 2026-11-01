// Colour themes. Each theme has a light and a dark palette of the key colours
// below; styles.css derives the rest (hover, lines, inputs) from them. Themes
// you make or edit are kept on this device with your other preferences.

export const KEYS = [
  ['accent', '--accent', 'Buttons and badges'],
  ['primary', '--primary', 'Links and highlights'],
  ['panel', '--panel', 'Background'],
  ['header', '--header', 'Bars and search'],
  ['chat', '--chat-bg', 'Chat background'],
  ['out', '--bubble-out', 'Your messages'],
  ['in', '--bubble-in', 'Their messages'],
  ['text', '--text', 'Text'],
  ['muted', '--muted', 'Secondary text'],
];

const p = (accent, primary, panel, header, chat, out, inn, text, muted) => ({ accent, primary, panel, header, chat, out, in: inn, text, muted });

export const PRESETS = [
  {
    id: 'tailscale',
    name: 'Tailscale',
    light: p('#4b70cc', '#3f5db3', '#ffffff', '#f7f5f4', '#f4f3f2', '#4b70cc', '#ffffff', '#232222', '#706e6d'),
    dark: p('#3f5db3', '#6c94ec', '#1f1e1e', '#232222', '#181717', '#3f5db3', '#2e2d2d', '#faf9f8', '#afacab'),
  },
  {
    id: 'ocean',
    name: 'Ocean',
    light: p('#0e7c86', '#0b6870', '#ffffff', '#f1f6f7', '#e9f2f3', '#0e7c86', '#ffffff', '#10272b', '#56696d'),
    dark: p('#1aa3ad', '#4fc3cc', '#0f1d21', '#16282d', '#0b171a', '#13505a', '#1d3238', '#e6f1f2', '#8fa7ab'),
  },
  {
    id: 'forest',
    name: 'Forest',
    light: p('#2f7d4f', '#276b43', '#ffffff', '#f2f5f1', '#ecf1ea', '#2f7d4f', '#ffffff', '#1b261d', '#5a695c'),
    dark: p('#3f9d63', '#6cc58f', '#141c16', '#1a251d', '#101712', '#24513a', '#222e25', '#e8efe8', '#9aab9d'),
  },
  {
    id: 'sunset',
    name: 'Sunset',
    light: p('#c94f24', '#a8421d', '#ffffff', '#fbf4ef', '#f8eee6', '#c94f24', '#ffffff', '#2b1d17', '#735f55'),
    dark: p('#e8703f', '#f39a6e', '#1e1714', '#261d19', '#181210', '#6a3320', '#2e2420', '#f6ece6', '#b39d92'),
  },
  {
    id: 'grape',
    name: 'Grape',
    light: p('#7552c7', '#6545b0', '#ffffff', '#f6f3fb', '#f1edf8', '#7552c7', '#ffffff', '#221b2e', '#675f75'),
    dark: p('#8a67dc', '#b49cf0', '#1a1622', '#211c2b', '#14111a', '#43326e', '#2a2436', '#efeaf7', '#a79fb6'),
  },
  {
    id: 'rose',
    name: 'Rose',
    light: p('#c43d6e', '#a8325d', '#ffffff', '#fbf2f5', '#f8ecf0', '#c43d6e', '#ffffff', '#2c1a21', '#755c64'),
    dark: p('#d9578a', '#f08bb0', '#1f1519', '#281c21', '#181013', '#64263f', '#30232a', '#f7eaef', '#b69ba5'),
  },
  {
    id: 'graphite',
    name: 'Graphite',
    light: p('#1f1f1f', '#1f1f1f', '#ffffff', '#f2f2f2', '#ebebeb', '#1f1f1f', '#ffffff', '#000000', '#555555'),
    dark: p('#f2f2f2', '#ffffff', '#000000', '#141414', '#0a0a0a', '#333333', '#1c1c1c', '#ffffff', '#a6a6a6'),
  },
];

export const DEFAULT_THEME = 'tailscale';
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_THEMES = 30;

// Only plain #rrggbb colours ever reach the page's styles, so a theme pasted
// from somewhere can't smuggle in anything else (a url() for instance).
function cleanPalette(palette, fallback) {
  const out = {};
  for (const [key] of KEYS) {
    const v = palette && typeof palette[key] === 'string' ? palette[key].trim() : '';
    out[key] = HEX.test(v) ? v.toLowerCase() : fallback[key];
  }
  return out;
}

export function cleanTheme(t, id) {
  if (!t || typeof t !== 'object') return null;
  const base = PRESETS.find((x) => x.id === t.base) || PRESETS[0];
  const name = typeof t.name === 'string' ? [...t.name.trim()].filter((ch) => ch >= ' ').join('').slice(0, 40) : '';
  return {
    id: id || (typeof t.id === 'string' && /^c-[a-z0-9]{1,24}$/.test(t.id) ? t.id : newThemeId()),
    name: name || 'My theme',
    base: base.id,
    light: cleanPalette(t.light, base.light),
    dark: cleanPalette(t.dark, base.dark),
  };
}

export function newThemeId() {
  return `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function customThemes(prefs) {
  const list = Array.isArray(prefs.themes) ? prefs.themes : [];
  return list.map((t) => cleanTheme(t, t?.id)).filter(Boolean).slice(0, MAX_THEMES);
}

export function findTheme(prefs, id) {
  return PRESETS.find((t) => t.id === id) || customThemes(prefs).find((t) => t.id === id) || null;
}

export const isPreset = (id) => PRESETS.some((t) => t.id === id);

// A copy of a theme you can change, named after it.
export function copyTheme(theme, prefs) {
  const taken = new Set(customThemes(prefs).map((t) => t.name));
  let name = `${theme.name} (edited)`.slice(0, 40);
  for (let n = 2; taken.has(name); n++) name = `${theme.name} (edited ${n})`.slice(0, 40);
  return cleanTheme({ ...structuredClone(theme), name, base: isPreset(theme.id) ? theme.id : theme.base }, newThemeId());
}

// A theme as text, to move it to another device.
export function themeCode(theme) {
  return JSON.stringify({ tailchatTheme: 1, name: theme.name, base: theme.base || theme.id, light: theme.light, dark: theme.dark });
}

export function parseThemeCode(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim());
  } catch {
    return null;
  }
  if (!data || data.tailchatTheme !== 1) return null;
  return cleanTheme(data, newThemeId());
}

// ---------- colour maths (WCAG relative luminance and contrast) ----------

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Black or white, whichever reads better on this colour.
export const textOn = (hex) => (contrast(hex, '#ffffff') >= contrast(hex, '#111111') ? '#ffffff' : '#111111');

// Pairs that need to stay readable, with the minimum contrast each needs.
export function readability(palette) {
  const checks = [
    ['text', 'panel', 4.5, 'Text on the background'],
    ['muted', 'panel', 3, 'Secondary text on the background'],
    ['text', 'in', 4.5, 'Text in their messages'],
    ['primary', 'panel', 3, 'Links on the background'],
    ['text', 'header', 4.5, 'Text on the bars'],
  ];
  const problems = checks.filter(([a, b, min]) => contrast(palette[a], palette[b]) < min).map(([a, b, , label]) => ({ keys: [a, b], label }));
  // Your messages get black or white text, whichever reads better, so only a
  // mid-grey bubble can't be read.
  if (contrast(palette.out, textOn(palette.out)) < 4.5) problems.push({ keys: ['out'], label: 'Text in your messages' });
  return problems;
}

// Puts a palette on the page.
export function paint(palette, mode) {
  const root = document.documentElement;
  root.dataset.theme = mode;
  for (const [key, cssVar] of KEYS) root.style.setProperty(cssVar, palette[key]);
  root.style.setProperty('--on-accent', textOn(palette.accent));
  root.style.setProperty('--on-primary', textOn(palette.primary));
  // Text and ticks in your own bubbles, which can be any colour.
  const onOut = textOn(palette.out);
  root.style.setProperty('--on-out', onOut);
  root.style.setProperty('--tick-out', contrast(palette.primary, palette.out) >= 3 ? palette.primary : onOut);
  // The logo's bubble is white, so a very light accent gets a grey logo.
  root.style.setProperty('--logo', contrast(palette.accent, '#ffffff') >= 2 ? palette.accent : '#444342');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = palette.header;
}
