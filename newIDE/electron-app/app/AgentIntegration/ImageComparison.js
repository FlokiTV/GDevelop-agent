const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DECODED_PIXELS = 20 * 1024 * 1024;

const makeError = (code, details) => {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const clampNumber = (value, fallback, minimum, maximum) => {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw makeError('invalid_visual_comparison_threshold', {
      value,
      minimum,
      maximum,
    });
  }
  return number;
};

const clampInteger = (value, fallback, minimum, maximum) =>
  Math.round(clampNumber(value, fallback, minimum, maximum));

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = buffer => {
  let c = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    c = crcTable[(c ^ buffer[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const makeChunk = (type, data) => {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
};

const encodeRgbaPng = ({ width, height, data }) => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Buffer.isBuffer(data) ||
    data.length !== width * height * 4
  ) {
    throw makeError('invalid_rgba_image');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const destinationOffset = y * (1 + width * 4);
    scanlines[destinationOffset] = 0;
    data.copy(
      scanlines,
      destinationOffset + 1,
      y * width * 4,
      (y + 1) * width * 4
    );
  }
  const idat = zlib.deflateSync(scanlines, { level: 6 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
};

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

const decodePng = png => {
  if (
    !Buffer.isBuffer(png) ||
    png.length < PNG_SIGNATURE.length ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw makeError('visual_comparison_invalid_png');
  }

  let offset = PNG_SIGNATURE.length;
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  const idatChunks = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) {
      throw makeError('visual_comparison_invalid_png_chunk');
    }
    const data = png.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (length !== 13) throw makeError('visual_comparison_invalid_png_ihdr');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height || !idatChunks.length) {
    throw makeError('visual_comparison_invalid_png');
  }
  if (width * height > MAX_DECODED_PIXELS) {
    throw makeError('visual_comparison_image_too_large', {
      width,
      height,
      maxPixels: MAX_DECODED_PIXELS,
    });
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw makeError('visual_comparison_png_format_unsupported', {
      bitDepth,
      colorType,
      interlace,
    });
  }

  const channels =
    colorType === 6
      ? 4
      : colorType === 2
      ? 3
      : colorType === 4
      ? 2
      : colorType === 0
      ? 1
      : null;
  if (!channels) {
    throw makeError('visual_comparison_png_color_type_unsupported', {
      colorType,
    });
  }

  const rowBytes = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedLength = height * (1 + rowBytes);
  if (raw.length !== expectedLength) {
    throw makeError('visual_comparison_invalid_png_data_length', {
      expectedLength,
      actualLength: raw.length,
    });
  }

  const unfiltered = Buffer.alloc(height * rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[sourceOffset++];
    const rowOffset = y * rowBytes;
    const priorOffset = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const encoded = raw[sourceOffset++];
      const left = x >= channels ? unfiltered[rowOffset + x - channels] : 0;
      const up = y > 0 ? unfiltered[priorOffset + x] : 0;
      const upLeft =
        y > 0 && x >= channels
          ? unfiltered[priorOffset + x - channels]
          : 0;
      let value;
      if (filter === 0) value = encoded;
      else if (filter === 1) value = encoded + left;
      else if (filter === 2) value = encoded + up;
      else if (filter === 3) value = encoded + Math.floor((left + up) / 2);
      else if (filter === 4) value = encoded + paeth(left, up, upLeft);
      else {
        throw makeError('visual_comparison_png_filter_unsupported', { filter });
      }
      unfiltered[rowOffset + x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (colorType === 6) {
      rgba[target] = unfiltered[source];
      rgba[target + 1] = unfiltered[source + 1];
      rgba[target + 2] = unfiltered[source + 2];
      rgba[target + 3] = unfiltered[source + 3];
    } else if (colorType === 2) {
      rgba[target] = unfiltered[source];
      rgba[target + 1] = unfiltered[source + 1];
      rgba[target + 2] = unfiltered[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = unfiltered[source];
      rgba[target + 1] = unfiltered[source];
      rgba[target + 2] = unfiltered[source];
      rgba[target + 3] = unfiltered[source + 1];
    } else {
      rgba[target] = unfiltered[source];
      rgba[target + 1] = unfiltered[source];
      rgba[target + 2] = unfiltered[source];
      rgba[target + 3] = 255;
    }
  }

  return { width, height, data: rgba };
};

const pixelDifference = (expected, actual, offset) =>
  Math.max(
    Math.abs(expected[offset] - actual[offset]),
    Math.abs(expected[offset + 1] - actual[offset + 1]),
    Math.abs(expected[offset + 2] - actual[offset + 2]),
    Math.abs(expected[offset + 3] - actual[offset + 3])
  );

const luminance = (data, offset) =>
  0.2126 * data[offset] +
  0.7152 * data[offset + 1] +
  0.0722 * data[offset + 2];

const calculatePerceptualSimilarity = (
  expected,
  actual,
  width,
  height,
  blockSize
) => {
  let totalDifference = 0;
  let blocks = 0;
  for (let y0 = 0; y0 < height; y0 += blockSize) {
    for (let x0 = 0; x0 < width; x0 += blockSize) {
      const x1 = Math.min(width, x0 + blockSize);
      const y1 = Math.min(height, y0 + blockSize);
      let expectedLuminance = 0;
      let actualLuminance = 0;
      let samples = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * width + x) * 4;
          expectedLuminance += luminance(expected, offset);
          actualLuminance += luminance(actual, offset);
          samples += 1;
        }
      }
      if (!samples) continue;
      totalDifference += Math.abs(
        expectedLuminance / samples - actualLuminance / samples
      );
      blocks += 1;
    }
  }
  if (!blocks) return 1;
  return Math.max(0, 1 - totalDifference / blocks / 255);
};

const calculateRegions = ({
  expected,
  actual,
  width,
  height,
  channelThreshold,
  regionSize,
  minDifferenceRatio,
  maxRegions,
}) => {
  const regions = [];
  for (let y0 = 0; y0 < height; y0 += regionSize) {
    for (let x0 = 0; x0 < width; x0 += regionSize) {
      const x1 = Math.min(width, x0 + regionSize);
      const y1 = Math.min(height, y0 + regionSize);
      let different = 0;
      let differenceSum = 0;
      let maxDifference = 0;
      const pixels = (x1 - x0) * (y1 - y0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * width + x) * 4;
          const difference = pixelDifference(expected, actual, offset);
          differenceSum += difference;
          if (difference > maxDifference) maxDifference = difference;
          if (difference > channelThreshold) different += 1;
        }
      }
      const differenceRatio = pixels ? different / pixels : 0;
      if (differenceRatio < minDifferenceRatio) continue;
      const meanDifference = pixels ? differenceSum / pixels : 0;
      regions.push({
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        differenceRatio,
        meanDifference,
        maxDifference,
        severity: Math.min(
          1,
          differenceRatio * 0.7 + (meanDifference / 255) * 0.3
        ),
      });
    }
  }
  regions.sort((a, b) => b.severity - a.severity);
  return regions.slice(0, maxRegions);
};

const makeHeatmap = ({ expected, actual, width, height }) => {
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    const difference = pixelDifference(expected, actual, offset);
    rgba[offset] = difference;
    rgba[offset + 1] = Math.max(0, 255 - Math.min(255, difference * 4));
    rgba[offset + 2] = 0;
    rgba[offset + 3] = 255;
  }
  return encodeRgbaPng({ width, height, data: rgba });
};

const comparePngBuffers = ({
  expectedPng,
  actualPng,
  mode = 'exact',
  channelThreshold,
  maxDifferentPixelRatio,
  maxMeanDifference,
  minSimilarity,
  perceptualDownscale,
  regionSize,
  regionDifferenceRatioThreshold,
  maxRegions,
  includeDiffImage = false,
}) => {
  if (!['exact', 'pixel-tolerance', 'perceptual'].includes(mode)) {
    throw makeError('visual_comparison_mode_unsupported', { mode });
  }

  const expected = decodePng(expectedPng);
  const actual = decodePng(actualPng);
  const exactPngIdentity = expectedPng.equals(actualPng);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      mode,
      passed: false,
      exactPngIdentity,
      exactPixelIdentity: false,
      sizeMismatch: true,
      expectedSize: { width: expected.width, height: expected.height },
      actualSize: { width: actual.width, height: actual.height },
      similarity: 0,
      differentPixelRatio: 1,
      meanDifference: 255,
      maxDifference: 255,
      divergentRegions: [
        {
          x: 0,
          y: 0,
          width: Math.max(expected.width, actual.width),
          height: Math.max(expected.height, actual.height),
          differenceRatio: 1,
          meanDifference: 255,
          maxDifference: 255,
          severity: 1,
        },
      ],
    };
  }

  const threshold = clampInteger(
    channelThreshold,
    mode === 'pixel-tolerance' ? 8 : 0,
    0,
    255
  );
  const ratioLimit = clampNumber(
    maxDifferentPixelRatio,
    mode === 'pixel-tolerance' ? 0.01 : mode === 'exact' ? 0 : 1,
    0,
    1
  );
  const meanLimit = clampNumber(
    maxMeanDifference,
    mode === 'pixel-tolerance' ? 4 : mode === 'exact' ? 0 : 255,
    0,
    255
  );
  const similarityLimit = clampNumber(
    minSimilarity,
    mode === 'perceptual' ? 0.98 : 0,
    0,
    1
  );
  const blockSize = clampInteger(perceptualDownscale, 4, 1, 32);
  const tileSize = clampInteger(regionSize, 32, 4, 256);
  const regionThreshold = clampNumber(
    regionDifferenceRatioThreshold,
    0.02,
    0,
    1
  );
  const regionLimit = clampInteger(maxRegions, 12, 0, 64);

  const pixels = expected.width * expected.height;
  let differentPixels = 0;
  let differenceSum = 0;
  let maxDifferenceValue = 0;
  let exactPixelIdentity = true;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    const difference = pixelDifference(expected.data, actual.data, offset);
    if (difference !== 0) exactPixelIdentity = false;
    if (difference > threshold) differentPixels += 1;
    differenceSum += difference;
    if (difference > maxDifferenceValue) maxDifferenceValue = difference;
  }
  const differentPixelRatio = pixels ? differentPixels / pixels : 0;
  const meanDifference = pixels ? differenceSum / pixels : 0;
  const pixelSimilarity = Math.max(0, 1 - meanDifference / 255);
  const perceptualSimilarity = calculatePerceptualSimilarity(
    expected.data,
    actual.data,
    expected.width,
    expected.height,
    blockSize
  );
  const similarity =
    mode === 'perceptual' ? perceptualSimilarity : pixelSimilarity;

  const passed =
    mode === 'exact'
      ? exactPngIdentity
      : mode === 'pixel-tolerance'
      ? differentPixelRatio <= ratioLimit && meanDifference <= meanLimit
      : perceptualSimilarity >= similarityLimit &&
        differentPixelRatio <= ratioLimit &&
        meanDifference <= meanLimit;

  const divergentRegions = calculateRegions({
    expected: expected.data,
    actual: actual.data,
    width: expected.width,
    height: expected.height,
    channelThreshold: threshold,
    regionSize: tileSize,
    minDifferenceRatio: regionThreshold,
    maxRegions: regionLimit,
  });

  return {
    mode,
    passed,
    exactPngIdentity,
    exactPixelIdentity,
    sizeMismatch: false,
    expectedSize: { width: expected.width, height: expected.height },
    actualSize: { width: actual.width, height: actual.height },
    thresholds: {
      channelThreshold: threshold,
      maxDifferentPixelRatio: ratioLimit,
      maxMeanDifference: meanLimit,
      minSimilarity: similarityLimit,
      perceptualDownscale: blockSize,
      regionSize: tileSize,
      regionDifferenceRatioThreshold: regionThreshold,
      maxRegions: regionLimit,
    },
    similarity,
    pixelSimilarity,
    perceptualSimilarity,
    differentPixelRatio,
    meanDifference,
    maxDifference: maxDifferenceValue,
    divergentRegions,
    ...(includeDiffImage
      ? {
          diffImageBuffer: makeHeatmap({
            expected: expected.data,
            actual: actual.data,
            width: expected.width,
            height: expected.height,
          }),
        }
      : {}),
  };
};

module.exports = {
  comparePngBuffers,
  decodePng,
  encodeRgbaPng,
};
