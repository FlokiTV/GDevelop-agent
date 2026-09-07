const {
  inputRequired,
  inputResponse,
} = require('@modelcontextprotocol/server');

const CONFIRMATION_KEY = 'confirmDestructiveOperation';

const getDestructiveConfirmation = (command, input) => {
  const value = input && typeof input === 'object' ? input : {};
  switch (command) {
    case 'project.open':
    case 'project.close':
      return value.discardUnsavedChanges === true
        ? {
            action: 'discard unsaved project changes',
            consequence: 'Unsaved editor changes will be lost.',
          }
        : null;
    case 'resources.import-local':
      return value.overwrite === true
        ? {
            action: 'overwrite an existing project resource',
            consequence:
              'The existing resource will point to the imported file.',
          }
        : null;
    case 'resources.replace-local':
      return value.deletePreviousFile === true
        ? {
            action: 'replace a resource and delete its previous local file',
            consequence:
              'The previous project-local file will be deleted when safety checks allow it.',
          }
        : null;
    case 'resources.remove':
      return value.deleteFile === true
        ? {
            action: 'remove a resource and delete its local file',
            consequence:
              'The project-local file will be permanently deleted when safety checks allow it.',
          }
        : null;
    default:
      return null;
  }
};

const requireDestructiveConfirmation = ({ command, input, requestContext }) => {
  const policy = getDestructiveConfirmation(command, input);
  if (!policy) return { confirmed: true };

  const responses =
    requestContext && requestContext.mcpReq
      ? requestContext.mcpReq.inputResponses
      : undefined;
  const response = inputResponse(responses, CONFIRMATION_KEY);
  if (response.kind === 'elicit') {
    if (
      response.action === 'accept' &&
      response.content &&
      response.content.confirm === true
    ) {
      return { confirmed: true };
    }
    return {
      confirmed: false,
      declined: true,
      action: policy.action,
    };
  }

  return {
    confirmed: false,
    inputRequired: inputRequired({
      inputRequests: {
        [CONFIRMATION_KEY]: inputRequired.elicit({
          message: `Confirm ${policy.action}. ${policy.consequence}`,
          requestedSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              confirm: {
                type: 'boolean',
                description: 'Set true to confirm this destructive operation.',
              },
            },
            required: ['confirm'],
          },
        }),
      },
    }),
  };
};

module.exports = {
  CONFIRMATION_KEY,
  getDestructiveConfirmation,
  requireDestructiveConfirmation,
};
