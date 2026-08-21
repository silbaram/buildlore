export { KnowledgeError, type KnowledgeErrorCode } from './errors.js';
export {
  cloneKnowledge,
  getSubmoduleStatus,
  initKnowledge,
  parseSubmoduleStatusLine,
} from './git.js';
export {
  initializeModeAWorkspace,
  MODE_A_INITIALIZATION_SCHEMA_VERSION,
  ModeAInitializationError,
  type ModeAInitializationInput,
  type ModeAInitializationResult,
  type ModeAInitializationStage,
} from './initialization.js';
export { resolveKnowledgeRoot, resolveProjectWorkspace } from './paths.js';
export { emptyManifest, readManifest, writeManifest } from './registry.js';
export { getKnowledgeStatus, getProjectKnowledgeStatus } from './status.js';
export {
  ensureKnowledgeIgnorePolicy,
  KNOWLEDGE_GITIGNORE,
  LLWIKI_TRACKING_MATRIX,
} from './tracking-policy.js';
export {
  addProject,
  listProjects,
  showProject,
  validateProjectRegistry,
} from './workspace.js';
export {
  BUILDLORE_LIFECYCLE_PROFILE_ID,
  BUILDLORE_LIFECYCLE_PROFILE_VERSION,
  DEFAULT_PROFILE_VERSION,
  KNOWLEDGE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION_V2,
  STATUS_SCHEMA_VERSION,
  type AddProjectInput,
  type CompilerChangeStatus,
  type CompilerPendingChange,
  type CompilerStatusPort,
  type CompilerStateStatus,
  type KnowledgeManifest,
  type KnowledgePinState,
  type KnowledgeStatus,
  type ProjectDescriptor,
  type ProjectDescriptorV1,
  type ProjectDescriptorV2,
  type ProjectKnowledgeStatus,
  type ProjectRecord,
  type ProjectRegistryEntry,
  type ResolvedProjectProfileBinding,
  type SubmoduleState,
  type SubmoduleStatus,
} from './types.js';
export {
  createProjectDescriptor,
  createProfileProjectDescriptor,
  isSshScpLocator,
  parseKnowledgeManifest,
  parseProjectDescriptor,
  projectPathFor,
  resolveProjectProfileBinding,
  validateProjectId,
  validateRepositoryLocator,
} from './validation.js';
