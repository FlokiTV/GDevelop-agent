// @flow
import { createBuildCommandDescriptors } from './BuildCommands';

describe('AgentIntegration BuildCommands', () => {
  const buildService = {
    listTargets: jest.fn(() => ({ targets: [] })),
    inspectConfiguration: jest.fn(() => ({})),
    applyConfiguration: jest.fn(input => ({ changed: true, input })),
    start: jest.fn(async input => ({ started: true, input })),
    status: jest.fn(async input => ({ build: input })),
    cancel: jest.fn(async input => ({ cancelled: false, input })),
    result: jest.fn(async input => ({ ready: false, input })),
  };
  const descriptors = createBuildCommandDescriptors({ buildService });
  const byName = name =>
    descriptors.find(descriptor => descriptor.name === name);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes the complete CAP-14 lifecycle with accurate metadata', () => {
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'build.targets.list',
      'build.configuration.inspect',
      'build.configuration.apply',
      'build.start',
      'build.status',
      'build.cancel',
      'build.result',
    ]);
    expect(byName('build.targets.list').metadata).toMatchObject({
      readOnly: true,
      requiresProject: false,
      modifiesProject: false,
    });
    expect(byName('build.configuration.apply').metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: true,
      requiresProject: true,
      modifiesProject: true,
    });
    expect(byName('build.start').metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
    });
    expect(byName('build.status').metadata).toMatchObject({
      readOnly: true,
      longRunning: true,
      modifiesProject: false,
    });
    expect(byName('build.cancel').metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: true,
      longRunning: true,
      modifiesProject: false,
    });
  });

  it('uses bounded typed schemas for targets, native configuration and build ids', () => {
    expect(byName('build.start').inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['targetId'],
      properties: {
        targetId: { type: 'string', maxLength: 100 },
        androidKeystore: { enum: ['new', 'old'] },
      },
    });
    expect(byName('build.configuration.apply').inputSchema).toMatchObject({
      additionalProperties: false,
      minProperties: 1,
      properties: {
        packageName: { maxLength: 254 },
        orientation: { enum: ['default', 'landscape', 'portrait'] },
        icons: {
          properties: {
            desktop: { maxItems: 1 },
            android: { maxItems: 6 },
            ios: { maxItems: 19 },
          },
        },
      },
    });
    expect(byName('build.result').inputSchema.properties.buildId).toMatchObject(
      {
        minLength: 1,
        maxLength: 200,
      }
    );
  });

  it('dispatches to BuildService and forwards request cancellation to build.start', async () => {
    const signal = new AbortController().signal;
    await byName('build.start').execute({
      input: { targetId: 'windows-exe' },
      requestContext: { signal },
    });
    expect(buildService.start).toHaveBeenCalledWith(
      { targetId: 'windows-exe' },
      signal
    );

    await byName('build.status').execute({ input: { buildId: 'build-1' } });
    expect(buildService.status).toHaveBeenCalledWith({ buildId: 'build-1' });
  });
});
