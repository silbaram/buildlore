import { createHash } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isNodeError, KnowledgeError } from './errors.js';
import { serializeCanonicalJson, syncDirectory } from './atomic-file.js';
import { resolveKnowledgeRoot } from './paths.js';
import { LLM_WIKI_COMPILER_OUTPUT_INVENTORY } from './tracking-inventory.js';
import {
  KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION,
  LLM_WIKI_COMPILER_COMMIT,
  LLM_WIKI_COMPILER_INTEGRITY,
  LLM_WIKI_COMPILER_PACKAGE,
  LLM_WIKI_COMPILER_VERSION,
  type CompilerPackageIdentity,
  type KnowledgeTrackingPolicyV1,
  type SemanticCacheState,
  type Sha256Digest,
  type TrackingClassificationResult,
  type TrackingEntry,
  type TrackingSelectionOptions,
} from './tracking-types.js';

export const KNOWLEDGE_GITIGNORE = `# BuildLore Mode A safe defaults
.env
.env.*
**/.env
**/.env.*
**/*[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]*
**/.llmwiki/embeddings/**
**/.llmwiki/embeddings.json
**/.llmwiki/pending-embeddings.json
**/.llmwiki/last-lint.json
**/.llmwiki/connectors/*.last-fetch.json
**/.llmwiki/workflows/.runkey
**/.llmwiki/*.lock
**/.llmwiki/**/*.lock
**/.llmwiki/journal/**
**/.llmwiki/**/*.journal
**/.llmwiki/**/*.tmp
**/.llmwiki/**/*.bak
**/dist/exports/**
**/*.pem
**/*.key
**/*.tmp
**/*.bak
manifest.json.lock
.*.tmp
projects/.buildlore-workspace-*/
`;

const entries: readonly TrackingEntry[] = [
  entry('always-ignore-backup', '**/*.bak', 'shared', 'always-ignore',
    'machine-local', 'ephemeral', 'local-state', 'unsafe', 'must-not-publish',
    'Atomic recovery backup; never a durable contract.'),
  entry('always-ignore-connector-cache', 'projects/*/.llmwiki/connectors/*.last-fetch.json',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'regenerable',
    'local-state', 'unsafe', 'safe-to-regenerate', 'Machine-local connector rate cache.'),
  entry('always-ignore-credential-file', '**/*credential*', 'shared', 'always-ignore',
    'machine-local', 'ephemeral', 'credential', 'unsafe', 'must-not-publish',
    'Credential-named material is outside the publish boundary.'),
  entry('always-ignore-embedding-directory', 'projects/*/.llmwiki/embeddings/**',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'regenerable',
    'local-state', 'unsafe', 'safe-to-regenerate', 'Legacy or sharded embedding cache.'),
  entry('always-ignore-embeddings', 'projects/*/.llmwiki/embeddings.json',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'regenerable',
    'local-state', 'unsafe', 'safe-to-regenerate', 'Provider/model-bound embedding cache.'),
  entry('always-ignore-env', '**/.env*', 'shared', 'always-ignore', 'machine-local',
    'ephemeral', 'credential', 'unsafe', 'must-not-publish',
    'Environment and credential injection stays outside Git.'),
  entry('always-ignore-eval-cache', 'projects/*/.llmwiki/eval/citation-cache.jsonl',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'regenerable',
    'local-state', 'unsafe', 'safe-to-regenerate', 'Provider-bound evaluation cache.'),
  entry('always-ignore-export-output', 'projects/*/dist/exports/**',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'regenerable',
    'local-state', 'unsafe', 'safe-to-regenerate', 'On-demand export output is regenerable.'),
  entry('always-ignore-journal', 'projects/*/.llmwiki/journal/*.json',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'ephemeral',
    'local-state', 'unsafe', 'must-not-publish', 'In-flight mutation journal.'),
  entry('always-ignore-journal-quarantine', 'projects/*/.llmwiki/journal/quarantine/*.json',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'ephemeral',
    'local-state', 'unsafe', 'must-not-publish', 'Machine-local recovery quarantine.'),
  entry('always-ignore-last-lint', 'projects/*/.llmwiki/last-lint.json',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'regenerable',
    'local-state', 'unsafe', 'safe-to-regenerate', 'Machine-local lint cache.'),
  entry('always-ignore-lock', '**/*.lock', 'shared', 'always-ignore', 'machine-local',
    'ephemeral', 'authority', 'unsafe', 'must-not-publish', 'Writer ownership lock.'),
  entry('always-ignore-compiler-lock', 'projects/*/.llmwiki/lock',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'ephemeral',
    'authority', 'unsafe', 'must-not-publish', 'Compiler writer ownership lock.'),
  entry('always-ignore-pending-embeddings', 'projects/*/.llmwiki/pending-embeddings.json',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'ephemeral',
    'local-state', 'unsafe', 'safe-to-regenerate', 'Incomplete cache refresh marker.'),
  entry('always-ignore-private-key', '**/*.key', 'shared', 'always-ignore', 'machine-local',
    'ephemeral', 'authority', 'unsafe', 'must-not-publish', 'Private authority key material.'),
  entry('always-ignore-private-pem', '**/*.pem', 'shared', 'always-ignore', 'machine-local',
    'ephemeral', 'authority', 'unsafe', 'must-not-publish', 'Private PEM material.'),
  entry('always-ignore-temporary', '**/*.tmp', 'shared', 'always-ignore', 'machine-local',
    'ephemeral', 'local-state', 'unsafe', 'must-not-publish', 'Atomic temporary file.'),
  entry('always-ignore-workflow-run-key', 'projects/*/.llmwiki/workflows/.runkey',
    'llm-wiki-compiler@1.1.0', 'always-ignore', 'machine-local', 'ephemeral',
    'authority', 'unsafe', 'must-not-publish', 'Private workflow integrity authority key.'),
  entry('always-track-activity-log', 'projects/*/log.md', 'llm-wiki-compiler@1.1.0',
    'always-track', 'portable', 'derived', 'none', 'low', 'from-tracked-state',
    'Bounded activity lineage; staged bytes still require sanitization.'),
  entry('always-track-artifact', 'projects/*/artifacts/*/*/*', 'llm-wiki-compiler@1.1.0',
    'always-track', 'portable', 'authoritative', 'none', 'low', 'not-regenerable',
    'Profile-declared artifact and hash-bound sidecar.'),
  entry('always-track-compiler-config', 'projects/*/.llmwiki/config.json', 'shared',
    'always-track', 'portable', 'authoritative', 'none', 'low', 'not-regenerable',
    'Applied compiler review and lifecycle configuration.'),
  entry('always-track-compiler-profile', 'projects/*/.llmwiki/profile.json', 'shared',
    'always-track', 'portable', 'derived', 'none', 'low', 'from-tracked-state',
    'Deterministically materialized compiler profile.'),
  entry('always-track-compiler-schema', 'projects/*/.llmwiki/schema.json',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'authoritative', 'none',
    'low', 'not-regenerable', 'Applied page schema.'),
  entry('always-track-compiler-state', 'projects/*/.llmwiki/state.json',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'incremental', 'none',
    'low', 'not-regenerable', 'Incremental compile cursor required by a fresh clone.'),
  entry('always-track-embedding-identity',
    'projects/*/.llmwiki/buildlore-embedding-identity.json', 'buildlore', 'always-track',
    'portable', 'derived', 'none', 'low', 'from-tracked-state',
    'Safe compatibility lineage; never substitutes for the cache itself.'),
  entry('always-track-eval-thresholds', 'projects/*/.llmwiki/eval/thresholds.yaml',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'authoritative', 'none',
    'low', 'not-regenerable', 'Applied evaluation thresholds.'),
  entry('always-track-gitignore', '.gitignore', 'buildlore', 'always-track', 'portable',
    'authoritative', 'none', 'low', 'not-regenerable', 'Repository safety defaults.'),
  entry('always-track-manifest', 'manifest.json', 'buildlore', 'always-track', 'portable',
    'authoritative', 'none', 'review-required', 'not-regenerable',
    'Canonical Mode A registry manifest.'),
  entry('always-track-profile-source', 'projects/*/profile.json', 'buildlore', 'always-track',
    'portable', 'authoritative', 'none', 'low', 'not-regenerable',
    'Canonical language-neutral lifecycle profile.'),
  entry('always-track-project-descriptor', 'projects/*/project.json', 'buildlore',
    'always-track', 'portable', 'authoritative', 'none', 'low', 'not-regenerable',
    'Canonical project descriptor and safe lineage binding.'),
  entry('always-track-relation-store', 'projects/*/wiki/graph/relations.jsonl',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'authoritative', 'none',
    'low', 'not-regenerable', 'Portable typed relation graph.'),
  entry('always-track-rule-state', 'projects/*/.llmwiki/rule-state.json',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'incremental', 'none',
    'low', 'not-regenerable', 'Independent incremental rule extraction cursor.'),
  entry('always-track-security-policy', 'projects/*/security-policy.json', 'buildlore',
    'always-track', 'portable', 'authoritative', 'none', 'low', 'not-regenerable',
    'Project-scoped classification and egress policy.'),
  entry('always-track-source', 'projects/*/sources/*.md', 'shared', 'always-track',
    'portable', 'authoritative', 'none', 'low', 'not-regenerable',
    'Sanitized flat compiler source.'),
  entry('always-track-template-lock', 'projects/*/.llmwiki/template-lock.json',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'authoritative', 'none',
    'low', 'not-regenerable', 'Applied template identity and continuity record.'),
  entry('always-track-wiki-index', 'projects/*/wiki/index.md',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'derived', 'none', 'low',
    'from-tracked-state', 'Portable generated index.'),
  entry('always-track-wiki-moc', 'projects/*/wiki/MOC.md',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'derived', 'none', 'low',
    'from-tracked-state', 'Portable generated map of content.'),
  entry('always-track-wiki-page', 'projects/*/wiki/*/*.md',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'derived', 'none', 'low',
    'from-tracked-state', 'Portable compiled or trusted typed page.'),
  entry('always-track-workflow-projection', 'projects/*/wiki/outputs/workflows/**/*.md',
    'llm-wiki-compiler@1.1.0', 'always-track', 'portable', 'derived', 'none', 'low',
    'from-tracked-state', 'Derived portable workflow projection.'),
  entry('policy-track-candidate', 'projects/*/.llmwiki/candidates/*.json',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'derived', 'none',
    'review-required', 'from-tracked-state', 'Pending review candidate.'),
  entry('policy-track-candidate-archive', 'projects/*/.llmwiki/candidates/archive/*.json',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'derived', 'none',
    'review-required', 'from-tracked-state', 'Rejected candidate audit archive.'),
  entry('policy-track-eval-history', 'projects/*/.llmwiki/eval/history.jsonl',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'derived', 'none',
    'review-required', 'safe-to-regenerate', 'Evaluation history is review-bound.'),
  entry('policy-track-event-head', 'projects/*/.llmwiki/events.head',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'authoritative', 'none',
    'review-required', 'not-regenerable', 'Sealed head paired with the event audit log.'),
  entry('policy-track-event-store', 'projects/*/wiki/graph/events.jsonl',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'authoritative', 'none',
    'review-required', 'not-regenerable', 'Event audit log paired with its sealed head.'),
  entry('policy-track-rule-candidate', 'projects/*/.llmwiki/rule-candidates/*.json',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'derived', 'none',
    'review-required', 'from-tracked-state', 'Pending rule review candidate.'),
  entry('policy-track-rule-candidate-archive',
    'projects/*/.llmwiki/rule-candidates/archive/*.json', 'llm-wiki-compiler@1.1.0',
    'policy-track', 'portable', 'derived', 'none', 'review-required',
    'from-tracked-state', 'Rejected rule candidate audit archive.'),
  entry('policy-track-workflow-run', 'projects/*/.llmwiki/workflows/runs/*.json',
    'llm-wiki-compiler@1.1.0', 'policy-track', 'portable', 'authoritative', 'none',
    'review-required', 'not-regenerable', 'Workflow execution and event audit state.'),
];

const classificationOrder: Readonly<Record<TrackingEntry['classification'], number>> = {
  'always-ignore': 0,
  'always-track': 1,
  'policy-track': 2,
};

function compareEntries(left: TrackingEntry, right: TrackingEntry): number {
  const classDifference = classificationOrder[left.classification] -
    classificationOrder[right.classification];
  if (classDifference !== 0) return classDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

const orderedEntries = entries.toSorted(compareEntries);

function entry(
  id: string,
  pattern: string,
  producer: TrackingEntry['producer'],
  classification: TrackingEntry['classification'],
  portability: TrackingEntry['portability'],
  reproducibility: TrackingEntry['reproducibility'],
  secretOrAuthorityRisk: TrackingEntry['secretOrAuthorityRisk'],
  mergeRisk: TrackingEntry['mergeRisk'],
  regenerationSafety: TrackingEntry['regenerationSafety'],
  rationale: string,
): TrackingEntry {
  return {
    classification,
    defaultDisposition: classification === 'always-track' ? 'include' : 'exclude',
    id,
    mergeRisk,
    pattern,
    portability,
    producer,
    rationale,
    regenerationSafety,
    reproducibility,
    secretOrAuthorityRisk,
  };
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function policyWithoutDigest(): Omit<KnowledgeTrackingPolicyV1, 'policyDigest'> {
  return {
    schemaVersion: KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION,
    upstreamPackage: LLM_WIKI_COMPILER_PACKAGE,
    exactVersion: LLM_WIKI_COMPILER_VERSION,
    packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
    packageCommit: LLM_WIKI_COMPILER_COMMIT,
    inventoryDigest: LLM_WIKI_COMPILER_OUTPUT_INVENTORY.inventoryDigest,
    entries: orderedEntries,
  };
}

export function createKnowledgeTrackingPolicy(): KnowledgeTrackingPolicyV1 {
  const base = policyWithoutDigest();
  return Object.freeze({
    ...base,
    entries: Object.freeze(orderedEntries.map((item) => Object.freeze({ ...item }))),
    policyDigest: sha256(serializeCanonicalJson(base)),
  });
}

export const KNOWLEDGE_TRACKING_POLICY = createKnowledgeTrackingPolicy();

export const LLWIKI_TRACKING_MATRIX = Object.freeze({
  alwaysIgnore: Object.freeze(orderedEntries.filter(({ classification }) =>
    classification === 'always-ignore').map(({ pattern }) => pattern)),
  alwaysTrack: Object.freeze(orderedEntries.filter(({ classification }) =>
    classification === 'always-track').map(({ pattern }) => pattern)),
  policyTrack: Object.freeze(orderedEntries.filter(({ classification }) =>
    classification === 'policy-track').map(({ pattern }) => pattern)),
});

function validRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path !== path.normalize('NFC') ||
      path.startsWith('/') || path.includes('\\') || containsControl(path)) {
    return false;
  }
  const segments = path.split('/');
  return segments.length <= 16 && segments.every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..');
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function segmentMatches(pattern: string, value: string): boolean {
  let patternOffset = 0;
  let valueOffset = 0;
  let wildcard = -1;
  let wildcardValue = -1;
  while (valueOffset < value.length) {
    if (pattern[patternOffset] === value[valueOffset]) {
      patternOffset += 1;
      valueOffset += 1;
    } else if (pattern[patternOffset] === '*') {
      wildcard = patternOffset;
      wildcardValue = valueOffset;
      patternOffset += 1;
    } else if (wildcard >= 0) {
      patternOffset = wildcard + 1;
      wildcardValue += 1;
      valueOffset = wildcardValue;
    } else {
      return false;
    }
  }
  while (pattern[patternOffset] === '*') patternOffset += 1;
  return patternOffset === pattern.length;
}

function globMatches(pattern: string, path: string): boolean {
  const patterns = pattern.split('/');
  const values = path.split('/');
  const visit = (patternOffset: number, valueOffset: number): boolean => {
    const current = patterns[patternOffset];
    if (current === undefined) return valueOffset === values.length;
    if (current === '**') {
      for (let offset = valueOffset; offset <= values.length; offset += 1) {
        if (visit(patternOffset + 1, offset)) return true;
      }
      return false;
    }
    const value = values[valueOffset];
    return value !== undefined && segmentMatches(current, value) &&
      visit(patternOffset + 1, valueOffset + 1);
  };
  return visit(0, 0);
}

function packageMatches(identity: CompilerPackageIdentity): boolean {
  return identity.upstreamPackage === LLM_WIKI_COMPILER_PACKAGE &&
    identity.exactVersion === LLM_WIKI_COMPILER_VERSION &&
    identity.packageIntegrity === LLM_WIKI_COMPILER_INTEGRITY;
}

export class TrackingPolicyClassifier {
  readonly #policy: KnowledgeTrackingPolicyV1;

  constructor(policy: KnowledgeTrackingPolicyV1 = KNOWLEDGE_TRACKING_POLICY) {
    this.#policy = policy;
  }

  classify(
    relativePath: string,
    packageIdentity: CompilerPackageIdentity,
    options: TrackingSelectionOptions = {},
  ): TrackingClassificationResult {
    if (!packageMatches(packageIdentity)) {
      return { code: 'TRACKING_PACKAGE_INTEGRITY_MISMATCH', ok: false };
    }
    if (!validRelativePath(relativePath)) {
      return { code: 'TRACKING_PATH_UNCLASSIFIED', ok: false };
    }
    const matches = this.#policy.entries.filter((entry) => entry.classification === 'always-ignore'
      ? globMatches(entry.pattern.toLowerCase(), relativePath.toLowerCase())
      : globMatches(entry.pattern, relativePath));
    if (matches.length === 0) return { code: 'TRACKING_PATH_UNCLASSIFIED', ok: false };
    if (matches.length !== 1) return { code: 'TRACKING_PATH_AMBIGUOUS', ok: false };
    const match = matches[0];
    if (match === undefined) return { code: 'TRACKING_PATH_UNCLASSIFIED', ok: false };
    return {
      classification: match.classification,
      disposition: match.classification === 'always-track' ||
        (match.classification === 'policy-track' && options.includePolicyTrack === true)
        ? 'include'
        : 'exclude',
      entryId: match.id,
      ok: true,
    };
  }
}

export function classifyTrackingPath(
  relativePath: string,
  packageIdentity: CompilerPackageIdentity,
  options: TrackingSelectionOptions = {},
): TrackingClassificationResult {
  return new TrackingPolicyClassifier().classify(relativePath, packageIdentity, options);
}

export function classifyProjectTrackingPath(
  projectId: string,
  projectRelativePath: string,
  packageIdentity: CompilerPackageIdentity,
  options: TrackingSelectionOptions = {},
): TrackingClassificationResult {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(projectId)) {
    return { code: 'TRACKING_PATH_UNCLASSIFIED', ok: false };
  }
  return classifyTrackingPath(
    `projects/${projectId}/${projectRelativePath}`,
    packageIdentity,
    options,
  );
}

export function assessSemanticCacheState(input: {
  readonly embeddingsCachePresent: boolean;
  readonly identityMarkerPresent: boolean;
}): SemanticCacheState {
  if (!input.identityMarkerPresent) return 'identity-marker-missing';
  return input.embeddingsCachePresent ? 'compatible-candidate' : 'embedding-cache-missing';
}

function assertExistingIgnorePolicy(status: Awaited<ReturnType<typeof lstat>>): void {
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Knowledge .gitignore is unsafe.');
  }
}

export async function ensureKnowledgeIgnorePolicy(
  knowledgeRoot: string,
): Promise<'created' | 'existing'> {
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const path = join(root, '.gitignore');
  try {
    assertExistingIgnorePolicy(await lstat(path));
    return 'existing';
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      if (error instanceof KnowledgeError) {
        throw error;
      }
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to inspect knowledge .gitignore.', {
        cause: error,
      });
    }
  }
  try {
    await writeFile(path, KNOWLEDGE_GITIGNORE, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
      mode: 0o600,
    });
    await syncDirectory(root);
    return 'created';
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      try {
        assertExistingIgnorePolicy(await lstat(path));
        return 'existing';
      } catch (inspectionError) {
        if (inspectionError instanceof KnowledgeError) {
          throw inspectionError;
        }
        throw new KnowledgeError(
          'PATH_OUTSIDE_KNOWLEDGE',
          'Unable to inspect concurrent knowledge .gitignore.',
          { cause: inspectionError },
        );
      }
    }
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to create knowledge ignore policy.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }
}
