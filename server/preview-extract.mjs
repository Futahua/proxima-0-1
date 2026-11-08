// Preview pictures that Revit, AutoCAD and SketchUp already store inside their files, read without those
// programs. Only the needed parts are read (readAt), so a 300 MB model costs a few kilobytes.
// readAt(offset, length) -> Promise<Uint8Array>; size is the file length in bytes.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function indexOfPng(bytes, from = 0) {
  outer: for (let i = from; i <= bytes.length - 8; i++) {
    for (let j = 0; j < 8; j++) if (bytes[i + j] !== PNG_SIGNATURE[j]) continue outer;
    return i;
  }
  return -1;
}
// A whole PNG starting at `start`: walk its chunks to IEND.
function pngAt(bytes, start) {
  let o = start + 8;
  while (o + 12 <= bytes.length) {
    const length = be32(bytes, o), type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    o += 12 + length;
    if (o > bytes.length) return null;
    if (type === 'IEND') return bytes.slice(start, o);
  }
  return null;
}
function firstPng(bytes) {
  for (let at = indexOfPng(bytes); at >= 0; at = indexOfPng(bytes, at + 1)) { const png = pngAt(bytes, at); if (png) return png; }
  return null;
}

// Revit: an OLE compound file whose "RevitPreview4.0" stream holds a PNG after a small header.
async function revit(readAt, size) {
  const h = await readAt(0, 512);
  if (u32(h, 0) !== 0xe011cfd0 || u32(h, 4) !== 0xe11ab1a1) return null;
  const sectorSize = 1 << u16(h, 0x1e), fatSectors = u32(h, 0x2c), firstDir = u32(h, 0x30), cutoff = u32(h, 0x38);
  const sectorOffset = s => (s + 1) * sectorSize;
  const difat = [];
  for (let i = 0; i < 109 && difat.length < fatSectors; i++) difat.push(u32(h, 0x4c + i * 4));
  for (let next = u32(h, 0x44), guard = 0; difat.length < fatSectors && next < 0xfffffffa && guard++ < 10000;) {
    const d = await readAt(sectorOffset(next), sectorSize), per = sectorSize / 4 - 1;
    for (let i = 0; i < per && difat.length < fatSectors; i++) difat.push(u32(d, i * 4));
    next = u32(d, per * 4);
  }
  const fat = new Uint32Array(difat.length * sectorSize / 4);
  for (let i = 0; i < difat.length; i++) { const s = await readAt(sectorOffset(difat[i]), sectorSize); for (let j = 0; j < sectorSize / 4; j++) fat[i * sectorSize / 4 + j] = u32(s, j * 4); }
  const chain = start => { const out = []; for (let s = start; s < 0xfffffffa && out.length <= fat.length; s = fat[s]) out.push(s); return out; };
  const readChain = async (start, length) => {
    const out = new Uint8Array(length); let at = 0;
    for (const s of chain(start)) { if (at >= length) break; const part = await readAt(sectorOffset(s), Math.min(sectorSize, length - at)); out.set(part, at); at += part.length; }
    return out;
  };
  for (const s of chain(firstDir)) {
    const dir = await readAt(sectorOffset(s), sectorSize);
    for (let e = 0; e < sectorSize; e += 128) {
      const nameLength = u16(dir, e + 0x40);
      if (nameLength < 2 || nameLength > 64) continue;
      let name = ''; for (let i = 0; i < nameLength - 2; i += 2) name += String.fromCharCode(u16(dir, e + i));
      if (name !== 'RevitPreview4.0') continue;
      const start = u32(dir, e + 0x74), length = u32(dir, e + 0x78);
      if (length < cutoff || length > 32 * 1024 * 1024) return null; // previews are never mini-stream sized
      const png = firstPng(await readChain(start, length));
      return png ? {mime: 'image/png', bytes: png} : null;
    }
  }
  return null;
}

// AutoCAD: offset 0x0D points to a preview section listing its pictures (PNG from 2013, BMP before).
async function dwg(readAt, size) {
  const h = await readAt(0, 0x20), version = String.fromCharCode(...h.slice(0, 6));
  if (!/^AC10\d\d$/.test(version)) return null;
  const at = u32(h, 0x0d);
  if (!at || at + 0x40 > size) return null;
  const head = await readAt(at, 0x60);
  const count = head[16 + 4];
  for (let i = 0, o = 16 + 5; i < count && o + 9 <= head.length; i++, o += 9) {
    const code = head[o], start = u32(head, o + 1), length = u32(head, o + 5);
    if (!length || start + length > size || length > 16 * 1024 * 1024) continue;
    if (code === 6) { const png = firstPng(await readAt(start, length)); if (png) return {mime: 'image/png', bytes: png}; }
    if (code === 2) {
      // A device-independent bitmap without its 14-byte file header: add one so any viewer opens it.
      const dib = await readAt(start, length), headerSize = u32(dib, 0), bits = u16(dib, 14), colors = u32(dib, 32) || (bits <= 8 ? 1 << bits : 0);
      const pixels = 14 + headerSize + colors * 4, file = new Uint8Array(14 + dib.length), view = new DataView(file.buffer);
      file[0] = 0x42; file[1] = 0x4d; view.setUint32(2, file.length, true); view.setUint32(10, pixels, true); file.set(dib, 14);
      return {mime: 'image/bmp', bytes: file};
    }
  }
  return null;
}

// A named entry of a zip archive (possibly with other bytes in front), read through its central directory.
async function zipEntry(readAt, size, names) {
  const tailLength = Math.min(size, 65536 + 22), tail = await readAt(size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const dirSize = u32(tail, eocd + 12), dirOffsetRaw = u32(tail, eocd + 16);
  const dirStart = size - tailLength + eocd - dirSize, shift = dirStart - dirOffsetRaw; // bytes ahead of the archive
  const dir = await readAt(dirStart, dirSize);
  for (let o = 0; o + 46 <= dir.length && u32(dir, o) === 0x02014b50;) {
    const method = u16(dir, o + 10), compressed = u32(dir, o + 20), nameLength = u16(dir, o + 28), extra = u16(dir, o + 30), comment = u16(dir, o + 32), local = u32(dir, o + 42) + shift;
    const name = new TextDecoder().decode(dir.slice(o + 46, o + 46 + nameLength));
    if (names.includes(name) && compressed <= 32 * 1024 * 1024) {
      const lh = await readAt(local, 30), data = await readAt(local + 30 + u16(lh, 26) + u16(lh, 28), compressed);
      if (method === 0) return data;
      if (method === 8 && typeof DecompressionStream === 'function') {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return null;
    }
    o += 46 + nameLength + extra + comment;
  }
  return null;
}

// SketchUp: from 2021 a zip (after a short header) holding meta/preview_thumbnail.png; earlier files keep
// the thumbnail PNG near their start.
async function sketchup(readAt, size) {
  const zipped = await zipEntry(readAt, size, ['meta/preview_thumbnail.png', 'meta/model_thumbnail.png']);
  const png = zipped ? firstPng(zipped) : firstPng(await readAt(0, Math.min(size, 8 * 1024 * 1024)));
  return png ? {mime: 'image/png', bytes: png} : null;
}

const readers = {'.rvt': revit, '.rfa': revit, '.rte': revit, '.dwg': dwg, '.skp': sketchup};
export const embeddedPreviewExtensions = Object.keys(readers);
export async function embeddedPreview(extension, readAt, size) {
  const read = readers[String(extension).toLowerCase()];
  if (!read) return null;
  try { return await read(readAt, size); } catch { return null; }
}
