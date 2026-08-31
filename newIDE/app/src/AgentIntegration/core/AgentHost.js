// @flow
import { AgentError, normalizeAgentError } from './AgentError';
import {
  CommandRegistry,
  type CommandDescriptor,
} from './CommandRegistry';

export type CommandResult = {|
  command: string,
  data: any,
  meta: {|
    traceId: ?string,
    readOnly: boolean,
    modifiesProject: boolean,
  |},
|};

type AgentHostOptions = {|
  environment?: any,
  descriptors?: Array<CommandDescriptor>,
  registry?: CommandRegistry,
|};

const normalizeInput = (input: any): { [string]: any } => {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentError({
      code: 'invalid_command_input',
      message: 'Command input must be an object.',
    });
  }
  return input;
};

export class AgentHost {
  _environment: any;
  registry: CommandRegistry;

  constructor({
    environment = {},
    descriptors = [],
    registry,
  }: AgentHostOptions = {}) {
    this._environment = environment;
    this.registry = registry || new CommandRegistry(descriptors);
  }

  setEnvironment(environment: any) {
    this._environment = environment || {};
  }

  getEnvironment(): any {
    return this._environment;
  }

  register(descriptor: CommandDescriptor) {
    this.registry.register(descriptor);
    return this;
  }

  listCommands(options?: { query?: ?string }) {
    return this.registry.list(options);
  }

  describeCommand(name: string) {
    return this.registry.describe(name);
  }

  async execute(
    name: string,
    input?: any,
    requestContext?: { [string]: any } = {}
  ): Promise<CommandResult> {
    const descriptor = this.registry.get(name);
    const normalizedInput = normalizeInput(input);
    const environment = this._environment || {};

    if (descriptor.metadata.requiresProject && !environment.project) {
      throw new AgentError({
        code: 'no_project_open',
        message: 'This command requires an open GDevelop project.',
        hint: 'Open or create a project and retry the command.',
        traceId:
          typeof requestContext.traceId === 'string'
            ? requestContext.traceId
            : undefined,
      });
    }

    try {
      if (descriptor.validateInput) descriptor.validateInput(normalizedInput);
      const data = await descriptor.execute({
        environment,
        input: normalizedInput,
        requestContext,
        registry: this.registry,
      });
      return {
        command: descriptor.name,
        data,
        meta: {
          traceId:
            typeof requestContext.traceId === 'string'
              ? requestContext.traceId
              : null,
          readOnly: descriptor.metadata.readOnly,
          modifiesProject: descriptor.metadata.modifiesProject,
        },
      };
    } catch (error) {
      const normalizedError = normalizeAgentError(error);
      if (
        !normalizedError.traceId &&
        typeof requestContext.traceId === 'string'
      ) {
        normalizedError.traceId = requestContext.traceId;
      }
      throw normalizedError;
    }
  }
}
