import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectImageBytes, inspectImageFile, MAX_IMAGE_BYTES} from '../src/features/ocr/image.ts';
import {extractPlateCandidates, isValidPlate, normalizePlate} from '../src/features/ocr/plate.ts';

test('input inspection accepts the real PNG fixture and rejects a declared oversized image before decode', async () => {
  const fixture = new Uint8Array(await readFile(new URL('./ocr-fixtures/mercosul.png', import.meta.url)));
  assert.deepEqual(inspectImageBytes(fixture), {format: 'png', width: 1100, height: 280});
  const tooLarge = fixture.slice();
  new DataView(tooLarge.buffer).setUint32(16, 100_000);
  assert.throws(() => inspectImageBytes(tooLarge), /16 megapixels/);
});

test('image upload rejects SVG, truncated JPEG, empty/oversize files and an already aborted operation', async () => {
  await assert.rejects(inspectImageFile(new File(['<svg/>'], 'photo.png', {type: 'image/png'})), /PNG ou JPEG válido/);
  assert.throws(() => inspectImageBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17])), /PNG ou JPEG válido/);
  await assert.rejects(inspectImageFile(new File([], 'empty.png', {type: 'image/png'})), /até 10 MB/);
  await assert.rejects(inspectImageFile(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png', {type: 'image/png'})), /até 10 MB/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inspectImageFile(new File(['x'], 'photo.png'), controller.signal), {name: 'AbortError'});
});

test('plate suggestions keep complete supported formats and never guess ambiguous characters', () => {
  assert.equal(normalizePlate('abc-1234'), 'ABC1234');
  assert.equal(isValidPlate('ABC1D23'), true);
  assert.equal(isValidPlate('ABC1234'), true);
  assert.equal(isValidPlate('ABO12O4'), false);
  assert.deepEqual(extractPlateCandidates('BRASIL\nABC1D23\nABC-1234\nABC1D23'), ['ABC1D23', 'ABC1234']);
  assert.deepEqual(extractPlateCandidates('XABC1234X ABC12345 ABO12O4'), []);
});
