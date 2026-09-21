import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConnectionError, projectId as validateProjectId } from '../connection/contracts.js';
import { readConfig } from '../connection/io.js';
import { worktreeRoot } from '../connection/git-read.js';
import { connectionPaths, resolveConnection } from '../connection/service.js';
import { inspectKnowledgeWorkspace } from '../knowledge/knowledge-workspace.js';
import { KnowledgeError, isNodeError } from '../knowledge/errors.js';
import { resolveLocalProjectBinding } from '../knowledge/local-project-registry.js';
import { showProject } from '../knowledge/workspace.js';
import { p2aRunJsonKnowledgeAdapter } from '../projector/p2a-run-json-adapter.js';
import { resolveRegisteredProfileBinding } from '../profile/preflight.js';
import { readSourceCollectionManifest } from '../projector/source-manifest.js';
import { openKnowledgeReadSession } from '../retrieval/project-knowledge-reader.js';
import { readSecurityPolicy } from '../sanitizer/policy.js';

export const WORKSPACE_GUIDE_VERSION = 'buildlore.workspace-guide.v1' as const;
const STAGES = ['repository', 'workspace', 'project', 'binding', 'sources', 'approval', 'connection', 'client', 'ai-quality', 'embeddings'] as const;
type Stage = typeof STAGES[number];
export interface GuideCheck {
  readonly id: Stage;
  readonly state: 'complete' | 'pending' | 'blocked' | 'not_checked';
  readonly reasonCode: string;
}
export interface GuideAction {
  readonly location: 'knowledge' | 'source';
  readonly instruction: string;
  readonly argv: readonly string[] | null;
  readonly skill: string | null;
  readonly requiredInputs: readonly string[];
}
export interface WorkspaceGuide {
  readonly schemaVersion: typeof WORKSPACE_GUIDE_VERSION;
  readonly projectId: string | null;
  readonly mode: 'unknown' | 'uninitialized' | 'knowledge' | 'legacy-hub';
  readonly overall: 'action_required' | 'blocked' | 'ready';
  readonly checks: readonly GuideCheck[];
  readonly nextActions: readonly GuideAction[];
}
const action = (instruction: string, argv: readonly string[] | null, requiredInputs: readonly string[] = [], location: GuideAction['location'] = 'knowledge', skill: string | null = null): GuideAction =>
  ({ instruction, argv, requiredInputs, location, skill });
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isNodeError(error) && error.code === 'ENOENT') return false; throw error; }
}

/** Only validated metadata is inspected; no raw source content or filesystem paths leave this service. */
export async function workspaceGuide(directory: string, selectedProject?: string, configDir?: string): Promise<WorkspaceGuide> {
  const root = resolve(directory);
  const projectId = selectedProject === undefined ? null : validateProjectId(selectedProject);
  let mode: WorkspaceGuide['mode'] = 'unknown';
  const checks: GuideCheck[] = STAGES.map(id => ({ id, state: 'not_checked', reasonCode: 'NOT_CHECKED' }));
  const mark = (id: Stage, state: GuideCheck['state'], reasonCode: string): void => { checks[STAGES.indexOf(id)] = { id, state, reasonCode }; };
  const result = (nextActions: readonly GuideAction[] = []): WorkspaceGuide => ({ schemaVersion: WORKSPACE_GUIDE_VERSION, projectId, mode,
    overall: checks.some(c => c.state === 'blocked') ? 'blocked' : checks.slice(0, 7).every(c => c.state === 'complete') ? 'ready' : 'action_required', checks, nextActions });
  const stop = (id: Stage, state: 'pending' | 'blocked', reason: string, next: GuideAction): WorkspaceGuide => { mark(id, state, reason); return result([next]); };
  const recover = action('Inspect the selected knowledge repository and restore damaged configuration from a trusted Git revision before retrying. Do not overwrite approval records.', ['knowledge', 'status']);
  try {
    if (await worktreeRoot(root) !== root) throw new Error('root required');
    mark('repository', 'complete', 'GIT_ROOT_VALID');
  } catch { return stop('repository', 'blocked', 'KNOWLEDGE_ROOT_REQUIRED', action('Run this command at the root of the knowledge Git checkout.', ['workspace', 'guide'], ['knowledge-checkout'])); }
  try {
    if (!await readConfig(join(root, '.buildlore/workspace.json'), 16 * 1024)) {
      if (await exists(join(root, '.gitmodules'))) {
        mode = 'legacy-hub';
        return stop('workspace', 'pending', 'LEGACY_HUB', action('Use the existing hub workflow; inspect knowledge status in the hub and doctor in the connected source checkout.', ['knowledge', 'status']));
      }
      if (await exists(join(root, '.buildlore/connection.json')) || await exists(join(root, '.buildlore/sources.json'))) {
        return stop('workspace', 'blocked', 'SOURCE_CHECKOUT_SELECTED', action('Run workspace guide from the knowledge checkout, or doctor from this source checkout.', ['doctor'], [], 'source'));
      }
      mode = 'uninitialized';
      return stop('workspace', 'pending', 'WORKSPACE_NOT_INITIALIZED', action('Initialize this knowledge repository. Supply its portable repository locator.', ['workspace', 'init', '--knowledge-repo', '<knowledge-repository>'], ['knowledge-repository']));
    }
    await inspectKnowledgeWorkspace(root);
    mode = 'knowledge';
    mark('workspace', 'complete', 'WORKSPACE_VALID');
  } catch { return stop('workspace', 'blocked', 'WORKSPACE_INVALID', recover); }
  if (!projectId) return stop('project', 'pending', 'PROJECT_REQUIRED', action('Choose an explicit project id; projects are never selected automatically.', ['workspace', 'guide', '--project', '<project-id>'], ['project-id']));
  let project;
  try { project = await showProject(root, projectId); mark('project', 'complete', 'PROJECT_REGISTERED'); }
  catch (error) {
    if (error instanceof KnowledgeError && error.code === 'PROJECT_NOT_FOUND') return stop('project', 'pending', 'PROJECT_NOT_REGISTERED', action('First prepare .buildlore/sources.json in the source checkout (matching projectId and sourceRepository; v2 permits an empty sources array), then register it here.', ['project', 'add', '--id', projectId, '--source-repo', '<source-repository>', '--source-root', '<source-checkout>'], ['source-repository', 'source-checkout', 'source-manifest']));
    return stop('project', 'blocked', 'PROJECT_INVALID', recover);
  }
  const bind = action('Inspect the local source checkout and its matching .buildlore/sources.json, then bind it explicitly to this project.', ['project', 'bind', '--project', projectId, '--source-root', '<source-checkout>'], ['source-checkout']);
  try {
    if (!await exists(join(root, '.buildlore/local-projects.json'))) {
      mark('binding', 'pending', 'SOURCE_BINDING_REQUIRED');
      return result([action('Prepare machine-local state after cloning. Existing knowledge and approval records are preserved.', ['workspace', 'init']), bind]);
    }
  } catch { return stop('binding', 'blocked', 'SOURCE_BINDING_INVALID', recover); }
  let binding;
  try { binding = await resolveLocalProjectBinding(root, projectId, project.entry.sourceRepository); mark('binding', 'complete', 'SOURCE_BINDING_VALID'); }
  catch (error) {
    const missing = error instanceof KnowledgeError && error.code === 'SOURCE_BINDING_REQUIRED';
    return stop('binding', missing ? 'pending' : 'blocked', missing ? 'SOURCE_BINDING_REQUIRED' : 'SOURCE_BINDING_INVALID', bind);
  }
  try {
    const profile = await resolveRegisteredProfileBinding(root, projectId, { registrations: [p2aRunJsonKnowledgeAdapter()] });
    const manifest = await readSourceCollectionManifest(binding.checkout, projectId, { sourceAdapterRegistry: profile.sourceAdapters });
    if (manifest.manifest.sources.length === 0) return stop('sources', 'pending', 'SOURCE_DECLARATIONS_REQUIRED', action('Register a selected directory and document kind from the bound source checkout; include subdirectories without listing individual files. Use file paths only for specifically selected documents.', ['source', 'add', '--project', projectId, '--id', '<source-id>', '--kind', '<source-kind>', '--path', '<relative-source-directory>', '--recursive'], ['source-id', 'source-kind', 'relative-source-directory']));
    mark('sources', 'complete', 'SOURCE_DECLARATIONS_VALID');
  } catch (error) {
    const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'SOURCE_MANIFEST_REQUIRED';
    return stop('sources', missing ? 'pending' : 'blocked', missing ? 'SOURCE_DECLARATIONS_REQUIRED' : 'SOURCE_DECLARATIONS_INVALID', action('First restore or prepare the matching source .buildlore/sources.json and check this project’s profile-binding.json. Do not overwrite corrupt declarations. After repairing them, register a selected directory and document kind with subdirectories; retain individual file selections where needed.', ['source', 'add', '--project', projectId, '--id', '<source-id>', '--kind', '<source-kind>', '--path', '<relative-source-directory>', '--recursive'], ['source-id', 'source-kind', 'relative-source-directory']));
  }
  try {
    const session = await openKnowledgeReadSession(root, projectId, { hubRoot: root });
    if (!session) return stop('approval', 'pending', 'APPROVAL_REQUIRED', action('Review this project’s security-policy.json (new projects deny external compilation by default), then sync, author and review Wiki content using the packaged skill, then explicitly approve and activate it with skills/buildlore-activation/SKILL.md. No approval is inferred.', null, ['reviewed-content', 'explicit-approval'], 'knowledge', 'skills/buildlore-authoring/SKILL.md'));
    const policy = await readSecurityPolicy(root, projectId);
    if (policy.digest !== session.publication.projection.sanitizerPolicyDigest || (session.generationDigest && !await session.reader.list(projectId))) throw new Error('invalid approval');
    mark('approval', 'complete', 'APPROVAL_VALID');
  } catch { return stop('approval', 'blocked', 'APPROVAL_INVALID', recover); }
  const connect = action('From the source checkout, connect explicitly to this knowledge checkout and project.', ['connect', '--workspace', '<knowledge-checkout>', '--project', projectId], ['knowledge-checkout'], 'source');
  try {
    const connection = await resolveConnection(binding.checkout.resolveRootForInternalUse(), configDir === undefined ? {} : { configDir });
    if (!connection) return stop('connection', 'pending', 'CONNECTION_REQUIRED', connect);
    if (connection.projectId !== projectId || connectionPaths(connection).knowledgeRoot !== root) return stop('connection', 'blocked', 'CONNECTION_TARGET_MISMATCH', connect);
    mark('connection', 'complete', 'CONNECTION_VALID');
  } catch (error) {
    const missing = error instanceof ConnectionError && error.code === 'CONNECTION_INCOMPLETE';
    return stop('connection', missing ? 'pending' : 'blocked', missing ? 'CONNECTION_INCOMPLETE' : 'CONNECTION_INVALID', connect);
  }
  return result([action('Local knowledge and connection are ready. AI client registration is not checked. Preview client configuration, then apply only after reviewing it.', ['client', 'configure', '--client', '<client>', '--project-dir', '<source-checkout>'], ['client', 'source-checkout'], 'source')]);
}
