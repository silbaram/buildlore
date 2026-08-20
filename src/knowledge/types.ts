export const KNOWLEDGE_SCHEMA_VERSION = 'buildlore.knowledge.v1' as const;
export const PROJECT_SCHEMA_VERSION = 'buildlore.project.v1' as const;
export const PROJECT_SCHEMA_VERSION_V2 = 'buildlore.project.v2' as const;
export const STATUS_SCHEMA_VERSION = 'buildlore.status.v1' as const;
export const DEFAULT_PROFILE_VERSION = 'llmwiki.default.v1' as const;
export const BUILDLORE_LIFECYCLE_PROFILE_ID = 'buildlore-lifecycle' as const;
export const BUILDLORE_LIFECYCLE_PROFILE_VERSION = '0.1.0' as const;

export interface ProjectRegistryEntry {
  readonly displayName: string;
  readonly path: string;
  readonly projectId: string;
  readonly sourceRepository: string;
}

export interface KnowledgeManifest {
  readonly projects: readonly ProjectRegistryEntry[];
  readonly schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
}

export interface ProjectDescriptorV1 {
  readonly profileVersion: typeof DEFAULT_PROFILE_VERSION;
  readonly projectId: string;
  readonly schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  readonly sourceRepository: string;
}

export interface ProjectDescriptorV2 {
  readonly outputLanguage: 'en' | 'ko';
  readonly profileHash: `sha256:${string}`;
  readonly profileId: typeof BUILDLORE_LIFECYCLE_PROFILE_ID;
  readonly profileVersion: typeof BUILDLORE_LIFECYCLE_PROFILE_VERSION;
  readonly projectId: string;
  readonly schemaVersion: typeof PROJECT_SCHEMA_VERSION_V2;
  readonly sourceRepository: string;
}

export type ProjectDescriptor = ProjectDescriptorV1 | ProjectDescriptorV2;

export type ResolvedProjectProfileBinding =
  | Readonly<{
      mode: 'custom';
      outputLanguage: 'en' | 'ko';
      profileHash: `sha256:${string}`;
      profileId: typeof BUILDLORE_LIFECYCLE_PROFILE_ID;
      profileVersion: typeof BUILDLORE_LIFECYCLE_PROFILE_VERSION;
    }>
  | Readonly<{
      mode: 'default';
      outputLanguage: 'en';
      profileHash: null;
      profileId: null;
      profileVersion: typeof DEFAULT_PROFILE_VERSION;
    }>;

export interface AddProjectInput {
  readonly displayName: string;
  readonly projectId: string;
  readonly sourceRepository: string;
}

export interface ProjectRecord {
  readonly descriptor: ProjectDescriptor;
  readonly entry: ProjectRegistryEntry;
  readonly workspacePath: string;
}

export type SubmoduleState =
  | 'commit-mismatch'
  | 'conflicted'
  | 'invalid'
  | 'ready'
  | 'unconfigured'
  | 'uninitialized';

export interface SubmoduleStatus {
  readonly branch: string | null;
  readonly checkedOutCommit: string | null;
  readonly gitStatusPrefix: ' ' | '+' | '-' | 'U' | null;
  readonly path: 'knowledge';
  readonly pinnedCommit: string | null;
  readonly repository: string | null;
  readonly state: SubmoduleState;
}

export interface CompilerPendingChange {
  readonly file: string;
  readonly status: 'changed' | 'deleted' | 'new';
}

export type CompilerStateStatus = 'corrupt' | 'missing' | 'ok' | 'too-new';

export interface CompilerChangeStatus {
  readonly pendingChanges: readonly CompilerPendingChange[];
  readonly pendingChangesCount: number;
  readonly stateStatus: CompilerStateStatus;
}

export interface CompilerStatusPort {
  status(projectId: string): Promise<CompilerChangeStatus>;
}

export type KnowledgePinState =
  | 'conflicted'
  | 'invalid'
  | 'matched'
  | 'mismatched'
  | 'unconfigured'
  | 'uninitialized';

export interface ProjectKnowledgeStatus {
  readonly compiler: CompilerChangeStatus;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly workspaceState: 'ready';
}

export interface KnowledgeStatus {
  readonly compiler: CompilerChangeStatus | null;
  readonly currentCommit: string | null;
  readonly initialized: boolean;
  readonly knowledge: SubmoduleStatus;
  readonly ok: boolean;
  readonly pinState: KnowledgePinState;
  readonly pinnedCommit: string | null;
  readonly project: ProjectKnowledgeStatus | null;
  readonly projectId: string | null;
  readonly recoveryCommand?: readonly string[];
  readonly schemaVersion: typeof STATUS_SCHEMA_VERSION;
  readonly workspacePath: string | null;
}
