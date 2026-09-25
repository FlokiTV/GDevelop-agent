const test = require('node:test');
const assert = require('node:assert/strict');
const {
  comparePngBuffers,
  decodePng,
  encodeRgbaPng,
} = require('./ImageComparison');

const makeImage = (width, height, pixel) => {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    data[offset] = pixel[0];
    data[offset + 1] = pixel[1];
    data[offset + 2] = pixel[2];
    data[offset + 3] = pixel[3];
  }
  return { width, height, data };
};

test('encodes and decodes deterministic RGBA PNG buffers in pure JavaScript', () => {
  const image = makeImage(4, 3, [12, 34, 56, 255]);
  const png = encodeRgbaPng(image);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.deepEqual(decoded.data, image.data);
});

test('exact mode preserves byte identity semantics and reports pixel metrics', () => {
  const png = encodeRgbaPng(makeImage(8, 8, [80, 90, 100, 255]));
  const same = comparePngBuffers({
    expectedPng: png,
    actualPng: Buffer.from(png),
    mode: 'exact',
  });
  assert.equal(same.passed, true);
  assert.equal(same.exactPngIdentity, true);
  assert.equal(same.exactPixelIdentity, true);
  assert.equal(same.differentPixelRatio, 0);
  assert.equal(same.meanDifference, 0);
  assert.equal(same.maxDifference, 0);
  assert.equal(same.similarity, 1);
});

test('pixel tolerance passes tiny antialiasing-like changes but fails material differences', () => {
  const expected = makeImage(16, 16, [100, 110, 120, 255]);
  const close = {
    ...expected,
    data: Buffer.from(expected.data),
  };
  for (let pixel = 0; pixel < 12; pixel++) {
    const offset = pixel * 4;
    close.data[offset] += 4;
    close.data[offset + 1] += 3;
  }
  const closeResult = comparePngBuffers({
    expectedPng: encodeRgbaPng(expected),
    actualPng: encodeRgbaPng(close),
    mode: 'pixel-tolerance',
    channelThreshold: 8,
    maxDifferentPixelRatio: 0.01,
    maxMeanDifference: 2,
  });
  assert.equal(closeResult.passed, true);
  assert.equal(closeResult.exactPixelIdentity, false);
  assert.equal(closeResult.differentPixelRatio, 0);
  assert.ok(closeResult.meanDifference > 0);
  assert.ok(closeResult.similarity > 0.99);

  const different = {
    ...expected,
    data: Buffer.from(expected.data),
  };
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const offset = (y * 16 + x) * 4;
      different.data[offset] = 240;
      different.data[offset + 1] = 20;
      different.data[offset + 2] = 20;
    }
  }
  const differentResult = comparePngBuffers({
    expectedPng: encodeRgbaPng(expected),
    actualPng: encodeRgbaPng(different),
    mode: 'pixel-tolerance',
    channelThreshold: 8,
    maxDifferentPixelRatio: 0.05,
    maxMeanDifference: 8,
    regionSize: 8,
    regionDifferenceRatioThreshold: 0.1,
  });
  assert.equal(differentResult.passed, false);
  assert.ok(differentResult.differentPixelRatio >= 0.24);
  assert.ok(differentResult.maxDifference > 100);
  assert.ok(differentResult.divergentRegions.length >= 1);
  assert.deepEqual(
    Object.keys(differentResult.divergentRegions[0]).sort(),
    [
      'differenceRatio',
      'height',
      'maxDifference',
      'meanDifference',
      'severity',
      'width',
      'x',
      'y',
    ].sort()
  );
});

test('perceptual mode uses block luminance similarity and optional internal downscale', () => {
  const expected = makeImage(32, 32, [120, 120, 120, 255]);
  const close = {
    ...expected,
    data: Buffer.from(expected.data),
  };
  for (let pixel = 0; pixel < 32 * 32; pixel++) {
    const offset = pixel * 4;
    close.data[offset] += 2;
    close.data[offset + 1] += 2;
    close.data[offset + 2] += 2;
  }
  const closeResult = comparePngBuffers({
    expectedPng: encodeRgbaPng(expected),
    actualPng: encodeRgbaPng(close),
    mode: 'perceptual',
    minSimilarity: 0.98,
    perceptualDownscale: 8,
  });
  assert.equal(closeResult.passed, true);
  assert.ok(closeResult.perceptualSimilarity > 0.99);
  assert.equal(closeResult.thresholds.perceptualDownscale, 8);

  const different = makeImage(32, 32, [245, 245, 245, 255]);
  const differentResult = comparePngBuffers({
    expectedPng: encodeRgbaPng(expected),
    actualPng: encodeRgbaPng(different),
    mode: 'perceptual',
    minSimilarity: 0.9,
    perceptualDownscale: 4,
  });
  assert.equal(differentResult.passed, false);
  assert.ok(differentResult.perceptualSimilarity < 0.9);
});

test('optionally generates a valid PNG heatmap for divergent pixels', () => {
  const expected = makeImage(8, 8, [10, 20, 30, 255]);
  const actual = makeImage(8, 8, [200, 30, 30, 255]);
  const result = comparePngBuffers({
    expectedPng: encodeRgbaPng(expected),
    actualPng: encodeRgbaPng(actual),
    mode: 'pixel-tolerance',
    includeDiffImage: true,
  });
  assert.ok(Buffer.isBuffer(result.diffImageBuffer));
  const decoded = decodePng(result.diffImageBuffer);
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 8);
});
