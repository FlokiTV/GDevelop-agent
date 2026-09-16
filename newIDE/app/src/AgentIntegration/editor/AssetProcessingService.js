// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { AgentError } from '../core/AgentError';

const crypto = optionalRequire('crypto');
const fs = optionalRequire('fs');
const os = optionalRequire('os');
const path = optionalRequire('path');

const MAX_IMAGE_DIMENSION = 16384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_SPRITESHEET_FRAMES = 256;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;

const IMAGE_FORMATS = {
  png: { mime: 'image/png', extension: '.png' },
  jpeg: { mime: 'image/jpeg', extension: '.jpg' },
  webp: { mime: 'image/webp', extension: '.webp' },
};

const imageMimeFromPath = (filePath: string): string => {
  if (!path) return 'image/png';
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
};

const assertDimension = (value: any, field: string): number => {
  const number = Number(value);
  if (
    !Number.isInteger(number) ||
    number <= 0 ||
    number > MAX_IMAGE_DIMENSION
  ) {
    throw new AgentError({
      code: 'invalid_image_dimension',
      details: { field, value, maximum: MAX_IMAGE_DIMENSION },
    });
  }
  return number;
};

const assertPixelBudget = (width: number, height: number) => {
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new AgentError({
      code: 'image_pixel_budget_exceeded',
      details: { width, height, maximumPixels: MAX_IMAGE_PIXELS },
    });
  }
};

const loadBrowserImage = (buffer: any, mime: string): Promise<any> => {
  if (typeof Image === 'undefined') {
    return Promise.reject(
      new AgentError({
        code: 'image_processing_runtime_unavailable',
        recovery: 'Image processing requires the desktop renderer runtime.',
      })
    );
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new AgentError({ code: 'image_decode_failed' }));
    image.src = `data:${mime};base64,${buffer.toString('base64')}`;
  });
};

const createCanvas = (width: number, height: number): any => {
  if (typeof document === 'undefined') {
    throw new AgentError({
      code: 'image_processing_runtime_unavailable',
      recovery: 'Image processing requires the desktop renderer runtime.',
    });
  }
  assertPixelBudget(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const canvasToBuffer = (canvas: any, outputFormat: string, quality: number) => {
  const format = IMAGE_FORMATS[outputFormat];
  if (!format) {
    throw new AgentError({
      code: 'image_output_format_unsupported',
      details: { outputFormat },
    });
  }
  const dataUrl = canvas.toDataURL(format.mime, quality);
  if (!dataUrl.startsWith(`data:${format.mime};base64,`)) {
    throw new AgentError({
      code: 'image_output_format_unsupported',
      details: { outputFormat, actualMime: dataUrl.split(';')[0].slice(5) },
    });
  }
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
};

export const createBrowserImageAdapter = (): ?any => {
  if (typeof document === 'undefined' || typeof Image === 'undefined')
    return null;
  return {
    probe: async ({ buffer, inputMime }) => {
      const image = await loadBrowserImage(buffer, inputMime);
      return { width: image.naturalWidth, height: image.naturalHeight };
    },
    transform: async ({
      buffer,
      inputMime,
      crop,
      resize,
      pad,
      outputFormat,
      quality,
    }) => {
      const image = await loadBrowserImage(buffer, inputMime);
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = image.naturalWidth;
      let sourceHeight = image.naturalHeight;
      if (crop) {
        sourceX = Math.max(0, Math.round(Number(crop.x) || 0));
        sourceY = Math.max(0, Math.round(Number(crop.y) || 0));
        sourceWidth = assertDimension(crop.width, 'crop.width');
        sourceHeight = assertDimension(crop.height, 'crop.height');
        if (
          sourceX + sourceWidth > image.naturalWidth ||
          sourceY + sourceHeight > image.naturalHeight
        ) {
          throw new AgentError({
            code: 'image_crop_out_of_bounds',
            details: {
              sourceWidth: image.naturalWidth,
              sourceHeight: image.naturalHeight,
              crop: {
                x: sourceX,
                y: sourceY,
                width: sourceWidth,
                height: sourceHeight,
              },
            },
          });
        }
      }

      let outputWidth = sourceWidth;
      let outputHeight = sourceHeight;
      if (resize) {
        const hasWidth = resize.width !== undefined && resize.width !== null;
        const hasHeight = resize.height !== undefined && resize.height !== null;
        if (!hasWidth && !hasHeight) {
          throw new AgentError({ code: 'image_resize_dimension_required' });
        }
        if (hasWidth)
          outputWidth = assertDimension(resize.width, 'resize.width');
        if (hasHeight)
          outputHeight = assertDimension(resize.height, 'resize.height');
        if (hasWidth && !hasHeight) {
          outputHeight = Math.max(
            1,
            Math.round((sourceHeight * outputWidth) / sourceWidth)
          );
        } else if (!hasWidth && hasHeight) {
          outputWidth = Math.max(
            1,
            Math.round((sourceWidth * outputHeight) / sourceHeight)
          );
        }
      }
      assertPixelBudget(outputWidth, outputHeight);

      const padding = {
        top: pad ? Math.max(0, Math.round(Number(pad.top) || 0)) : 0,
        right: pad ? Math.max(0, Math.round(Number(pad.right) || 0)) : 0,
        bottom: pad ? Math.max(0, Math.round(Number(pad.bottom) || 0)) : 0,
        left: pad ? Math.max(0, Math.round(Number(pad.left) || 0)) : 0,
      };
      const finalWidth = outputWidth + padding.left + padding.right;
      const finalHeight = outputHeight + padding.top + padding.bottom;
      assertDimension(finalWidth, 'output.width');
      assertDimension(finalHeight, 'output.height');
      assertPixelBudget(finalWidth, finalHeight);

      const canvas = createCanvas(finalWidth, finalHeight);
      const context = canvas.getContext('2d');
      if (!context) throw new AgentError({ code: 'image_canvas_unavailable' });
      if (
        pad &&
        typeof pad.backgroundColor === 'string' &&
        pad.backgroundColor
      ) {
        context.fillStyle = pad.backgroundColor;
        context.fillRect(0, 0, finalWidth, finalHeight);
      }
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        padding.left,
        padding.top,
        outputWidth,
        outputHeight
      );
      return {
        buffer: canvasToBuffer(canvas, outputFormat, quality),
        width: finalWidth,
        height: finalHeight,
        mime: IMAGE_FORMATS[outputFormat].mime,
      };
    },
  };
};

const requireFilesystem = () => {
  if (!fs || !os || !path || !crypto) {
    throw new AgentError({
      code: 'asset_processing_runtime_unavailable',
      recovery: 'Asset processing requires the Electron/Node desktop runtime.',
    });
  }
};

const requireLocalResource = (assetTools: any, name: any, kind: string) => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new AgentError({ code: 'missing_resource_name' });
  }
  const resource = assetTools.inspectResource(name.trim());
  if (resource.kind !== kind) {
    throw new AgentError({
      code: 'resource_kind_mismatch',
      details: { expected: kind, actual: resource.kind },
    });
  }
  if (
    !resource.isLocalFile ||
    !resource.localFilePath ||
    !resource.fileExists
  ) {
    throw new AgentError({
      code: 'asset_processing_requires_local_resource',
      hint:
        'Use resources.import-url first for remote resources, or import/copy the source into the local project.',
      details: { resourceName: name },
    });
  }
  return resource;
};

const makeTempFile = (buffer: any, extension: string): any => {
  requireFilesystem();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-agent-process-')
  );
  const filePath = path.join(directory, `output${extension}`);
  fs.writeFileSync(filePath, buffer);
  return { directory, filePath };
};

const removeTemp = temporary => {
  if (!fs || !temporary) return;
  try {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  } catch (error) {}
};

const sha256 = buffer => {
  requireFilesystem();
  return crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');
};

const makeTransformProvenance = ({ source, operation, output }: any) => ({
  schema: 'gdevelop-agent-resource-provenance/v1',
  source: 'agent-transform',
  sourceResourceName: source.name,
  sourceOrigin: {
    name: source.originName || null,
    identifier: source.originIdentifier || null,
  },
  operation,
  sha256: sha256(output.buffer),
  byteLength: output.buffer.length,
  contentType: output.mime,
});

const importProcessedOutput = async ({
  assetTools,
  source,
  outputResourceName,
  output,
  kind,
  overwrite,
  operation,
}: any) => {
  const extension =
    kind === 'image'
      ? Object.values(IMAGE_FORMATS).find(item => item.mime === output.mime)
          .extension
      : '.wav';
  const temporary = makeTempFile(output.buffer, extension);
  const provenance = makeTransformProvenance({ source, operation, output });
  try {
    if (outputResourceName === source.name) {
      const replaced = await assetTools.replaceLocalResource({
        resourceName: source.name,
        filePath: temporary.filePath,
        kind,
        copyToProject: true,
        deletePreviousFile: false,
        origin: { name: 'agent-transform', identifier: source.name },
        provenance,
      });
      return { ...replaced, outputResourceName, provenance };
    }
    const imported = await assetTools.importLocalResource({
      filePath: temporary.filePath,
      resourceName: outputResourceName,
      kind,
      copyToProject: true,
      overwrite: !!overwrite,
      origin: { name: 'agent-transform', identifier: source.name },
      provenance,
    });
    return { ...imported, outputResourceName, provenance };
  } finally {
    removeTemp(temporary);
  }
};

const parseWavPcm16 = (buffer: any): any => {
  if (!buffer || buffer.length < 44) {
    throw new AgentError({ code: 'audio_wav_invalid' });
  }
  if (
    buffer.slice(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.slice(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new AgentError({
      code: 'audio_processing_format_unsupported',
      details: { supportedInput: 'PCM 16-bit WAV' },
    });
  }
  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.slice(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + size > buffer.length) break;
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(payloadOffset),
        channels: buffer.readUInt16LE(payloadOffset + 2),
        sampleRate: buffer.readUInt32LE(payloadOffset + 4),
        bitsPerSample: buffer.readUInt16LE(payloadOffset + 14),
      };
    } else if (id === 'data') {
      dataOffset = payloadOffset;
      dataLength = size;
      break;
    }
    offset = payloadOffset + size + (size % 2);
  }
  if (
    !format ||
    format.audioFormat !== 1 ||
    format.bitsPerSample !== 16 ||
    format.channels < 1 ||
    format.channels > 8 ||
    !format.sampleRate ||
    dataOffset < 0
  ) {
    throw new AgentError({
      code: 'audio_processing_format_unsupported',
      details: { supportedInput: 'PCM 16-bit WAV' },
    });
  }
  const usableDataLength = dataLength - (dataLength % (format.channels * 2));
  const samples = new Int16Array(usableDataLength / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = buffer.readInt16LE(dataOffset + index * 2);
  }
  return { ...format, samples };
};

const encodeWavPcm16 = ({ channels, sampleRate, samples }: any): any => {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index++) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }
  return buffer;
};

export const transformWavPcm16 = (buffer: any, input: any): any => {
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new AgentError({
      code: 'audio_file_too_large',
      details: { byteLength: buffer.length, maximum: MAX_AUDIO_BYTES },
    });
  }
  const parsed = parseWavPcm16(buffer);
  const totalFrames = parsed.samples.length / parsed.channels;
  const totalMs = (totalFrames / parsed.sampleRate) * 1000;
  const startMs = Math.max(0, Number(input.trimStartMs) || 0);
  const endMs =
    input.trimEndMs === undefined || input.trimEndMs === null
      ? totalMs
      : Math.max(0, Number(input.trimEndMs));
  if (startMs >= endMs || endMs > totalMs + 0.01) {
    throw new AgentError({
      code: 'audio_trim_range_invalid',
      details: { startMs, endMs, totalMs },
    });
  }
  const startFrame = Math.min(
    totalFrames,
    Math.floor((startMs * parsed.sampleRate) / 1000)
  );
  const endFrame = Math.min(
    totalFrames,
    Math.ceil((endMs * parsed.sampleRate) / 1000)
  );
  const firstSample = startFrame * parsed.channels;
  const lastSample = endFrame * parsed.channels;
  const outputSamples = new Int16Array(lastSample - firstSample);
  outputSamples.set(parsed.samples.subarray(firstSample, lastSample));

  const normalize = input.normalize !== false;
  const targetPeakDb =
    input.targetPeakDb === undefined ? -1 : Number(input.targetPeakDb);
  if (
    !Number.isFinite(targetPeakDb) ||
    targetPeakDb > 0 ||
    targetPeakDb < -60
  ) {
    throw new AgentError({
      code: 'audio_target_peak_invalid',
      details: { targetPeakDb },
    });
  }
  let peakBefore = 0;
  for (let index = 0; index < outputSamples.length; index++) {
    peakBefore = Math.max(peakBefore, Math.abs(outputSamples[index]));
  }
  let gain = 1;
  if (normalize && peakBefore > 0) {
    const targetPeak = 32767 * Math.pow(10, targetPeakDb / 20);
    gain = targetPeak / peakBefore;
    for (let index = 0; index < outputSamples.length; index++) {
      const scaled = Math.round(outputSamples[index] * gain);
      outputSamples[index] = Math.max(-32768, Math.min(32767, scaled));
    }
  }
  let peakAfter = 0;
  for (let index = 0; index < outputSamples.length; index++) {
    peakAfter = Math.max(peakAfter, Math.abs(outputSamples[index]));
  }
  const outputBuffer = encodeWavPcm16({
    channels: parsed.channels,
    sampleRate: parsed.sampleRate,
    samples: outputSamples,
  });
  return {
    buffer: outputBuffer,
    mime: 'audio/wav',
    durationMs: ((endFrame - startFrame) / parsed.sampleRate) * 1000,
    channels: parsed.channels,
    sampleRate: parsed.sampleRate,
    normalize,
    targetPeakDb,
    peakBefore,
    peakAfter,
    gain,
  };
};

type Options = {|
  project: gdProject,
  assetTools: any,
  imageAdapter?: ?any,
|};

export const createAssetProcessingService = ({
  project,
  assetTools,
  imageAdapter = createBrowserImageAdapter(),
}: Options) => {
  const requireSavedProject = () => {
    if (!project || !project.getProjectFile()) {
      throw new AgentError({
        code: 'asset_processing_requires_saved_project',
        hint:
          'Save the project locally before generating transformed resources.',
      });
    }
  };

  const capabilities = () => ({
    image: {
      supported: !!imageAdapter,
      operations: imageAdapter
        ? ['resize', 'crop', 'pad', 'spritesheet-slice']
        : [],
      formats: imageAdapter ? ['png', 'jpeg', 'webp'] : [],
      removeBackground: {
        supported: false,
        reason: 'no_trusted_local_segmentation_backend',
      },
      limits: {
        maxDimension: MAX_IMAGE_DIMENSION,
        maxPixels: MAX_IMAGE_PIXELS,
        maxSpritesheetFrames: MAX_SPRITESHEET_FRAMES,
      },
    },
    audio: {
      supported: !!fs,
      operations: fs ? ['trim', 'normalize'] : [],
      inputFormats: fs ? ['wav-pcm16'] : [],
      outputFormats: fs ? ['wav'] : [],
      compressedTranscode: {
        supported: false,
        reason: 'no_trusted_audio_encoder_toolchain',
      },
    },
    video: {
      supported: false,
      reason: 'no_trusted_video_processing_toolchain',
    },
    model3D: {
      supported: false,
      reason: 'no_trusted_model_processing_toolchain',
    },
  });

  const transformImage = async (input: any) => {
    requireSavedProject();
    if (!imageAdapter) {
      throw new AgentError({ code: 'image_processing_runtime_unavailable' });
    }
    const source = requireLocalResource(
      assetTools,
      input.sourceResourceName,
      'image'
    );
    const outputResourceName =
      typeof input.outputResourceName === 'string'
        ? input.outputResourceName.trim()
        : '';
    if (!outputResourceName) {
      throw new AgentError({ code: 'missing_output_resource_name' });
    }
    requireFilesystem();
    const sourceBuffer = fs.readFileSync(source.localFilePath);
    const outputFormat = IMAGE_FORMATS[input.outputFormat]
      ? input.outputFormat
      : 'png';
    const quality =
      input.quality === undefined
        ? 0.92
        : Math.min(1, Math.max(0.05, Number(input.quality) || 0.92));
    const output = await imageAdapter.transform({
      buffer: sourceBuffer,
      inputMime: imageMimeFromPath(source.localFilePath),
      crop: input.crop || null,
      resize: input.resize || null,
      pad: input.pad || null,
      outputFormat,
      quality,
    });
    const operation = {
      type: 'image-transform',
      crop: input.crop || null,
      resize: input.resize || null,
      pad: input.pad || null,
      outputFormat,
      quality,
      width: output.width,
      height: output.height,
    };
    const imported = await importProcessedOutput({
      assetTools,
      source,
      outputResourceName,
      output,
      kind: 'image',
      overwrite: input.overwrite,
      operation,
    });
    return {
      transformed: true,
      sourceResourceName: source.name,
      outputResourceName,
      width: output.width,
      height: output.height,
      format: outputFormat,
      ...imported,
    };
  };

  const sliceSpritesheet = async (input: any) => {
    requireSavedProject();
    if (!imageAdapter) {
      throw new AgentError({ code: 'image_processing_runtime_unavailable' });
    }
    const source = requireLocalResource(
      assetTools,
      input.sourceResourceName,
      'image'
    );
    const prefix =
      typeof input.outputPrefix === 'string' ? input.outputPrefix.trim() : '';
    if (!prefix)
      throw new AgentError({ code: 'missing_output_resource_prefix' });
    const frameWidth = assertDimension(input.frameWidth, 'frameWidth');
    const frameHeight = assertDimension(input.frameHeight, 'frameHeight');
    const margin = Math.max(0, Math.round(Number(input.margin) || 0));
    const spacing = Math.max(0, Math.round(Number(input.spacing) || 0));
    requireFilesystem();
    const sourceBuffer = fs.readFileSync(source.localFilePath);
    const inputMime = imageMimeFromPath(source.localFilePath);
    const dimensions = await imageAdapter.probe({
      buffer: sourceBuffer,
      inputMime,
    });
    const maxColumns = Math.floor(
      (dimensions.width - margin * 2 + spacing) / (frameWidth + spacing)
    );
    const maxRows = Math.floor(
      (dimensions.height - margin * 2 + spacing) / (frameHeight + spacing)
    );
    const columns = input.columns
      ? Math.min(maxColumns, Math.max(1, Math.round(input.columns)))
      : maxColumns;
    const rows = input.rows
      ? Math.min(maxRows, Math.max(1, Math.round(input.rows)))
      : maxRows;
    if (columns < 1 || rows < 1) {
      throw new AgentError({ code: 'spritesheet_grid_empty' });
    }
    const frameCount = columns * rows;
    if (frameCount > MAX_SPRITESHEET_FRAMES) {
      throw new AgentError({
        code: 'spritesheet_frame_limit_exceeded',
        details: { frameCount, maximum: MAX_SPRITESHEET_FRAMES },
      });
    }
    const outputFormat = IMAGE_FORMATS[input.outputFormat]
      ? input.outputFormat
      : 'png';
    const outputs = [];
    const digits = Math.max(2, String(frameCount - 1).length);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        const output = await imageAdapter.transform({
          buffer: sourceBuffer,
          inputMime,
          crop: {
            x: margin + column * (frameWidth + spacing),
            y: margin + row * (frameHeight + spacing),
            width: frameWidth,
            height: frameHeight,
          },
          resize: null,
          pad: null,
          outputFormat,
          quality: 0.92,
        });
        const outputResourceName = `${prefix}${String(index).padStart(
          digits,
          '0'
        )}${IMAGE_FORMATS[outputFormat].extension}`;
        const imported = await importProcessedOutput({
          assetTools,
          source,
          outputResourceName,
          output,
          kind: 'image',
          overwrite: input.overwrite,
          operation: {
            type: 'spritesheet-slice',
            sourceResourceName: source.name,
            frameIndex: index,
            row,
            column,
            frameWidth,
            frameHeight,
            margin,
            spacing,
            columns,
            rows,
            outputFormat,
          },
        });
        outputs.push({
          index,
          row,
          column,
          outputResourceName,
          width: output.width,
          height: output.height,
          provenance: imported.provenance,
        });
      }
    }
    return {
      sliced: true,
      sourceResourceName: source.name,
      columns,
      rows,
      frameCount,
      outputs,
    };
  };

  const transformAudio = async (input: any) => {
    requireSavedProject();
    const source = requireLocalResource(
      assetTools,
      input.sourceResourceName,
      'audio'
    );
    const outputResourceName =
      typeof input.outputResourceName === 'string'
        ? input.outputResourceName.trim()
        : '';
    if (!outputResourceName) {
      throw new AgentError({ code: 'missing_output_resource_name' });
    }
    requireFilesystem();
    const sourceBuffer = fs.readFileSync(source.localFilePath);
    const output = transformWavPcm16(sourceBuffer, input);
    const operation = {
      type: 'audio-transform',
      trimStartMs: Math.max(0, Number(input.trimStartMs) || 0),
      trimEndMs:
        input.trimEndMs === undefined || input.trimEndMs === null
          ? null
          : Number(input.trimEndMs),
      normalize: input.normalize !== false,
      targetPeakDb:
        input.targetPeakDb === undefined ? -1 : Number(input.targetPeakDb),
      outputFormat: 'wav',
      durationMs: output.durationMs,
    };
    const imported = await importProcessedOutput({
      assetTools,
      source,
      outputResourceName,
      output,
      kind: 'audio',
      overwrite: input.overwrite,
      operation,
    });
    return {
      transformed: true,
      sourceResourceName: source.name,
      outputResourceName,
      durationMs: output.durationMs,
      channels: output.channels,
      sampleRate: output.sampleRate,
      gain: output.gain,
      peakBefore: output.peakBefore,
      peakAfter: output.peakAfter,
      ...imported,
    };
  };

  return {
    capabilities,
    transformImage,
    sliceSpritesheet,
    transformAudio,
  };
};

export const assetProcessingInternals = {
  encodeWavPcm16,
  imageMimeFromPath,
  parseWavPcm16,
  requireLocalResource,
};
