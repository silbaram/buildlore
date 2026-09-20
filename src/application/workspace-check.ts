import { resolve } from 'node:path';
import { configDirectory } from '../connection/io.js';
import { connectionPaths, resolveConnection } from '../connection/service.js';
import { configureClient } from '../integrations/service.js';
import { ClientConfigError } from '../integrations/files.js';
import { projectId as validateProjectId } from '../connection/contracts.js';
import { McpProbe, McpProbeError, inspectWikiProtocol } from '../mcp/probe.js';
import { inspectInstallation, setupCode, setupRecovery, workspaceTarget, type WorkspaceSetupOptions, type WorkspaceSetupResult, type WorkspaceStage } from './workspace-setup.js';

export async function workspaceCheck(options: WorkspaceSetupOptions): Promise<WorkspaceSetupResult> {
  const projectId = validateProjectId(options.projectId);
  const stages: WorkspaceStage[] = ['installation', 'connection', 'client', 'initialize', 'tools', 'status', 'list', 'search', 'read']
    .map(id => ({ id, state: 'not_checked', code: 'NOT_CHECKED' }));
  let active = 'installation';
  const mark = (id: string, state: WorkspaceStage['state'], code: string): void => {
    active = id; stages[stages.findIndex(s => s.id === id)] = { id, state, code };
  };
  let peer: McpProbe | undefined;
  let overall: WorkspaceSetupResult['overall'] = 'blocked';
  let nextActions: string[];
  try {
    const target = await workspaceTarget(options);
    await inspectInstallation(target.clientOptions.binPath);
    mark('installation', 'complete', 'INSTALLATION_VALID');
    mark('connection', 'pending', 'CHECKING');
    const configDir = resolve(options.configDir ?? configDirectory());
    const connection = await resolveConnection(target.sourceRoot, { configDir });
    if (!connection) throw new ClientConfigError('CONNECTION_MISSING');
    if (connection.projectId !== projectId || connectionPaths(connection).knowledgeRoot !== target.directory) throw new ClientConfigError('PROJECT_MISMATCH');
    mark('connection', 'complete', 'CONNECTION_VALID');
    mark('client', 'pending', 'CHECKING');
    if ((await configureClient(target.clientOptions)).changed) throw new ClientConfigError('CLIENT_CONFIGURATION_REQUIRED');
    mark('client', 'complete', 'CLIENT_CONFIGURATION_VALID');
    mark('initialize', 'pending', 'CHECKING');
    peer = new McpProbe(process.execPath, [target.clientOptions.binPath, 'mcp', '--project-dir', target.sourceRoot, '--read-only'],
      { ...process.env, BUILDLORE_CONFIG_DIR: configDir });
    await inspectWikiProtocol(peer, projectId, (id, state) => mark(id, state, state === 'complete' ? 'MCP_VERIFIED' : 'CHECKING'));
    overall = 'ready';
    nextActions = ['Actual MCP search and reading passed. Open a new trusted Codex session in the source project and use /mcp to confirm activation; this session is unverified.'];
  } catch (error) {
    const code = error instanceof McpProbeError ? error.code : setupCode(error);
    mark(active, 'blocked', code);
    nextActions = ['APPROVAL_MISSING', 'KNOWLEDGE_DIRTY', 'KNOWLEDGE_INVALID', 'WIKI_EMPTY', 'SEARCH_EMPTY'].includes(code)
      ? ['Use workspace guide --project ' + projectId + ' to inspect the selected Wiki. Review, approve/activate and commit its intended content through the existing workflow, then retry.']
      : code === 'GENERATION_CHANGED' ? ['Wiki changed during inspection. Repeat workspace check for the current generation.']
        : code.startsWith('MCP_') ? ['Inspect the installed BuildLore runtime, then repeat workspace check. Raw server output is omitted.']
          : setupRecovery(code, projectId);
  } finally { await peer?.close(); }
  return { schemaVersion: 'buildlore.workspace-setup.v1', projectId, client: 'codex', operation: 'check', overall, stages, nextActions, clientSession: 'unverified' };
}
