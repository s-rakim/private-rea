// Media helpers: thumbnails, image/video dimensions, voice notes.

export function kindFor(file) {
  const type = file.type || '';
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });

function drawThumb(source, w, h, max = 320) {
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}

// Returns { thumb, width, height, duration } for images and videos. The thumb
// travels inside the encrypted message, so recipients see a preview before
// downloading the full file.
export async function describeMedia(file, kind) {
  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image' || kind === 'gif') {
      const img = await loadImage(url);
      return { thumb: drawThumb(img, img.naturalWidth, img.naturalHeight), width: img.naturalWidth, height: img.naturalHeight };
    }
    if (kind === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';
      video.src = url;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = reject;
        setTimeout(resolve, 4000);
      });
      video.currentTime = Math.min(1, (video.duration || 0) / 2);
      await new Promise((resolve) => {
        video.onseeked = resolve;
        setTimeout(resolve, 1500);
      });
      return {
        thumb: video.videoWidth ? drawThumb(video, video.videoWidth, video.videoHeight) : undefined,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
      };
    }
    if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = url;
      await new Promise((resolve) => {
        audio.onloadedmetadata = resolve;
        audio.onerror = resolve;
        setTimeout(resolve, 3000);
      });
      return { duration: Number.isFinite(audio.duration) ? audio.duration : undefined };
    }
  } catch {
    // A preview is nice to have; the file is still sent without one.
  } finally {
    URL.revokeObjectURL(url);
  }
  return {};
}

// Square-ish profile photo, resized client-side before upload.
export async function resizePhoto(file, size = 640) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(size, side);
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Voice notes: MediaRecorder plus a simple level meter for the waveform.
export class VoiceRecorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    this.mime = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.chunks = [];
    this.levels = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
    const buf = new Uint8Array(this.analyser.fftSize);
    this.sampler = setInterval(() => {
      this.analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      this.levels.push(Math.min(100, Math.round((peak / 128) * 160)));
    }, 100);
    this.started = Date.now();
    this.recorder.start(250);
  }

  elapsed() {
    return (Date.now() - this.started) / 1000;
  }

  async stop() {
    const done = new Promise((resolve) => (this.recorder.onstop = resolve));
    this.recorder.stop();
    await done;
    this.cleanup();
    const duration = this.elapsed();
    const blob = new Blob(this.chunks, { type: (this.mime || 'audio/webm').split(';')[0] });
    return { blob, duration, waveform: downsample(this.levels, 48) };
  }

  cancel() {
    try {
      this.recorder?.stop();
    } catch {
      // already stopped
    }
    this.cleanup();
  }

  cleanup() {
    clearInterval(this.sampler);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }
}

function downsample(values, n) {
  if (!values.length) return Array(n).fill(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const slice = values.slice(Math.floor((i * values.length) / n), Math.floor(((i + 1) * values.length) / n) || undefined);
    out.push(slice.length ? Math.max(...slice) : values[Math.min(values.length - 1, Math.floor((i * values.length) / n))]);
  }
  return out;
}

export function extensionOf(name = '') {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  return m ? m[1] : 'file';
}

// Names come from the sender: keep them displayable and harmless as a
// download filename.
export function safeName(name, fallback = 'file') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200)
    .trim();
  return cleaned || fallback;
}
