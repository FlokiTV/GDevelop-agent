// @flow
import { createAssetProcessingCommandDescriptors } from './AssetProcessingCommands';

describe('AgentIntegration AssetProcessingCommands', () => {
  it('exposes capability discovery and bounded long-running mutation descriptors', async () => {
    const assetProcessingService = {
      capabilities: jest.fn(() => ({ image: { supported: true } })),
      transformImage: jest.fn(async input => ({ transformed: true, input })),
      sliceSpritesheet: jest.fn(async input => ({ sliced: true, input })),
      transformAudio: jest.fn(async input => ({ transformed: true, input })),
    };
    const descriptors = createAssetProcessingCommandDescriptors({
      assetProcessingService,
    });

    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'resources.processing.capabilities',
      'resources.image.transform',
      'resources.image.slice-spritesheet',
      'resources.audio.transform',
    ]);
    expect(descriptors[0].metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
      modifiesProject: false,
    });
    descriptors.slice(1).forEach(descriptor =>
      expect(descriptor.metadata).toMatchObject({
        readOnly: false,
        destructive: true,
        idempotent: false,
        longRunning: true,
        requiresProject: true,
        modifiesProject: true,
        defaultTimeoutMs: 180000,
      })
    );
    expect(
      descriptors[1].inputSchema.properties.crop.properties.width.maximum
    ).toBe(16384);
    expect(descriptors[2].inputSchema.properties.columns.maximum).toBe(256);
    expect(descriptors[3].inputSchema.properties.targetPeakDb.minimum).toBe(
      -60
    );

    expect(await descriptors[0].execute({ input: {} })).toEqual({
      image: { supported: true },
    });
    await descriptors[1].execute({
      input: { sourceResourceName: 'a.png', outputResourceName: 'b.png' },
    });
    await descriptors[2].execute({
      input: {
        sourceResourceName: 'sheet.png',
        outputPrefix: 'frame-',
        frameWidth: 16,
        frameHeight: 16,
      },
    });
    await descriptors[3].execute({
      input: { sourceResourceName: 'a.wav', outputResourceName: 'b.wav' },
    });

    expect(assetProcessingService.capabilities).toHaveBeenCalledTimes(1);
    expect(assetProcessingService.transformImage).toHaveBeenCalledTimes(1);
    expect(assetProcessingService.sliceSpritesheet).toHaveBeenCalledTimes(1);
    expect(assetProcessingService.transformAudio).toHaveBeenCalledTimes(1);
  });
});
