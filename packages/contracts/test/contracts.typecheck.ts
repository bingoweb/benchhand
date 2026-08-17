import type {
  ArtifactId,
  OperationId,
  PluginId,
  PluginInstanceId,
  ProcessId,
  TaskId,
  TerminalSessionId,
  WorkspaceId,
} from '../src/contracts.js';

declare const workspaceId: WorkspaceId;
declare const operationId: OperationId;
declare const processId: ProcessId;
declare const taskId: TaskId;
declare const terminalSessionId: TerminalSessionId;
declare const pluginId: PluginId;
declare const pluginInstanceId: PluginInstanceId;
declare const artifactId: ArtifactId;

const idsAreStrings: string[] = [
  workspaceId,
  operationId,
  processId,
  taskId,
  terminalSessionId,
  pluginId,
  pluginInstanceId,
  artifactId,
];

void idsAreStrings;

// @ts-expect-error durable IDs must not be assignable from arbitrary strings.
const notAWorkspaceId: WorkspaceId = 'workspace';
void notAWorkspaceId;
