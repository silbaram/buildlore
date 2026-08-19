import { isAbsolute, posix, win32 } from 'node:path';

import { KnowledgeError } from './errors.js';
import {
  DEFAULT_PROFILE_VERSION,
  KNOWLEDGE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  type KnowledgeManifest,
  type ProjectDescriptor,
  type ProjectRegistryEntry,
} from './types.js';

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESERVED_PROJECT_IDS = new Set(['knowledge', 'manifest', 'projects', 'shared']);
const SCP_LOCATOR_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^\s@?#]+$/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function invalid(message: string): never {
  throw new KnowledgeError('MANIFEST_INVALID', message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} contains missing or unsupported fields.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    return invalid(`${label} must be a string.`);
  }
  return value;
}

export function validateProjectId(projectId: string): string {
  if (
    projectId.length < 1 ||
    projectId.length > 64 ||
    !PROJECT_ID_PATTERN.test(projectId) ||
    RESERVED_PROJECT_IDS.has(projectId)
  ) {
    invalid('projectId must be a non-reserved lowercase kebab-case identifier of 1-64 characters.');
  }
  return projectId;
}

export function projectPathFor(projectId: string): string {
  return `projects/${validateProjectId(projectId)}`;
}

export function validateDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 120 || containsControlCharacter(trimmed)) {
    invalid('displayName must be 1-120 printable characters.');
  }
  return trimmed;
}

export function validateProfileVersion(profileVersion: string): typeof DEFAULT_PROFILE_VERSION {
  const trimmed = profileVersion.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 120 ||
    containsControlCharacter(trimmed)
  ) {
    invalid('profileVersion must be a non-empty printable version identifier.');
  }
  if (trimmed !== DEFAULT_PROFILE_VERSION) {
    invalid('profileVersion is unsupported by this BuildLore version.');
  }
  return DEFAULT_PROFILE_VERSION;
}

export function isSshScpLocator(locator: string): boolean {
  return SCP_LOCATOR_PATTERN.test(locator);
}

export function validateRepositoryLocator(locator: string): string {
  const trimmed = locator.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 2048 ||
    containsControlCharacter(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.includes('::') ||
    isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed) ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(trimmed)
  ) {
    invalid('Repository identity must be a credential-free URL or relative locator.');
  }

  if (isSshScpLocator(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('https://') || trimmed.startsWith('ssh://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return invalid('Repository URL is invalid.');
    }
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:')
    ) {
      invalid('Repository URL must not contain credentials, query parameters, or fragments.');
    }
    return trimmed;
  }

  if (
    trimmed.includes('://') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes('@')
  ) {
    invalid('Repository locator uses an unsupported transport or contains unsafe metadata.');
  }
  return trimmed;
}

function parseEntry(value: unknown): ProjectRegistryEntry {
  const record = asRecord(value, 'Project registry entry');
  requireExactKeys(record, ['displayName', 'path', 'projectId', 'sourceRepository'], 'Project registry entry');
  const projectId = validateProjectId(requireString(record.projectId, 'projectId'));
  const path = requireString(record.path, 'path');
  if (
    path !== projectPathFor(projectId) ||
    path.includes('\\') ||
    posix.normalize(path) !== path
  ) {
    invalid('Project path must be the canonical projects/<projectId> path.');
  }
  return {
    displayName: validateDisplayName(requireString(record.displayName, 'displayName')),
    path,
    projectId,
    sourceRepository: validateRepositoryLocator(
      requireString(record.sourceRepository, 'sourceRepository'),
    ),
  };
}

export function parseKnowledgeManifest(value: unknown): KnowledgeManifest {
  const record = asRecord(value, 'Knowledge manifest');
  requireExactKeys(record, ['projects', 'schemaVersion'], 'Knowledge manifest');
  if (record.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION || !Array.isArray(record.projects)) {
    invalid('Knowledge manifest schema is unsupported.');
  }
  const projects = record.projects.map(parseEntry);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.projectId) || paths.has(project.path)) {
      invalid('Knowledge manifest contains a duplicate projectId or path.');
    }
    ids.add(project.projectId);
    paths.add(project.path);
  }
  return {
    projects: [...projects].sort((left, right) =>
      left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0,
    ),
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
  };
}

export function parseProjectDescriptor(value: unknown): ProjectDescriptor {
  const record = asRecord(value, 'Project descriptor');
  requireExactKeys(
    record,
    ['profileVersion', 'projectId', 'schemaVersion', 'sourceRepository'],
    'Project descriptor',
  );
  if (record.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    invalid('Project descriptor schema is unsupported.');
  }
  return {
    profileVersion: validateProfileVersion(
      requireString(record.profileVersion, 'profileVersion'),
    ),
    projectId: validateProjectId(requireString(record.projectId, 'projectId')),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sourceRepository: validateRepositoryLocator(
      requireString(record.sourceRepository, 'sourceRepository'),
    ),
  };
}

export function createProjectDescriptor(input: {
  readonly profileVersion?: string;
  readonly projectId: string;
  readonly sourceRepository: string;
}): ProjectDescriptor {
  return parseProjectDescriptor({
    profileVersion: input.profileVersion ?? DEFAULT_PROFILE_VERSION,
    projectId: input.projectId,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sourceRepository: input.sourceRepository,
  });
}
