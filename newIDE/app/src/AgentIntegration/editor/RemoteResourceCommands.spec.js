// @flow
import { createRemoteResourceCommandDescriptors } from './RemoteResourceCommands';

describe('AgentIntegration RemoteResourceCommands', () => {
  it('exposes bounded long-running import and destructive replace descriptors', async () => {
    const remoteResourceService = {
      importUrl: jest.fn(async input => ({ imported: true, input })),
      replaceUrl: jest.fn(async input => ({ replaced: true, input })),
    };
    const descriptors = createRemoteResourceCommandDescriptors({
      remoteResourceService,
    });
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'resources.import-url',
      'resources.replace-url',
    ]);
    expect(descriptors[0].metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      longRunning: true,
      modifiesProject: true,
    });
    expect(descriptors[1].metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      longRunning: true,
      modifiesProject: true,
    });
    expect(descriptors[0].inputSchema.properties.maxBytes.maximum).toBe(
      268435456
    );
    expect(descriptors[0].inputSchema.properties.maxRedirects.maximum).toBe(10);
    expect(descriptors[0].inputSchema.properties.expectedSha256.pattern).toBe(
      '^[a-fA-F0-9]{64}$'
    );

    await descriptors[0].execute({
      input: { url: 'https://example.com/a.png' },
    });
    await descriptors[1].execute({
      input: {
        url: 'https://example.com/a.png',
        resourceName: 'a.png',
      },
    });
    expect(remoteResourceService.importUrl).toHaveBeenCalledTimes(1);
    expect(remoteResourceService.replaceUrl).toHaveBeenCalledTimes(1);
  });
});
