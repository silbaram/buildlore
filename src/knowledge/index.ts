export { KnowledgeError, type KnowledgeErrorCode } from './errors.js';
export {
  cloneKnowledge,
  getSubmoduleStatus,
  initKnowledge,
  parseSubmoduleStatusLine,
} from './git.js';
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
  DEFAULT_PROFILE_VERSION,
  KNOWLEDGE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
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
  type ProjectKnowledgeStatus,
  type ProjectRecord,
  type ProjectRegistryEntry,
  type SubmoduleState,
  type SubmoduleStatus,
} from './types.js';
export {
  createProjectDescriptor,
  isSshScpLocator,
  parseKnowledgeManifest,
  parseProjectDescriptor,
  projectPathFor,
  validateProjectId,
  validateRepositoryLocator,
} from './validation.js';
