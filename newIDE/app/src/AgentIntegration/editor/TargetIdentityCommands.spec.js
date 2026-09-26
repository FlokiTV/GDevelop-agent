// @flow
import { createTargetIdentityCommandDescriptors } from './TargetIdentityCommands';

describe('TargetIdentityCommands', () => {
  it('publishes target.status as read-only and delegates to refreshStatus', async () => {
    const refreshStatus = jest.fn(async () => ({
      project: { projectId: 'p' },
      editor: {},
      preview: {},
    }));
    const descriptors = createTargetIdentityCommandDescriptors({
      targetIdentityService: { refreshStatus },
    });
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'target.status',
    ]);
    expect(descriptors[0].metadata).toMatchObject({
      readOnly: true,
      idempotent: true,
    });
    await expect(descriptors[0].execute({})).resolves.toEqual({
      project: { projectId: 'p' },
      editor: {},
      preview: {},
    });
    expect(refreshStatus).toHaveBeenCalledTimes(1);
  });
});
