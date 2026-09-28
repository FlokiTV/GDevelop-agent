// @flow
import {
  decodeVisualResourceBase64,
  inspectVisualResourceBuffer,
  sniffVisualMimeType,
} from './VisualResourceMetadata';

const makePng = ({
  width = 3,
  height = 2,
  colorType = 6,
}: any = {}): Buffer => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = colorType;
  return buffer;
};

const makeJpeg = (): Buffer => {
  const buffer = Buffer.alloc(21);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(2, 7);
  buffer.writeUInt16BE(3, 9);
  return buffer;
};

const makeWebpVp8x = (): Buffer => {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer[20] = 0x10;
  buffer[24] = 2;
  buffer[27] = 1;
  return buffer;
};

const utf16Be = (value: string): Buffer => {
  const le = Buffer.from(value, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) {
    be[index] = le[index + 1];
    be[index + 1] = le[index];
  }
  return be;
};

const makeTtf = (): Buffer => {
  const family = utf16Be('DX Font');
  const nameOffset = 28;
  const nameLength = 18 + family.length;
  const buffer = Buffer.alloc(nameOffset + nameLength);
  buffer.writeUInt32BE(0x00010000, 0);
  buffer.writeUInt16BE(1, 4);
  buffer.write('name', 12, 'ascii');
  buffer.writeUInt32BE(nameOffset, 20);
  buffer.writeUInt32BE(nameLength, 24);
  buffer.writeUInt16BE(0, nameOffset);
  buffer.writeUInt16BE(1, nameOffset + 2);
  buffer.writeUInt16BE(18, nameOffset + 4);
  const record = nameOffset + 6;
  buffer.writeUInt16BE(3, record);
  buffer.writeUInt16BE(1, record + 2);
  buffer.writeUInt16BE(0x0409, record + 4);
  buffer.writeUInt16BE(1, record + 6);
  buffer.writeUInt16BE(family.length, record + 8);
  buffer.writeUInt16BE(0, record + 10);
  family.copy(buffer, nameOffset + 18);
  return buffer;
};

describe('DX-28 VisualResourceMetadata', () => {
  it('extracts PNG dimensions and alpha without image tooling', () => {
    const result = inspectVisualResourceBuffer({
      buffer: makePng(),
      fileName: 'hero.png',
    });
    expect(result).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      byteSize: 33,
      image: {
        format: 'png',
        width: 3,
        height: 2,
        vector: false,
        hasAlpha: true,
      },
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extracts JPEG and WebP dimensions/alpha', () => {
    expect(
      inspectVisualResourceBuffer({
        buffer: makeJpeg(),
        fileName: 'hero.jpg',
      }).image
    ).toMatchObject({
      width: 3,
      height: 2,
      hasAlpha: false,
    });
    expect(
      inspectVisualResourceBuffer({
        buffer: makeWebpVp8x(),
        fileName: 'hero.webp',
      }).image
    ).toMatchObject({
      width: 3,
      height: 2,
      hasAlpha: true,
    });
  });

  it('supports SVG images and derives dimensions from viewBox', () => {
    const buffer = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"></svg>'
    );
    const result = inspectVisualResourceBuffer({
      buffer,
      fileName: 'icon.svg',
      requestedKind: 'image',
    });
    expect(result).toMatchObject({
      mimeType: 'image/svg+xml',
      image: {
        format: 'svg',
        width: 64,
        height: 32,
        vector: true,
        hasAlpha: true,
      },
    });
  });

  it('extracts TTF family metadata and font usability inputs', () => {
    const result = inspectVisualResourceBuffer({
      buffer: makeTtf(),
      fileName: 'font.ttf',
      requestedKind: 'font',
    });
    expect(result).toMatchObject({
      kind: 'font',
      mimeType: 'font/ttf',
      font: {
        format: 'ttf',
        family: 'DX Font',
      },
    });
  });

  it('decodes plain base64/data URLs and rejects kind mismatches', () => {
    const png = makePng();
    const plain = decodeVisualResourceBase64(png.toString('base64'));
    const dataUrl = decodeVisualResourceBase64(
      `data:image/png;base64,${png.toString('base64')}`
    );
    expect(plain.buffer.equals(png)).toBe(true);
    expect(dataUrl.declaredMime).toBe('image/png');
    expect(() =>
      inspectVisualResourceBuffer({
        buffer: png,
        fileName: 'hero.png',
        requestedKind: 'font',
      })
    ).toThrow(expect.objectContaining({ code: 'resource_kind_mismatch' }));
  });

  it('sniffs content before extension', () => {
    expect(sniffVisualMimeType(makePng(), 'wrong.ttf')).toBe('image/png');
  });
});
