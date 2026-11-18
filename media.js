/* PAPUZ — медиа: сжатие, шифрование, загрузка */

const enc = new TextEncoder();

/* ------------------------------------------------------------ константы */

export const LIMITS = {
  photosPerMessage: 20,
  photoSide: 1080,
  photoBytes: 12 * 1024 * 1024,
  voiceSeconds: 300,
  voiceBytes: 32 * 1024 * 1024,
  circleSeconds: 60,
  circleBytes: 64 * 1024 * 1024,
  videoSeconds: 300,
  videoBytes: 150 * 1024 * 1024,
  fileBytes: 1024 * 1024 * 1024,
  filesPerMessage: 5,
  messageBytes: 2 * 1024 * 1024 * 1024,
};

/* --------------------------------------------------------- сжатие фото */

export async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error('Этот формат картинки не открылся');
  }
}

/** возвращает {blob, width, height} — вписывает в квадрат maxSide */
export async function compressImage(file, maxSide = LIMITS.photoSide, quality = 0.82) {
  const img = await decodeImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  img.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('Не получилось сжать фото');
  return { blob, width: w, height: h };
}

/* ------------------------------------------------------ шифр медиа-байт */

export async function encryptBlob(key, blob) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await blob.arrayBuffer());
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(ct), iv.length);
  return new Blob([all], { type: 'application/octet-stream' });
}

export async function decryptBlob(key, blob, mime) {
  const all = new Uint8Array(await blob.arrayBuffer());
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: all.slice(0, 12) },
    key,
    all.slice(12)
  );
  return new Blob([plain], { type: mime || 'application/octet-stream' });
}

/* -------------------------------------------------------------- загрузка */

export function uploadBlob({ chatId, kind, blob, name = '', mime, enc: isEnc, w = 0, h = 0, dur = 0, onProgress }) {
  const CHUNK = 8 * 1024 * 1024;
  const type = mime || blob.type || 'application/octet-stream';

  /* большие файлы идём частями: Cloudflare не пропускает тело больше ~100 МБ */
  if (blob.size > 24 * 1024 * 1024) {
    return uploadInChunks({ chatId, kind, blob, name, mime: type, enc: isEnc, w, h, dur, onProgress, chunk: CHUNK });
  }

  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({
      chat: String(chatId), kind, name,
      w: String(Math.round(w)), h: String(Math.round(h)),
      dur: String(Math.round(dur)), enc: isEnc ? '1' : '0',
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?${q}`);
    xhr.setRequestHeader('content-type', type);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* пусто */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.media) resolve(data);
      else reject(new Error(data?.error || 'Не удалось загрузить файл'));
    });
    xhr.addEventListener('error', () => reject(new Error('Связь оборвалась во время загрузки')));
    xhr.addEventListener('abort', () => reject(new Error('Загрузка отменена')));
    xhr.send(blob);
  });
}

async function uploadInChunks({ chatId, kind, blob, name, mime, enc: isEnc, w, h, dur, onProgress, chunk }) {
  const begin = await fetch('/api/upload/begin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat: chatId, kind, size: blob.size, name, mime, enc: isEnc, w, h, dur }),
  });
  const started = await begin.json().catch(() => null);
  if (!begin.ok) throw new Error(started?.error || 'Не удалось начать загрузку');

  const total = blob.size;
  let sent = 0;
  for (let i = 0; sent < total; i++) {
    const part = blob.slice(sent, Math.min(total, sent + chunk));
    const res = await fetch(`/api/upload/chunk?upload=${encodeURIComponent(started.uploadId)}&i=${i}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: part,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Часть файла не загрузилась');
    }
    sent += part.size;
    onProgress?.(sent / total);
  }

  const end = await fetch('/api/upload/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: started.uploadId }),
  });
  const done = await end.json().catch(() => null);
  if (!end.ok || !done?.media) throw new Error(done?.error || 'Загрузка не завершилась');
  return done;
}

/* ------------------------------------------------------------ описание */

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
}

export function clock(seconds) {
  const n = Number(seconds);
  const s = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------------------------------------------------- видео-мета */

export function videoMeta(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      const out = { duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight };
      URL.revokeObjectURL(url);
      v.remove();
      resolve(out);
    });
    v.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      v.remove();
      reject(new Error('Видео не открылось'));
    });
  });
}
