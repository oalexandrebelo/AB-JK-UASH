export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_SIDE = 8192;
const MAX_OCR_SIDE = 2400;
const MAX_OCR_PIXELS = 4_000_000;

export interface ImageDetails {
  width: number;
  height: number;
  format: 'jpeg' | 'png';
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Leitura cancelada.', 'AbortError');
}

function validateDimensions(details: ImageDetails): ImageDetails {
  const {width, height} = details;
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('A foto deve ter até 16 megapixels e 8.192 pixels por lado. Recorte a região da placa e tente novamente.');
  }
  if (width < 80 || height < 20) {
    throw new Error('A foto é pequena demais para leitura. Use uma imagem nítida, com pelo menos 80 × 20 pixels.');
  }
  return details;
}

/** Inspect encoded dimensions before allowing the browser to allocate decoded pixels. */
export function inspectImageBytes(bytes: Uint8Array): ImageDetails {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 24 && pngSignature.every((byte, index) => bytes[index] === byte)
    && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
    return validateDimensions({format: 'png', width: view.getUint32(16), height: view.getUint32(20)});
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frameMarkers.has(marker) && length >= 8) {
        return validateDimensions({format: 'jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3)});
      }
      offset += length;
    }
  }
  throw new Error('Não foi possível abrir a foto. Selecione um arquivo PNG ou JPEG válido.');
}

export async function inspectImageFile(file: File, signal?: AbortSignal): Promise<ImageDetails> {
  assertNotAborted(signal);
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('Selecione uma foto PNG ou JPEG de até 10 MB.');
  if (file.type && !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Use uma foto nos formatos PNG ou JPEG.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertNotAborted(signal);
  return inspectImageBytes(bytes);
}

/** Returns a local PNG buffer, strips metadata, and caps work sent to the OCR engine. */
export async function prepareImage(file: File, signal: AbortSignal): Promise<Uint8Array> {
  await inspectImageFile(file, signal);
  if (typeof createImageBitmap !== 'function') throw new Error('Este navegador não oferece a leitura local de imagem. Você pode digitar a placa no cadastro.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
  } catch {
    throw new Error('Não foi possível decodificar a foto. Salve-a como PNG ou JPEG e tente novamente.');
  }
  try {
    assertNotAborted(signal);
    validateDimensions({format: 'png', width: bitmap.width, height: bitmap.height});
    const scale = Math.min(1, MAX_OCR_SIDE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_OCR_PIXELS / (bitmap.width * bitmap.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Não foi possível preparar a foto neste navegador.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Não foi possível preparar a imagem.')), 'image/png');
      });
      assertNotAborted(signal);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      assertNotAborted(signal);
      return bytes;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
}
