// @flow
import { createObjectStructureCommandDescriptors } from './ObjectStructureCommands';

const makeService = () => ({
  capabilities: jest.fn(() => ({ capability: { structural: true } })),
  inspect: jest.fn(() => ({ structure: { kind: 'sprite' } })),
  apply: jest.fn(() => ({ applied: true })),
});

describe('AgentIntegration ObjectStructureCommands', () => {
  it('exposes read discovery/inspection and a destructive structural mutation', async () => {
    const service = makeService();
    const descriptors = createObjectStructureCommandDescriptors({
      objectStructureService: service,
    });
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'objects.structure.capabilities',
      'objects.structure.inspect',
      'objects.structure.apply',
    ]);

    const capabilities = descriptors[0];
    const inspect = descriptors[1];
    const apply = descriptors[2];
    expect(capabilities.metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
    });
    expect(inspect.metadata.readOnly).toBe(true);
    expect(apply.metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      modifiesProject: true,
    });
    expect(apply.inputSchema.required).toEqual(['objectName', 'structure']);

    await capabilities.execute({ input: { objectType: 'Sprite' } });
    await inspect.execute({
      input: { sceneName: 'Game', objectName: 'Player' },
    });
    await apply.execute({
      input: {
        sceneName: 'Game',
        objectName: 'Player',
        structure: { kind: 'sprite', animations: [] },
      },
    });
    expect(service.capabilities).toHaveBeenCalledWith({ objectType: 'Sprite' });
    expect(service.inspect).toHaveBeenCalledTimes(1);
    expect(service.apply).toHaveBeenCalledTimes(1);
  });
});
