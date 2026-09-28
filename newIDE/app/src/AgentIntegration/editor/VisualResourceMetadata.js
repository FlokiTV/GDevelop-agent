// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { AgentError } from '../core/AgentError';

const crypto = optionalRequire('crypto');
const bufferModule = optionalRequire('buffer');
const BufferCtor =
  typeof Buffer !== 'undefined'
    ? Buffer
    : bufferModule && bufferModule.Buffer
    ? bufferModule.Buffer
    : null;

export const VISUAL_RESOURCE_KINDS = Object.freeze(['image', 'font']);

const EXTENSION_TO_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
});

const makeError = (code: string, details?: any): AgentError =>
  new AgentError({ code, details });

const extensionOf = (fileName: any): string => {
  if (typeof fileName !== 'string') return '';
  const clean = fileName.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
};

const readUInt24LE = (buffer: any, offset: number): number =>
  buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);

const readUtf16Be = (buffer: any): string => {
  if (!BufferCtor) return '';
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = BufferCtor.alloc(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped
    .toString('utf16le')
    .split(String.fromCharCode(0))
    .join('')
    .trim();
};

const decodeFontName = (
  buffer: any,
  platformId: number,
  offset: number,
  length: number
): string => {
  if (offset < 0 || length < 0 || offset + length > buffer.length) return '';
  const slice = buffer.slice(offset, offset + length);
  if (platformId === 0 || platformId === 3) return readUtf16Be(slice);
  return slice
    .toString('latin1')
    .split(String.fromCharCode(0))
    .join('')
    .trim();
};

const inspectSfntFont = (buffer: any, mimeType: string): any => {
  if (!buffer || buffer.length < 12) {
    throw makeError('invalid_visual_font');
  }
  const signature = buffer.slice(0, 4).toString('ascii');
  const isTrueType =
    buffer.readUInt32BE(0) === 0x00010000 ||
    signature === 'true' ||
    signature === 'typ1';
  const isOpenType = signature === 'OTTO';
  if (!isTrueType && !isOpenType) {
    throw makeError('unsupported_visual_font_format', {
      signature,
      mimeType,
    });
  }

  const numTables = buffer.readUInt16BE(4);
  let nameTableOffset = -1;
  let nameTableLength = 0;
  for (let index = 0; index < numTables; index++) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > buffer.length) break;
    const tag = buffer.slice(recordOffset, recordOffset + 4).toString('ascii');
    if (tag !== 'name') continue;
    nameTableOffset = buffer.readUInt32BE(recordOffset + 8);
    nameTableLength = buffer.readUInt32BE(recordOffset + 12);
    break;
  }

  const names = {
    family: null,
    subfamily: null,
    fullName: null,
    postScriptName: null,
  };
  if (
    nameTableOffset >= 0 &&
    nameTableOffset + Math.min(nameTableLength, 6) <= buffer.length
  ) {
    const count = buffer.readUInt16BE(nameTableOffset + 2);
    const stringOffset =
      nameTableOffset + buffer.readUInt16BE(nameTableOffset + 4);
    const candidates = [];
    for (let index = 0; index < count; index++) {
      const recordOffset = nameTableOffset + 6 + index * 12;
      if (recordOffset + 12 > buffer.length) break;
      const platformId = buffer.readUInt16BE(recordOffset);
      const languageId = buffer.readUInt16BE(recordOffset + 4);
      const nameId = buffer.readUInt16BE(recordOffset + 6);
      const length = buffer.readUInt16BE(recordOffset + 8);
      const offset = stringOffset + buffer.readUInt16BE(recordOffset + 10);
      if (![1, 2, 4, 6].includes(nameId)) continue;
      const value = decodeFontName(buffer, platformId, offset, length);
      if (!value) continue;
      const priority =
        languageId === 0x0409
          ? 0
          : platformId === 0
          ? 1
          : platformId === 3
          ? 2
          : 3;
      candidates.push({ nameId, value, priority });
    }
    candidates.sort((a, b) => a.priority - b.priority);
    const first = nameId => candidates.find(item => item.nameId === nameId);
    names.family = (first(1) || {}).value || null;
    names.subfamily = (first(2) || {}).value || null;
    names.fullName = (first(4) || {}).value || null;
    names.postScriptName = (first(6) || {}).value || null;
  }

  return {
    format: isOpenType ? 'otf' : 'ttf',
    container: 'sfnt',
    mimeType,
    ...names,
  };
};

const inspectPng = (buffer: any): any => {
  if (!buffer || buffer.length < 29) throw makeError('invalid_visual_image');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  let hasTransparencyChunk = false;
  let cursor = 8;
  while (cursor + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(cursor);
    const type = buffer.slice(cursor + 4, cursor + 8).toString('ascii');
    if (type === 'tRNS') hasTransparencyChunk = true;
    cursor += 12 + chunkLength;
    if (type === 'IEND' || cursor > buffer.length) break;
  }
  return {
    format: 'png',
    width,
    height,
    vector: false,
    hasAlpha: colorType === 4 || colorType === 6 || hasTransparencyChunk,
  };
};

const inspectJpeg = (buffer: any): any => {
  if (!buffer || buffer.length < 4) throw makeError('invalid_visual_image');
  let offset = 2;
  const sofMarkers = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
  ]);
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (buffer[offset] === 0xff && offset < buffer.length) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return {
        format: 'jpeg',
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        vector: false,
        hasAlpha: false,
      };
    }
    offset += length;
  }
  throw makeError('invalid_visual_image', { format: 'jpeg' });
};

const inspectWebp = (buffer: any): any => {
  if (!buffer || buffer.length < 30) throw makeError('invalid_visual_image');
  const chunk = buffer.slice(12, 16).toString('ascii');
  const dataOffset = 20;
  if (chunk === 'VP8X') {
    return {
      format: 'webp',
      width: 1 + readUInt24LE(buffer, dataOffset + 4),
      height: 1 + readUInt24LE(buffer, dataOffset + 7),
      vector: false,
      hasAlpha: (buffer[dataOffset] & 0x10) !== 0,
    };
  }
  if (chunk === 'VP8L' && buffer[dataOffset] === 0x2f) {
    const b1 = buffer[dataOffset + 1];
    const b2 = buffer[dataOffset + 2];
    const b3 = buffer[dataOffset + 3];
    const b4 = buffer[dataOffset + 4];
    return {
      format: 'webp',
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
      vector: false,
      hasAlpha: (b4 & 0x10) !== 0,
    };
  }
  if (
    chunk === 'VP8 ' &&
    buffer[dataOffset + 3] === 0x9d &&
    buffer[dataOffset + 4] === 0x01 &&
    buffer[dataOffset + 5] === 0x2a
  ) {
    return {
      format: 'webp',
      width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
      height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      vector: false,
      hasAlpha: false,
    };
  }
  throw makeError('invalid_visual_image', { format: 'webp' });
};

const parseSvgDimension = (value: any): ?number => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const inspectSvg = (buffer: any): any => {
  const text = buffer
    .slice(0, Math.min(buffer.length, 1024 * 1024))
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  const svgTag = text.match(/<svg\b[^>]*>/i);
  if (!svgTag) throw makeError('invalid_visual_image', { format: 'svg' });
  const tag = svgTag[0];
  const widthMatch = tag.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const heightMatch = tag.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  const viewBoxMatch = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  let width = widthMatch ? parseSvgDimension(widthMatch[1]) : null;
  let height = heightMatch ? parseSvgDimension(heightMatch[1]) : null;
  let viewBox = null;
  if (viewBoxMatch) {
    const values = viewBoxMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (values.length === 4 && values.every(Number.isFinite)) {
      viewBox = values;
      if (width === null && values[2] >= 0) width = values[2];
      if (height === null && values[3] >= 0) height = values[3];
    }
  }
  return {
    format: 'svg',
    width,
    height,
    viewBox,
    vector: true,
    hasAlpha: true,
    alphaSemantics:
      'SVG renders on a transparent canvas unless its content paints an opaque background.',
  };
};

export const sniffVisualMimeType = (
  buffer: any,
  fileName?: ?string,
  declaredMime?: ?string
): string => {
  if (buffer && buffer.length >= 8) {
    if (buffer[0] === 0x89 && buffer.slice(1, 4).toString('ascii') === 'PNG') {
      return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (buffer.slice(0, 4).toString('ascii') === 'OTTO') return 'font/otf';
    if (buffer.readUInt32BE(0) === 0x00010000) return 'font/ttf';
  }
  if (buffer) {
    const sample = buffer
      .slice(0, Math.min(buffer.length, 2048))
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(sample)) {
      return 'image/svg+xml';
    }
  }
  const normalizedDeclared =
    typeof declaredMime === 'string'
      ? declaredMime
          .split(';')[0]
          .trim()
          .toLowerCase()
      : '';
  if (
    normalizedDeclared &&
    Object.values(EXTENSION_TO_MIME).includes(normalizedDeclared)
  ) {
    return normalizedDeclared;
  }
  return EXTENSION_TO_MIME[extensionOf(fileName)] || 'application/octet-stream';
};

export const inferVisualKind = (
  mimeType: string,
  requestedKind?: ?string
): string => {
  if (
    requestedKind !== undefined &&
    requestedKind !== null &&
    !VISUAL_RESOURCE_KINDS.includes(requestedKind)
  ) {
    throw makeError('unsupported_visual_resource_kind', {
      requestedKind,
      supportedKinds: VISUAL_RESOURCE_KINDS,
    });
  }
  const inferred = mimeType.startsWith('image/')
    ? 'image'
    : mimeType.startsWith('font/')
    ? 'font'
    : null;
  if (!inferred) {
    throw makeError('unsupported_visual_resource_content', { mimeType });
  }
  if (requestedKind && requestedKind !== inferred) {
    throw makeError('resource_kind_mismatch', {
      requestedKind,
      detectedKind: inferred,
      mimeType,
    });
  }
  return requestedKind || inferred;
};

export const decodeVisualResourceBase64 = (value: any): any => {
  if (!BufferCtor) {
    throw makeError('visual_resource_runtime_unavailable');
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw makeError('missing_visual_resource_content');
  }
  let declaredMime = null;
  let payload = value.trim();
  const dataUrl = payload.match(/^data:([^;,]+);base64,(.*)$/is);
  if (dataUrl) {
    declaredMime = dataUrl[1].trim().toLowerCase();
    payload = dataUrl[2];
  }
  payload = payload.replace(/\s+/g, '');
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    throw makeError('invalid_visual_resource_base64');
  }
  const buffer = BufferCtor.from(payload, 'base64');
  if (!buffer.length) throw makeError('invalid_visual_resource_base64');
  return { buffer, declaredMime };
};

export const inspectVisualResourceBuffer = ({
  buffer,
  fileName,
  requestedKind,
  declaredMime,
}: any): any => {
  if (!buffer || typeof buffer.length !== 'number') {
    throw makeError('missing_visual_resource_bytes');
  }
  const mimeType = sniffVisualMimeType(buffer, fileName, declaredMime);
  const kind = inferVisualKind(mimeType, requestedKind);
  let image = null;
  let font = null;
  if (kind === 'image') {
    if (mimeType === 'image/png') image = inspectPng(buffer);
    else if (mimeType === 'image/jpeg') image = inspectJpeg(buffer);
    else if (mimeType === 'image/webp') image = inspectWebp(buffer);
    else if (mimeType === 'image/svg+xml') image = inspectSvg(buffer);
    else throw makeError('unsupported_visual_image_format', { mimeType });
  } else if (kind === 'font') {
    font = inspectSfntFont(buffer, mimeType);
  }

  return {
    kind,
    mimeType,
    byteSize: buffer.length,
    sha256:
      crypto && typeof crypto.createHash === 'function'
        ? crypto
            .createHash('sha256')
            .update(buffer)
            .digest('hex')
        : null,
    image,
    font,
  };
};

export const visualResourceMetadataInternals = {
  inspectJpeg,
  inspectPng,
  inspectSfntFont,
  inspectSvg,
  inspectWebp,
  parseSvgDimension,
  readUtf16Be,
};
