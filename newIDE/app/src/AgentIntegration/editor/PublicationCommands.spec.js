// @flow
import { createPublicationCommandDescriptors } from './PublicationCommands';

describe('PublicationCommands', () => {
  it('exposes discovery, dry-run and destructive publish metadata', async () => {
    const publicationService = {
      listIntegrations: jest.fn(() => ({ integrations: [] })),
      prepare: jest.fn(async input => ({ manifest: input })),
      publish: jest.fn(async input => ({ published: true, input })),
    };
    const descriptors = createPublicationCommandDescriptors({
      publicationService,
    });
    const byName = new Map(
      descriptors.map(descriptor => [descriptor.name, descriptor])
    );

    expect(Array.from(byName.keys())).toEqual([
      'publication.integrations.list',
      'publication.prepare',
      'publication.publish',
    ]);

    expect(byName.get('publication.integrations.list').metadata).toMatchObject({
      readOnly: true,
      destructive: false,
      modifiesProject: false,
    });
    expect(byName.get('publication.prepare').metadata).toMatchObject({
      readOnly: true,
      destructive: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
    });
    expect(byName.get('publication.publish').metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      idempotent: true,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
    });

    await byName.get('publication.prepare').execute({
      input: { integrationId: 'gd-games', buildId: 'b1' },
    });
    expect(publicationService.prepare).toHaveBeenCalledWith({
      integrationId: 'gd-games',
      buildId: 'b1',
    });

    await byName.get('publication.publish').execute({
      input: {
        integrationId: 'gd-games',
        buildId: 'b1',
        confirmPublication: true,
      },
    });
    expect(publicationService.publish).toHaveBeenCalledWith({
      integrationId: 'gd-games',
      buildId: 'b1',
      confirmPublication: true,
    });
  });
});
