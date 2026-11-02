// Picking a profile or group photo: choose an image, then drag and zoom it
// inside a circle before it is uploaded.
import { h, icon, dialog } from './ui.js';

const VIEW = 280; // size of the crop area in CSS pixels
const OUT = 640; // size of the uploaded photo

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This image can't be opened. Try a JPEG or PNG."));
    img.src = url;
  });

// Opens the file chooser. Resolves with the chosen File, or null.
export function chooseImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    input.addEventListener('change', () => {
      const file = input.files[0] || null;
      input.remove();
      resolve(file);
    });
    // Nothing fires when the chooser is dismissed; the promise just stays open.
    document.body.append(input);
    input.click();
  });
}

// Shows the crop dialog for `file`. Resolves with a square JPEG Blob, or null
// if the person cancels.
export async function cropPhoto(file, { title = 'Crop photo', round = true } = {}) {
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImage(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  const w = img.naturalWidth;
  const hgt = img.naturalHeight;
  // `base` makes the short side fill the crop area; zoom multiplies it.
  const base = VIEW / Math.min(w, hgt);
  let zoom = 1;
  let x = 0; // offset of the image centre from the crop centre, CSS px
  let y = 0;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const canvas = h('canvas', { class: 'crop-canvas', width: VIEW * dpr, height: VIEW * dpr, 'aria-label': 'Drag to move the photo' });
  const ctx = canvas.getContext('2d');

  const clamp = () => {
    const s = base * zoom;
    const maxX = Math.max(0, (w * s - VIEW) / 2);
    const maxY = Math.max(0, (hgt * s - VIEW) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
    y = Math.min(maxY, Math.max(-maxY, y));
  };
  const draw = () => {
    clamp();
    const s = base * zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, VIEW / 2 + x - (w * s) / 2, VIEW / 2 + y - (hgt * s) / 2, w * s, hgt * s);
  };

  const slider = h('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1', 'aria-label': 'Zoom' });
  const setZoom = (z, cx = 0, cy = 0) => {
    const next = Math.min(4, Math.max(1, z));
    // Keep the point under (cx, cy) where it is while zooming.
    x = cx + ((x - cx) * next) / zoom;
    y = cy + ((y - cy) * next) / zoom;
    zoom = next;
    slider.value = String(zoom);
    draw();
  };
  slider.addEventListener('input', () => setZoom(Number(slider.value)));

  // Drag with a mouse or one finger, pinch with two.
  const pointers = new Map();
  let pinch = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { px: e.clientX - r.left - r.width / 2, py: e.clientY - r.top - r.height / 2 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { cx: e.clientX, cy: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.cx - b.cx, a.cy - b.cy), zoom };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { cx: e.clientX, cy: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const r = canvas.getBoundingClientRect();
      const mid = { px: (a.cx + b.cx) / 2 - r.left - r.width / 2, py: (a.cy + b.cy) / 2 - r.top - r.height / 2 };
      setZoom((pinch.zoom * Math.hypot(a.cx - b.cx, a.cy - b.cy)) / pinch.dist, mid.px, mid.py);
    } else if (pointers.size === 1) {
      x += e.clientX - prev.cx;
      y += e.clientY - prev.cy;
      draw();
    }
  });
  const lift = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { px, py } = local(e);
    setZoom(zoom * Math.exp(-e.deltaY / 400), px, py);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 20 : 6;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      x += moves[e.key][0];
      y += moves[e.key][1];
      draw();
    } else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.1);
    else if (e.key === '-') setZoom(zoom / 1.1);
  });
  canvas.tabIndex = 0;

  const render = () => {
    clamp();
    const s = base * zoom;
    const out = document.createElement('canvas');
    out.width = out.height = Math.min(OUT, Math.round(VIEW / s));
    const scale = out.width / VIEW;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff'; // transparent PNGs become white, not black
    octx.fillRect(0, 0, out.width, out.height);
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(img, (VIEW / 2 + x - (w * s) / 2) * scale, (VIEW / 2 + y - (hgt * s) / 2) * scale, w * s * scale, hgt * s * scale);
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("This image can't be used as a photo"))), 'image/jpeg', 0.9));
  };

  return new Promise((resolve, reject) => {
    let result = null;
    let busy = false;
    dialog({
      title,
      content: h(
        'div',
        { class: 'crop' },
        h('div', { class: `crop-stage${round ? ' round' : ''}` }, canvas, h('div', { class: 'crop-mask', 'aria-hidden': 'true' })),
        h('div', { class: 'crop-zoom' }, icon('image'), slider, icon('image')),
        h('p', { class: 'muted small center' }, 'Drag to move, pinch or scroll to zoom'),
      ),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: 'Use photo',
          kind: 'primary',
          onClick: async (close) => {
            if (busy) return;
            busy = true;
            try {
              result = await render();
              close();
            } catch (err) {
              busy = false;
              reject(err);
              close();
            }
          },
        },
      ],
      onClose: () => {
        URL.revokeObjectURL(url);
        resolve(result);
      },
    });
    draw();
  });
}

// Choose an image and crop it. Resolves with a Blob, or null.
export async function pickPhoto(options) {
  const file = await chooseImage();
  if (!file) return null;
  return cropPhoto(file, options);
}
