import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionError, projectId as validateProjectId } from '../connection/contracts.js';
import { connectProject, connectionOutcome, previewConnection } from '../connection/service.js';
import { configureClient, previewClientForConnection, type ClientOptions } from '../integrations/service.js';
import { ClientConfigError } from '../integrations/files.js';
import { inspectKnowledgeWorkspace } from '../knowledge/knowledge-workspace.js';
import { KnowledgeError } from '../knowledge/errors.js';
import { resolveLocalProjectBinding } from '../knowledge/local-project-registry.js';
import { showProject } from '../knowledge/workspace.js';
import { resolveRegisteredProfileBinding } from '../profile/preflight.js';
import { p2aRunJsonKnowledgeAdapter } from '../projector/p2a-run-json-adapter.js';
import { readSourceCollectionManifest } from '../projector/source-manifest.js';
import { packageVersion } from '../package-version.js';

export interface WorkspaceStage {
  readonly id: string;
  readonly state: 'pending' | 'complete' | 'unchanged' | 'blocked' | 'not_checked';
  readonly code: string;
}
export interface WorkspaceSetupResult {
  readonly schemaVersion: 'buildlore.workspace-setup.v1';
  readonly projectId: string;
  readonly client: 'codex';
  readonly operation: 'connect' | 'check' | 'guide';
  readonly overall: 'preview' | 'configured' | 'ready' | 'action_required' | 'blocked';
  readonly stages: readonly WorkspaceStage[];
  readonly nextActions: readonly string[];
  readonly clientSession: 'unverified';
}
export interface WorkspaceSetupOptions {
  readonly directory: string;
  readonly projectId: string;
  readonly client: 'codex';
  readonly apply?: boolean;
  readonly configDir?: string;
  /** Internal test/embedding seam. The CLI always uses its own installed entrypoint. */
  readonly binPath?: string;
  readonly afterConnection?: () => Promise<void>;
}
export function setupCode(error: unknown): string {
  if (error instanceof ConnectionError || error instanceof KnowledgeError || error instanceof ClientConfigError) return error.code;
  return 'WORKSPACE_SETUP_FAILED';
}
export function setupRecovery(code: string, project: string): string[] {
  if (code === 'PROJECT_NOT_FOUND') return ['Prepare the matching source .buildlore/sources.json, then run project add --id ' + project + ' --source-repo <repository> --source-root <checkout> in the knowledge checkout.'];
  if (code === 'SOURCE_BINDING_REQUIRED') return ['Run workspace init after cloning, then project bind --project ' + project + ' --source-root <checkout>.'];
  if (code.startsWith('SOURCE_') || code.startsWith('PROFILE_')) return ['Inspect the selected project profile and source manifest; run workspace guide --project ' + project + ' for registration guidance.'];
  if (code === 'INSTALLATION_INVALID') return ['Reinstall the BuildLore package in the knowledge checkout, then repeat workspace connect --project ' + project + ' --client codex --apply.'];
  if (code === 'CONNECTION_CONFLICT' || code === 'HUB_UNAVAILABLE') return ['Inspect connection status in the source checkout. For a moved knowledge repository, use connection relocate-hub preview/apply before repeating setup.'];
  if (code.startsWith('CLIENT_')) return ['Inspect the source project Codex configuration and existing ownership receipt. Preserve user edits; resolve the reported conflict, then repeat workspace connect --project ' + project + ' --client codex --apply.'];
  return ['Run workspace guide --project ' + project + ' in the knowledge checkout and doctor in the source checkout; repair the reported prerequisite and retry.'];
}
export async function workspaceTarget(options: WorkspaceSetupOptions): Promise<{ directory: string; projectId: string; sourceRoot: string; sourceRepository: string; clientOptions: ClientOptions }> {
  const projectId = validateProjectId(options.projectId), directory = resolve(options.directory);
  if (options.client !== 'codex') throw new ClientConfigError('CLI_ARGUMENT_INVALID');
  await inspectKnowledgeWorkspace(directory);
  const project = await showProject(directory, projectId);
  const binding = await resolveLocalProjectBinding(directory, projectId, project.entry.sourceRepository);
  const profile = await resolveRegisteredProfileBinding(directory, projectId, { registrations: [p2aRunJsonKnowledgeAdapter()] });
  await readSourceCollectionManifest(binding.checkout, projectId, { sourceAdapterRegistry: profile.sourceAdapters });
  const sourceRoot = binding.checkout.resolveRootForInternalUse();
  return { directory, projectId, sourceRoot, sourceRepository: project.entry.sourceRepository,
    clientOptions: { client: 'codex', operation: 'configure', projectDir: sourceRoot, nodePath: process.execPath,
      binPath: options.binPath ?? fileURLToPath(new URL('../cli/bin.js', import.meta.url)),
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }) } };
}
/** Inspect only the known package binary; never launch a command read from client settings. */
export async function inspectInstallation(bin: string): Promise<void> {
  try {
    const stat = await lstat(bin);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    const root = dirname(dirname(dirname(bin)));
    if (join(root, 'dist/cli/bin.js') !== bin) throw new Error();
    const metadata: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (typeof metadata !== 'object' || !metadata || !('name' in metadata) || metadata.name !== 'buildlore' ||
        !('version' in metadata) || metadata.version !== packageVersion()) throw new Error();
    await access(process.execPath, constants.X_OK);
  } catch { throw new ClientConfigError('INSTALLATION_INVALID'); }
}
export async function workspaceConnect(options: WorkspaceSetupOptions): Promise<WorkspaceSetupResult> {
  const projectId = validateProjectId(options.projectId);
  const stages: WorkspaceStage[] = ['prerequisites', 'connection', 'client'].map(id => ({ id, state: 'not_checked', code: 'NOT_CHECKED' }));
  let step = 0;
  const result = (overall: WorkspaceSetupResult['overall'], nextActions: readonly string[]): WorkspaceSetupResult => ({
    schemaVersion: 'buildlore.workspace-setup.v1', projectId, client: 'codex', operation: 'connect', overall, stages, nextActions, clientSession: 'unverified',
  });
  try {
    const target = await workspaceTarget(options);
    await inspectInstallation(target.clientOptions.binPath);
    stages[0] = { id: 'prerequisites', state: 'complete', code: 'PREREQUISITES_VALID' };
    step = 1;
    const input = { workspace: target.directory, projectId, sourceRepository: target.sourceRepository };
    const connectionOptions = options.configDir === undefined ? {} : { configDir: options.configDir };
    const connection = await previewConnection(target.sourceRoot, input, connectionOptions);
    stages[1] = { id: 'connection', state: connection.unchanged ? 'unchanged' : 'pending', code: connection.unchanged ? 'CONNECTION_VALID' : 'CONNECTION_PLANNED' };
    step = 2;
    const client = await previewClientForConnection(target.clientOptions, connection);
    stages[2] = { id: 'client', state: client.changed ? 'pending' : 'unchanged', code: client.changed ? 'CLIENT_CONFIGURATION_PLANNED' : 'CLIENT_CONFIGURATION_VALID' };
    if (!options.apply) return result('preview', ['Apply in this knowledge checkout: npx --no buildlore workspace connect --project ' + projectId + ' --client codex --apply']);
    step = 1;
    const connected = await connectProject(target.sourceRoot, input, connectionOptions);
    stages[1] = { id: 'connection', state: connectionOutcome(connected) === 'unchanged' ? 'unchanged' : 'complete', code: 'CONNECTION_VALID' };
    step = 2;
    await options.afterConnection?.();
    // Only a real connection can issue the low-level apply plan. Its CAS checks remain intact.
    const plan = await configureClient(target.clientOptions);
    await configureClient({ ...target.clientOptions, apply: true, expectedPlan: plan.planDigest });
    stages[2] = { id: 'client', state: plan.changed ? 'complete' : 'unchanged', code: 'CLIENT_CONFIGURATION_VALID' };
    return result('configured', [
      'Check here: npx --no buildlore workspace check --project ' + projectId + ' --client codex',
      'Open a new trusted Codex session in the source project and use /mcp to confirm activation. Existing sessions are not checked.',
    ]);
  } catch (error) {
    const code = setupCode(error), id = stages[step]?.id ?? 'prerequisites';
    stages[step] = { id, state: 'blocked', code };
    return result('blocked', setupRecovery(code, projectId));
  }
}

export async function workspaceClientGuide(options: WorkspaceSetupOptions): Promise<WorkspaceSetupResult> {
  const preview = await workspaceConnect({ ...options, apply: false });
  const configured = preview.stages.slice(1).every(stage => stage.state === 'unchanged');
  return { ...preview, operation: 'guide', overall: preview.overall === 'blocked' ? 'blocked' : 'action_required',
    stages: [...preview.stages, { id: 'protocol', state: 'not_checked', code: 'MCP_CHECK_REQUIRED' }],
    nextActions: configured ? ['Configuration is present. Run npx --no buildlore workspace check --project ' + preview.projectId + ' --client codex to test actual search and reading.'] : preview.nextActions };
}
