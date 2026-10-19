import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {embeddedPreview} from './preview-extract.mjs';

// A tiny valid PNG (1x1) and helpers to read a byte array the way the server reads a file.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const reader = bytes => ({size: bytes.length, readAt: async (o, l) => new Uint8Array(bytes.subarray(o, o + l))});
const run = (extension, bytes) => { const r = reader(bytes); return embeddedPreview(extension, r.readAt, r.size); };

test('a Revit file yields the PNG inside its RevitPreview4.0 stream', async () => {
  const S = 512, stream = Buffer.concat([Buffer.alloc(300, 7), PNG, Buffer.alloc(5000 - 300 - PNG.length, 1)]);
  const streamSectors = Math.ceil(stream.length / S), file = Buffer.alloc(S * (3 + streamSectors));
  file.writeUInt32LE(0xe011cfd0, 0); file.writeUInt32LE(0xe11ab1a1, 4);
  file.writeUInt16LE(9, 0x1e); file.writeUInt16LE(6, 0x20); file.writeUInt32LE(1, 0x2c); file.writeUInt32LE(1, 0x30); file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(0xfffffffe, 0x44); file.writeUInt32LE(0, 0x4c); for (let i = 1; i < 109; i++) file.writeUInt32LE(0xffffffff, 0x4c + i * 4);
  const fat = S * 1; file.writeUInt32LE(0xfffffffd, fat); file.writeUInt32LE(0xfffffffe, fat + 4);
  for (let i = 0; i < streamSectors; i++) file.writeUInt32LE(i === streamSectors - 1 ? 0xfffffffe : 3 + i, fat + (2 + i) * 4);
  for (let i = 2 + streamSectors; i < S / 4; i++) file.writeUInt32LE(0xffffffff, fat + i * 4);
  const dir = S * 2, name = 'RevitPreview4.0';
  for (let i = 0; i < name.length; i++) file.writeUInt16LE(name.charCodeAt(i), dir + 128 + i * 2);
  file.writeUInt16LE((name.length + 1) * 2, dir + 128 + 0x40); file.writeUInt32LE(2, dir + 128 + 0x74); file.writeUInt32LE(stream.length, dir + 128 + 0x78);
  stream.copy(file, S * 3);
  const result = await run('.rvt', file);
  assert.equal(result.mime, 'image/png'); assert.deepEqual(Buffer.from(result.bytes), PNG);
});

test('a DWG file yields its PNG preview, or its bitmap made into a BMP file', async () => {
  const build = (code, picture) => {
    const file = Buffer.alloc(0x200 + picture.length); file.write('AC1032', 0, 'latin1'); file.writeUInt32LE(0x100, 0x0d);
    file[0x100 + 20] = 1; file[0x100 + 21] = code; file.writeUInt32LE(0x200, 0x100 + 22); file.writeUInt32LE(picture.length, 0x100 + 26);
    picture.copy(file, 0x200); return file;
  };
  assert.deepEqual(Buffer.from((await run('.dwg', build(6, PNG))).bytes), PNG);
  const dib = Buffer.alloc(40 + 4); dib.writeUInt32LE(40, 0); dib.writeInt32LE(1, 4); dib.writeInt32LE(1, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14);
  const bmp = await run('.dwg', build(2, dib));
  assert.equal(bmp.mime, 'image/bmp'); assert.equal(String.fromCharCode(bmp.bytes[0], bmp.bytes[1]), 'BM'); assert.equal(Buffer.from(bmp.bytes).readUInt32LE(10), 54);
});

test('a SketchUp 2021+ file yields the preview thumbnail from its zip, with a header in front', async () => {
  const name = Buffer.from('meta/preview_thumbnail.png'), data = deflateRawSync(PNG), prefix = Buffer.from('SketchUp Model header bytes');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(PNG.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(PNG.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, data]), dir = Buffer.concat([central, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  const result = await run('.skp', Buffer.concat([prefix, body, dir, end]));
  assert.deepEqual(Buffer.from(result.bytes), PNG);
});

test('other files and damaged files yield nothing', async () => {
  assert.equal(await run('.txt', Buffer.from('hello')), null);
  assert.equal(await run('.rvt', Buffer.alloc(600)), null);
  assert.equal(await run('.dwg', Buffer.from('AC1032 but nothing else')), null);
});
