// Export chat, as on WhatsApp: the conversation as a text file, or a zip of
// the text file and the chat's media. Everything is decrypted on this device.
import { S, api, nameOf, isMe, chatTitle, contentOf, readMessage, systemText, withNames, fileBlob } from './app.js';
import { safeName } from './media.js';

const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_MEDIA_FILES = 10_000;

const pad = (n) => String(n).padStart(2, '0');
const text = (v) => (typeof v === 'string' ? v : '');

function stamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav',
};

function mediaName(c, index) {
  const mime = text(c.file?.mime).split(';')[0].trim().toLowerCase();
  const name = safeName(text(c.file?.name), `${text(c.kind) || 'file'}${EXTENSIONS[mime] || ''}`);
  return `${String(index).padStart(4, '0')}-${name}`;
}

// Loads every message of the chat this account can see, oldest first.
async function allMessages(chatId, onProgress) {
  const all = [];
  let before = 0;
  for (;;) {
    const { messages, hasMore } = await api.get(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=200${before ? `&before=${before}` : ''}`);
    all.unshift(...messages);
    onProgress?.(`Loading messages… ${all.length}`);
    if (!hasMore || !messages.length) return all;
    before = messages[0].seq;
  }
}

function body(m, c, attached) {
  switch (c.type) {
    case 'text':
      return withNames(text(c.text), c.mentions);
    case 'media':
      return `${attached ? `${attached} (file attached)` : '<Media omitted>'}${text(c.caption) ? `\n${text(c.caption)}` : ''}`;
    case 'location': {
      const lat = Number(c.lat);
      const lon = Number(c.lon);
      const where = Number.isFinite(lat) && Number.isFinite(lon) ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}` : '';
      return `Location: ${[text(c.name), where].filter(Boolean).join(' ')}`;
    }
    case 'contact':
      return `Contact: ${text(c.name)} (${text(c.userId)})`;
    case 'poll':
      return [`Poll: ${text(c.question)}`, ...(Array.isArray(c.options) ? c.options.map((o) => `- ${text(o)}`) : [])].join('\n');
    case 'deleted':
      return isMe(m.senderId) ? 'You deleted this message' : 'This message was deleted';
    case 'opened':
      return '<View once message>';
    default:
      return '<Message>';
  }
}

// Returns { blob, name }. onProgress(text) reports what it is doing.
export async function exportChat(chat, { media = false, onProgress } = {}) {
  const messages = await allMessages(chat.id, onProgress);
  const title = chatTitle(chat);
  const lines = [`Chat with ${title}, exported from Tailchat on ${stamp(Date.now())}.`, ''];
  const files = [];
  let mediaBytes = 0;
  let skipped = 0;
  for (const [i, m] of messages.entries()) {
    if (i % 50 === 0) onProgress?.(`Decrypting… ${i} of ${messages.length}`);
    const res = m.kind === 'system' ? contentOf(m) : await readMessage(m);
    const when = stamp(m.createdAt);
    if (m.kind === 'system') {
      lines.push(`${when} - ${systemText(m, res.ok)}`);
      continue;
    }
    const who = isMe(m.senderId) ? S.me.name : nameOf(m.senderId);
    if (!res?.ok) {
      lines.push(`${when} - ${who}: <This message couldn't be read on this device>`);
      continue;
    }
    const c = res.ok;
    let attached = null;
    if (media && c.type === 'media' && !m.viewOnce && c.file?.id && Number(c.file.size) >= 0) {
      if (mediaBytes + Number(c.file.size) > MAX_MEDIA_BYTES || files.length >= MAX_MEDIA_FILES) {
        skipped++;
      } else {
        onProgress?.(`Decrypting media… ${files.length + 1}`);
        try {
          const blob = await fileBlob(c.file);
          attached = mediaName(c, files.length + 1);
          files.push({ name: attached, blob, date: new Date(m.createdAt) });
          mediaBytes += blob.size;
        } catch {
          skipped++;
        }
      }
    }
    const edited = m.editedAt && !m.deletedAt ? ' <This message was edited>' : '';
    lines.push(`${when} - ${who}: ${m.viewOnce && c.type === 'media' ? '<View once message>' : body(m, c, attached)}${edited}`);
  }
  if (skipped) lines.push('', `${skipped} media file${skipped === 1 ? ' was' : 's were'} left out (too large or no longer available).`);
  const transcript = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const base = safeName(`Tailchat chat with ${title}`, 'Tailchat chat');
  if (!media) return { blob: transcript, name: `${base}.txt` };
  onProgress?.('Packing…');
  return { blob: await zip([{ name: `${base}.txt`, blob: transcript, date: new Date() }, ...files]), name: `${base}.zip` };
}

// ---------- a minimal zip writer (stored, not compressed: media is already compressed) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

async function crc32(blob) {
  let c = 0xffffffff;
  const step = 8 * 1024 * 1024;
  for (let start = 0; start < blob.size; start += step) {
    const bytes = new Uint8Array(await blob.slice(start, start + step).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name, blob, date }]. Names are stored as UTF-8.
export async function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  const used = new Set();
  let offset = 0;
  for (const f of files) {
    let name = f.name;
    for (let n = 2; used.has(name); n++) name = `${n}-${f.name}`;
    used.add(name);
    const nameBytes = enc.encode(name);
    const crc = await crc32(f.blob);
    const { time, date } = dosTime(f.date || new Date());
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.blob.size, true);
    local.setUint32(22, f.blob.size, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local.buffer, nameBytes, f.blob);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, f.blob.size, true);
    entry.setUint32(24, f.blob.size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, nameBytes);
    offset += 30 + nameBytes.length + f.blob.size;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
