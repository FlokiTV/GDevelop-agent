// @flow
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assetProcessingInternals,
  createAssetProcessingService,
  transformWavPcm16,
} from './AssetProcessingService';

const makeProject = projectFolder => ({
  getProjectFile: () => path.join(projectFolder, 'game.json'),
});

const makeLocalResource = ({ name, kind, localFilePath }) => ({
  name,
  kind,
  isLocalFile: true,
  localFilePath,
  fileExists: true,
  originName: 'local-file',
  originIdentifier: name,
});

const makeWav = ({ samples, sampleRate = 1000, channels = 1 }) =>
  assetProcessingInternals.encodeWavPcm16({
    channels,
    sampleRate,
    samples: Int16Array.from(samples),
  });

describe('AgentIntegration AssetProcessingService', () => {
  it('reports supported deterministic transforms and explicit unsupported toolchain gaps', () => {
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-processing-capabilities-')
    );
    const service = createAssetProcessingService({
      // $FlowFixMe[incompatible-type]
      project: makeProject(projectFolder),
      assetTools: {},
      imageAdapter: { probe: jest.fn(), transform: jest.fn() },
    });

    expect(service.capabilities()).toMatchObject({
      image: {
        supported: true,
        operations: ['resize', 'crop', 'pad', 'spritesheet-slice'],
        removeBackground: { supported: false },
        limits: { maxDimension: 16384, maxSpritesheetFrames: 256 },
      },
      audio: {
        supported: true,
        operations: ['trim', 'normalize'],
        compressedTranscode: { supported: false },
      },
      video: { supported: false },
      model3D: { supported: false },
    });
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('applies crop/resize/pad through the injected image adapter and persists transform provenance/hash', async () => {
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-processing-image-')
    );
    const sourcePath = path.join(projectFolder, 'source.png');
    fs.writeFileSync(sourcePath, Buffer.from('source-image'));
    const outputBuffer = Buffer.from('processed-image');
    const imageAdapter = {
      probe: jest.fn(),
      transform: jest.fn(async request => ({
        buffer: outputBuffer,
        width: 24,
        height: 14,
        mime: 'image/png',
      })),
    };
    let temporaryPath = null;
    const importLocalResource = jest.fn(async request => {
      temporaryPath = request.filePath;
      expect(fs.existsSync(request.filePath)).toBe(true);
      expect(request.copyToProject).toBe(true);
      expect(request.provenance).toMatchObject({
        schema: 'gdevelop-agent-resource-provenance/v1',
        source: 'agent-transform',
        sourceResourceName: 'source.png',
        contentType: 'image/png',
        byteLength: outputBuffer.length,
        operation: {
          type: 'image-transform',
          width: 24,
          height: 14,
        },
      });
      expect(request.provenance.sha256).toBe(
        crypto
          .createHash('sha256')
          .update(outputBuffer)
          .digest('hex')
      );
      return { imported: true, resource: { name: request.resourceName } };
    });
    const service = createAssetProcessingService({
      // $FlowFixMe[incompatible-type]
      project: makeProject(projectFolder),
      assetTools: {
        inspectResource: jest.fn(() =>
          makeLocalResource({
            name: 'source.png',
            kind: 'image',
            localFilePath: sourcePath,
          })
        ),
        importLocalResource,
        replaceLocalResource: jest.fn(),
      },
      imageAdapter,
    });

    const input = {
      sourceResourceName: 'source.png',
      outputResourceName: 'processed.png',
      crop: { x: 1, y: 2, width: 10, height: 8 },
      resize: { width: 20, height: 10 },
      pad: { top: 1, right: 2, bottom: 3, left: 2 },
      outputFormat: 'png',
      quality: 0.8,
    };
    const result = await service.transformImage(input);

    expect(imageAdapter.transform).toHaveBeenCalledWith(
      expect.objectContaining({
        crop: input.crop,
        resize: input.resize,
        pad: input.pad,
        outputFormat: 'png',
        quality: 0.8,
      })
    );
    expect(result).toMatchObject({
      transformed: true,
      sourceResourceName: 'source.png',
      outputResourceName: 'processed.png',
      width: 24,
      height: 14,
      format: 'png',
    });
    expect(importLocalResource).toHaveBeenCalledTimes(1);
    expect(temporaryPath).not.toBeNull();
    expect(fs.existsSync(temporaryPath)).toBe(false);
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('slices bounded spritesheets deterministically and rejects more than 256 frames', async () => {
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-processing-sheet-')
    );
    const sourcePath = path.join(projectFolder, 'sheet.png');
    fs.writeFileSync(sourcePath, Buffer.from('sheet'));
    const assetTools = {
      inspectResource: jest.fn(() =>
        makeLocalResource({
          name: 'sheet.png',
          kind: 'image',
          localFilePath: sourcePath,
        })
      ),
      importLocalResource: jest.fn(async request => ({
        imported: true,
        resource: { name: request.resourceName },
      })),
      replaceLocalResource: jest.fn(),
    };
    const imageAdapter = {
      probe: jest.fn(async () => ({ width: 32, height: 16 })),
      transform: jest.fn(async request => ({
        buffer: Buffer.from(`frame-${request.crop.x}`),
        width: request.crop.width,
        height: request.crop.height,
        mime: 'image/png',
      })),
    };
    const service = createAssetProcessingService({
      // $FlowFixMe[incompatible-type]
      project: makeProject(projectFolder),
      assetTools,
      imageAdapter,
    });

    const result = await service.sliceSpritesheet({
      sourceResourceName: 'sheet.png',
      outputPrefix: 'frame-',
      frameWidth: 16,
      frameHeight: 16,
    });
    expect(result).toMatchObject({
      sliced: true,
      columns: 2,
      rows: 1,
      frameCount: 2,
    });
    expect(result.outputs.map(output => output.outputResourceName)).toEqual([
      'frame-00.png',
      'frame-01.png',
    ]);
    expect(imageAdapter.transform).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ crop: { x: 16, y: 0, width: 16, height: 16 } })
    );

    imageAdapter.probe.mockResolvedValueOnce({ width: 272, height: 272 });
    await expect(
      service.sliceSpritesheet({
        sourceResourceName: 'sheet.png',
        outputPrefix: 'too-many-',
        frameWidth: 16,
        frameHeight: 16,
      })
    ).rejects.toMatchObject({ code: 'spritesheet_frame_limit_exceeded' });
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('trims and peak-normalizes PCM16 WAV deterministically', () => {
    const source = makeWav({
      samples: Array.from({ length: 100 }, (_, index) =>
        index % 2 === 0 ? 1000 : -2000
      ),
    });
    const output = transformWavPcm16(source, {
      trimStartMs: 10,
      trimEndMs: 50,
      normalize: true,
      targetPeakDb: -6,
    });
    const parsed = assetProcessingInternals.parseWavPcm16(output.buffer);

    expect(output.durationMs).toBe(40);
    expect(parsed.samples).toHaveLength(40);
    expect(output.peakBefore).toBe(2000);
    expect(output.gain).toBeGreaterThan(1);
    expect(output.peakAfter).toBeGreaterThan(16000);
    expect(output.peakAfter).toBeLessThan(17000);
  });

  it('imports transformed WAV output with deterministic provenance and requires a saved project', async () => {
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-processing-audio-')
    );
    const sourcePath = path.join(projectFolder, 'source.wav');
    fs.writeFileSync(
      sourcePath,
      makeWav({ samples: [1000, -1000, 2000, -2000], sampleRate: 1000 })
    );
    const importLocalResource = jest.fn(async request => ({
      imported: true,
      resource: { name: request.resourceName },
      provenancePersisted: true,
    }));
    const assetTools = {
      inspectResource: jest.fn(() =>
        makeLocalResource({
          name: 'source.wav',
          kind: 'audio',
          localFilePath: sourcePath,
        })
      ),
      importLocalResource,
      replaceLocalResource: jest.fn(),
    };
    const service = createAssetProcessingService({
      // $FlowFixMe[incompatible-type]
      project: makeProject(projectFolder),
      assetTools,
      imageAdapter: null,
    });

    const result = await service.transformAudio({
      sourceResourceName: 'source.wav',
      outputResourceName: 'normalized.wav',
      normalize: true,
      targetPeakDb: -1,
    });
    expect(result).toMatchObject({
      transformed: true,
      outputResourceName: 'normalized.wav',
      sampleRate: 1000,
      provenancePersisted: true,
    });
    expect(importLocalResource).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceName: 'normalized.wav',
        kind: 'audio',
        copyToProject: true,
        provenance: expect.objectContaining({
          source: 'agent-transform',
          sourceResourceName: 'source.wav',
          contentType: 'audio/wav',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          operation: expect.objectContaining({ type: 'audio-transform' }),
        }),
      })
    );

    const unsaved = createAssetProcessingService({
      // $FlowFixMe[incompatible-type]
      project: { getProjectFile: () => '' },
      assetTools,
      imageAdapter: null,
    });
    await expect(
      unsaved.transformAudio({
        sourceResourceName: 'source.wav',
        outputResourceName: 'x.wav',
      })
    ).rejects.toMatchObject({
      code: 'asset_processing_requires_saved_project',
    });
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });
});
