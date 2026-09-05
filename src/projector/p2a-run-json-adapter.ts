import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { validateP2aCurrentSpec, validateP2aSpec } from './p2a-codecs.js';
import {
  JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
  registerJsonKnowledgeReferenceAdapter,
  type JsonKnowledgeAdapterCandidateDraftV1,
  type JsonKnowledgeAdapterEntryV1,
  type RegisteredJsonKnowledgeAdapterV1,
} from './json-knowledge-adapter.js';
import {
  decodeP2aRun,
  decodeP2aRunIndex,
  decodeP2aTaskGraph,
  decodeP2aCurrentDevelopmentContract,
  canonicalExecutionJson,
  p2aExecutionEnvelopeSha256,
  resolveTaskLineage,
} from './p2a-execution-codecs.js';
import type { ObservedP2aRun, P2aRunIndex, P2aRunIndexEntry } from './execution-types.js';
import {
  RAW_SOURCE_PATH_REDACTION_RULE_IDS,
  type RawSourceInputV1,
} from './raw-source-inputs.js';
import {
  MAX_SOURCE_METADATA_BYTES,
  MAX_SOURCE_METADATA_DEPTH,
  MAX_SOURCE_METADATA_KEYS,
  SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
  validatePortableSourceRef,
} from './source-contracts.js';
import { unicodeScalarLength } from './text-units.js';
import { MAX_SOURCE_ORIGIN_MAPPINGS } from './types.js';
import {
  P2A_RUN_INDEX_SUFFIX,
  P2A_RUN_SOURCE_ADAPTER_ID,
  type P2aRunInputClosure,
} from './p2a-run-input-closure.js';

export { P2A_RUN_SOURCE_ADAPTER_ID } from './p2a-run-input-closure.js';

interface DecodedEntry {
  readonly entry: JsonKnowledgeAdapterEntryV1;
  readonly finalVerification: boolean;
  readonly productRevision: string | null;
  readonly run: ObservedP2aRun;
  readonly normal: boolean;
  readonly workspaceRevision: string | null;
}

interface DecodedIndexEntry {
  readonly entry: JsonKnowledgeAdapterEntryV1;
  readonly index: P2aRunIndex;
}

interface DecodedGraphEntry {
  readonly entry: JsonKnowledgeAdapterEntryV1;
  readonly graph: Readonly<{
    readonly projectId: string;
    readonly sourceSpec: string;
    readonly tasks: readonly Record<string, unknown>[];
    readonly version: string;
  }>;
}

interface DecodedSpecEntry {
  readonly entry: JsonKnowledgeAdapterEntryV1;
  readonly effectiveSpecRef?: string;
  readonly kind: 'approved' | 'current';
}

interface DecodedDevelopmentContractEntry {
  readonly entry: JsonKnowledgeAdapterEntryV1;
}

interface ResolvedEnvelope {
  readonly sourceRef?: string;
  readonly value: Readonly<Record<string, unknown>>;
}

interface VerifiedRun {
  readonly item: DecodedEntry;
  readonly lineageInputSourceRefs: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function optionalDigest(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function decode(entry: JsonKnowledgeAdapterEntryV1, projectId: string): DecodedEntry | null {
  const result = decodeP2aRun(entry.value, projectId);
  if (!result.ok || !isRecord(entry.value)) return null;
  return Object.freeze({
    entry,
    finalVerification: entry.value.runKind === 'final_verification',
    productRevision: optionalDigest(
      entry.value.productRevisionSha256 ?? entry.value.startProductRevisionSha256,
    ),
    run: result.value,
    normal: result.value.runKind === null,
    workspaceRevision: optionalDigest(entry.value.workspaceRevisionSha256),
  });
}

function decodeIndex(
  entry: JsonKnowledgeAdapterEntryV1,
  projectId: string,
): DecodedIndexEntry | null {
  const result = decodeP2aRunIndex(entry.value, projectId);
  return result.ok ? Object.freeze({ entry, index: result.value }) : null;
}

function decodeGraph(
  entry: JsonKnowledgeAdapterEntryV1,
  projectId: string,
): DecodedGraphEntry | null {
  const result = decodeP2aTaskGraph(entry.value, projectId);
  return result.ok ? Object.freeze({ entry, graph: result.value }) : null;
}

function decodeSpec(
  entry: JsonKnowledgeAdapterEntryV1,
  projectId: string,
): DecodedSpecEntry | null {
  if (!isRecord(entry.value) || entry.value.schema_version !== 'p2a.spec.v1') return null;
  try {
    validateP2aSpec(entry.value, projectId);
    return Object.freeze({ entry, kind: 'approved' as const });
  } catch {
    return null;
  }
}

function decodeCurrentSpec(
  entry: JsonKnowledgeAdapterEntryV1,
  projectId: string,
): DecodedSpecEntry | null {
  if (!isRecord(entry.value) || entry.value.schema_version !== 'p2a.current_spec.v1') return null;
  try {
    validateP2aCurrentSpec(entry.value, projectId);
    if (typeof entry.value.effective_spec_ref !== 'string' ||
        !Array.isArray(entry.value.open_decisions) || entry.value.open_decisions.length > 0) return null;
    return Object.freeze({
      effectiveSpecRef: validatePortableSourceRef(entry.value.effective_spec_ref),
      entry,
      kind: 'current' as const,
    });
  } catch {
    return null;
  }
}

function decodeDevelopmentContract(
  entry: JsonKnowledgeAdapterEntryV1,
  projectId: string,
): DecodedDevelopmentContractEntry | null {
  const result = decodeP2aCurrentDevelopmentContract(entry.value, projectId);
  return result.ok ? Object.freeze({ entry }) : null;
}

function isRunTreeSourceRef(sourceRef: string): boolean {
  return sourceRef.startsWith('runs/') || sourceRef.includes('/runs/');
}

function isEnvelopeSourceRef(sourceRef: string): boolean {
  return /(?:^|\/)envelopes\/[a-f0-9]{64}\.json$/u.test(sourceRef);
}

function isRecognizedShape(entry: JsonKnowledgeAdapterEntryV1): boolean {
  if (isRunTreeSourceRef(entry.sourceRef)) return true;
  if (!isRecord(entry.value)) return false;
  return entry.value.schema_version === 'p2a.task_graph.v1' ||
    entry.value.schema_version === 'p2a.spec.v1' ||
    entry.value.schema_version === 'p2a.current_spec.v1' ||
    entry.value.schema_version === 'p2a.current_development_contract.v1' ||
    isEnvelopeSourceRef(entry.sourceRef);
}

function indexedSourceRef(indexSourceRef: string, runRef: string): string | null {
  try {
    return validatePortableSourceRef(posix.normalize(posix.join(
      posix.dirname(indexSourceRef),
      runRef,
    )));
  } catch {
    return null;
  }
}

function artifactRoot(indexSourceRef: string): string | null {
  const suffix = 'runs/run-index.json';
  if (!indexSourceRef.endsWith(suffix)) return null;
  return indexSourceRef.slice(0, -suffix.length).replace(/\/$/u, '');
}

function artifactSourceRef(indexSourceRef: string, reference: string): string | null {
  const root = artifactRoot(indexSourceRef);
  if (root === null) return null;
  try {
    return validatePortableSourceRef(posix.normalize(posix.join(root, reference)));
  } catch {
    return null;
  }
}

function referencedSourceRef(sourceRef: string, reference: string): string | null {
  try {
    return validatePortableSourceRef(posix.normalize(posix.join(posix.dirname(sourceRef), reference)));
  } catch {
    return null;
  }
}

function exactIndexMatch(summary: P2aRunIndexEntry, run: ObservedP2aRun): boolean {
  return summary.runId === run.runId && summary.taskId === run.taskId &&
    summary.iterationId === run.iterationId && summary.status === run.status &&
    summary.startedAt === run.startedAt && summary.finishedAt === run.finishedAt &&
    summary.agentTool === run.agentTool && summary.taskGraphRef === run.taskGraphRef &&
    summary.workspaceRef === run.workspaceRef && summary.runKind === run.runKind;
}

function referencedEnvelope(
  item: DecodedEntry,
  entriesBySourceRef: ReadonlyMap<string, JsonKnowledgeAdapterEntryV1>,
): ResolvedEnvelope | null | undefined {
  if (item.run.sourceLayout === 'maintenance') return null;
  if (item.run.embeddedExecutionEnvelope !== undefined) {
    return Object.freeze({ value: item.run.embeddedExecutionEnvelope });
  }
  const referenceSha256 = item.run.executionEnvelopeReferenceSha256;
  if (referenceSha256 === undefined) return undefined;
  const sourceRef = referencedSourceRef(
    item.entry.sourceRef,
    `envelopes/${referenceSha256}.json`,
  );
  const envelope = sourceRef === null ? undefined : entriesBySourceRef.get(sourceRef);
  if (envelope === undefined || p2aExecutionEnvelopeSha256(envelope.value) !== referenceSha256 ||
      !isRecord(envelope.value)) {
    return undefined;
  }
  return Object.freeze({ sourceRef: sourceRef as string, value: envelope.value });
}

function entryMatchesDigest(entry: JsonKnowledgeAdapterEntryV1, digest: string): boolean {
  return entry.contentHash === `sha256:${digest}` ||
    sha256(JSON.stringify(entry.value)) === digest ||
    sha256(canonicalExecutionJson(entry.value)) === digest;
}

function envelopeGateRefs(value: Readonly<Record<string, unknown>>): readonly Readonly<{
  path: string;
  sha256: string;
}>[] | null {
  if (!Array.isArray(value.sourceGateRefs)) return null;
  const result = value.sourceGateRefs.map((item) => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string') {
      return null;
    }
    return Object.freeze({ path: item.path, sha256: item.sha256 });
  });
  return result.some((item) => item === null)
    ? null
    : result as readonly Readonly<{ path: string; sha256: string }>[];
}

function resolveGateReference(
  reference: Readonly<{ path: string; sha256: string }>,
  indexSourceRef: string,
  graphRef: string,
  specRef: string,
  entriesBySourceRef: ReadonlyMap<string, JsonKnowledgeAdapterEntryV1>,
): string | null {
  const candidates = [...new Set([
    artifactSourceRef(indexSourceRef, reference.path),
    referencedSourceRef(graphRef, reference.path),
    referencedSourceRef(specRef, reference.path),
  ].filter((sourceRef): sourceRef is string => sourceRef !== null))];
  const matches = candidates.filter((sourceRef) => {
    const entry = entriesBySourceRef.get(sourceRef);
    return entry !== undefined && entryMatchesDigest(entry, reference.sha256);
  });
  return matches.length === 1 ? matches[0] ?? null : null;
}

function verifyRunLineage(
  item: DecodedEntry,
  indexSourceRef: string,
  graphsBySourceRef: ReadonlyMap<string, DecodedGraphEntry>,
  specsBySourceRef: ReadonlyMap<string, DecodedSpecEntry>,
  contractsBySourceRef: ReadonlyMap<string, DecodedDevelopmentContractEntry>,
  entriesBySourceRef: ReadonlyMap<string, JsonKnowledgeAdapterEntryV1>,
): readonly string[] | null {
  const graphRef = artifactSourceRef(indexSourceRef, item.run.taskGraphRef);
  if (graphRef === null) return null;
  const graph = graphsBySourceRef.get(graphRef);
  if (graph === undefined || graph.graph.version !== item.run.iterationId ||
      graph.graph.sourceSpec !== item.run.sourceSpecRef) return null;
  const specRef = referencedSourceRef(graphRef, graph.graph.sourceSpec);
  if (specRef === null) return null;
  const graphSpec = specsBySourceRef.get(specRef);
  if (graphSpec === undefined) return null;
  const effectiveSpecRef = graphSpec.kind === 'current'
    ? referencedSourceRef(specRef, graphSpec.effectiveSpecRef ?? '')
    : specRef;
  if (effectiveSpecRef === null) return null;
  const spec = specsBySourceRef.get(effectiveSpecRef);
  if (spec === undefined || spec.kind !== 'approved') return null;
  const lineage = resolveTaskLineage(
    graph.graph,
    graphRef,
    graph.entry.contentHash,
    effectiveSpecRef,
    spec.entry.contentHash,
    item.run,
  );
  if (!lineage.ok || lineage.value.taskTitle !== item.run.taskTitle) return null;
  const envelope = referencedEnvelope(item, entriesBySourceRef);
  if (envelope === undefined) return null;
  const inputRefs = [graphRef, specRef, effectiveSpecRef];
  if (envelope?.sourceRef !== undefined) inputRefs.push(envelope.sourceRef);
  if (envelope !== null) {
    const gateRefs = envelopeGateRefs(envelope.value);
    if (gateRefs === null) return null;
    for (const gateRef of gateRefs) {
      const resolved = resolveGateReference(
        gateRef,
        indexSourceRef,
        graphRef,
        effectiveSpecRef,
        entriesBySourceRef,
      );
      if (resolved === null) return null;
      inputRefs.push(resolved);
    }
  }
  if (item.run.currentDevelopmentContractRef !== undefined &&
      item.run.currentDevelopmentContractSha256 !== undefined) {
    const contractRef = artifactSourceRef(
      indexSourceRef,
      item.run.currentDevelopmentContractRef,
    );
    const contract = contractRef === null ? undefined : contractsBySourceRef.get(contractRef);
    if (contract === undefined ||
        !entryMatchesDigest(contract.entry, item.run.currentDevelopmentContractSha256)) return null;
    inputRefs.push(contractRef as string);
  }
  return Object.freeze([...new Set(inputRefs)].sort(compareText));
}

function sameFinalLineage(normal: DecodedEntry, finalRun: DecodedEntry): boolean {
  return finalRun.finalVerification &&
    normal.run.projectId === finalRun.run.projectId &&
    normal.run.iterationId === finalRun.run.iterationId &&
    normal.run.taskId === finalRun.run.taskId &&
    normal.run.taskContractSha256 === finalRun.run.taskContractSha256 &&
    normal.workspaceRevision !== null &&
    normal.workspaceRevision === finalRun.workspaceRevision &&
    normal.productRevision !== null &&
    normal.productRevision === finalRun.productRevision &&
    (normal.run.gitHeadSha === undefined || finalRun.run.gitHeadSha === undefined ||
      normal.run.gitHeadSha === finalRun.run.gitHeadSha) &&
    finalRun.run.verification.every((verification) =>
      verification.status !== 'passed' ||
      (verification.workspaceRevisionSha256 === undefined ||
        verification.workspaceRevisionSha256 === finalRun.workspaceRevision) &&
      (verification.productRevisionSha256 === undefined ||
        verification.productRevisionSha256 === finalRun.productRevision) &&
      (verification.gitHeadSha === undefined || finalRun.run.gitHeadSha === undefined ||
        verification.gitHeadSha === finalRun.run.gitHeadSha));
}

function compactOrigins(
  origins: JsonKnowledgeAdapterCandidateDraftV1['origins'],
): JsonKnowledgeAdapterCandidateDraftV1['origins'] {
  if (origins.length <= MAX_SOURCE_ORIGIN_MAPPINGS) return origins;
  const compacted: JsonKnowledgeAdapterCandidateDraftV1['origins'][number][] = [];
  let groupParent: string | null = null;
  for (const origin of origins) {
    const parent = origin.jsonPointer.slice(0, origin.jsonPointer.lastIndexOf('/'));
    const previous = compacted.at(-1);
    // Merge only adjacent siblings from the same JSON container and input file.
    // Keep later resolution/verification sections; never silently drop mappings.
    if (parent !== '' && parent === groupParent && previous !== undefined &&
        previous.sourceRef === origin.sourceRef &&
        previous.canonical.endLine + 1 === origin.canonical.startLine) {
      compacted[compacted.length - 1] = Object.freeze({
        canonical: Object.freeze({
          ...previous.canonical,
          endColumn: origin.canonical.endColumn,
          endLine: origin.canonical.endLine,
        }),
        jsonPointer: parent,
        sourceRef: origin.sourceRef,
      });
    } else {
      compacted.push(origin);
    }
    groupParent = parent;
  }
  // The shared adapter validator still fails closed if independent origins
  // exceed the contract limit even after lossless container-range compaction.
  return Object.freeze(compacted);
}

function renderGroup(
  normalRuns: readonly VerifiedRun[],
  finalRuns: readonly VerifiedRun[],
  indexSourceRef: string,
): JsonKnowledgeAdapterCandidateDraftV1 | null {
  const completed = normalRuns.filter((item) => item.item.run.status !== 'started');
  if (completed.length === 0) return null;
  const latest = completed.at(-1);
  if (latest === undefined) return null;
  const matchedFinals = finalRuns.filter((item) => sameFinalLineage(latest.item, item.item));
  const included = [...completed, ...matchedFinals].sort((left, right) => compareText(
    `${left.item.run.startedAt}\u0000${left.item.run.runId}`,
    `${right.item.run.startedAt}\u0000${right.item.run.runId}`,
  ));
  const lines: string[] = [];
  const origins: JsonKnowledgeAdapterCandidateDraftV1['origins'][number][] = [];
  const emit = (line: string, item: DecodedEntry, pointer: string): void => {
    const resolvedPointer = item.entry.locations.some((location) => location.pointer === pointer)
      ? pointer
      : '';
    const lineNumber = lines.length + 1;
    lines.push(line);
    origins.push(Object.freeze({
      canonical: Object.freeze({
        endColumn: unicodeScalarLength(line) + 1,
        endLine: lineNumber,
        startColumn: 1,
        startLine: lineNumber,
      }),
      jsonPointer: resolvedPointer,
      sourceRef: item.entry.sourceRef,
    }));
  };

  emit('## Attempts', completed[0]!.item, '');
  for (const { item } of completed) {
    emit(`### ${item.run.runId}`, item, '/runId');
    emit(`Status: ${item.run.status}`, item, '/status');
    if (item.run.failureClass !== undefined) {
      emit(`Failure: ${item.run.failureClass}`, item, '/failure/class');
    }
    item.run.changedFiles.forEach((path, index) =>
      emit(`Changed: ${path}`, item, `/changedFiles/${String(index)}`));
    item.run.fixSummaries.forEach((summary, index) =>
      emit(`Resolution: ${summary}`, item, `/fixSummary/summaries/${String(index)}`));
    item.run.reproductionSteps.forEach((step, index) =>
      emit(`Failure evidence: ${step}`, item, `/reproduction/steps/${String(index)}`));
    item.run.guardChecks.forEach((guard, index) =>
      emit(`Regression guard: ${guard}`, item, `/guard/checks/${String(index)}`));
  }

  const verificationKeys = new Set<string>();
  const verificationItems = included.flatMap(({ item }) =>
    item.run.verification.map((verification, index) => ({ index, item, verification })));
  const deduplicated = verificationItems.filter(({ verification }) => {
    const key = [verification.type, verification.command, verification.status,
      String(verification.exitCode), verification.scope ?? '',
      verification.workspaceRevisionSha256 ?? '', verification.productRevisionSha256 ?? '',
      verification.gitHeadSha ?? ''].join('\u0000');
    if (verificationKeys.has(key)) return false;
    verificationKeys.add(key);
    return true;
  });
  if (deduplicated.length > 0) emit('## Verification', deduplicated[0]!.item, '');
  for (const { index, item, verification } of deduplicated) {
    emit(
      `${verification.type}: ${verification.command} — ${verification.status}`,
      item,
      `/verification/${String(index)}`,
    );
  }
  const inputSourceRefs = [...new Set([
    indexSourceRef,
    ...included.flatMap(({ item, lineageInputSourceRefs }) => [
      item.entry.sourceRef,
      ...lineageInputSourceRefs,
    ]),
  ])].sort(compareText);
  return Object.freeze({
    body: lines.join('\n'),
    inputSourceRefs: Object.freeze(inputSourceRefs),
    logicalId: `task-${sha256([
      latest.item.run.iterationId,
      latest.item.run.taskId,
      latest.item.run.taskContractSha256,
    ].join('\u0000'))}`,
    origins: compactOrigins(Object.freeze(origins)),
    retrievalMeaning: Object.freeze({
      authority: 'supporting',
      evidenceKind: 'execution',
      iterationGroup: latest.item.run.iterationId,
      lifecycle: 'current',
      revisionOrdinal: completed.length,
      schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
      supersededBySourceRefs: Object.freeze([]),
      supersedesSourceRefs: Object.freeze([]),
      topicGroup: `task.${latest.item.run.taskId}`,
    }),
    title: latest.item.run.taskTitle,
  });
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

const P2A_TECHNICAL_TOKEN_PATTERN =
  /(?<![A-Za-z0-9+.-])(?:https?:\/\/[^\s<>"'`]+|[A-Za-z0-9_+./=-]{20,})/giu;

function segmentTechnicalReference(value: string): string {
  return value.replaceAll('/', ' / ');
}

function p2aTechnicalTaxonomy(value: string): boolean {
  if (value.length < 20 || value.length > 256 || value.startsWith('/') ||
      value.endsWith('/') || value.includes('//')) return false;
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > 4) return false;
  return segments.every((segment) => segment.length >= 2 && segment.length <= 16 && (
    /^[a-z]{2,16}$/u.test(segment) ||
    /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/u.test(segment) ||
    /^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/u.test(segment) ||
    /^[A-Z][A-Za-z]{1,15}$/u.test(segment)
  ));
}

function segmentTechnicalTaxonomies(value: string): string {
  P2A_TECHNICAL_TOKEN_PATTERN.lastIndex = 0;
  return value.replace(P2A_TECHNICAL_TOKEN_PATTERN, (token) => {
    if (token === 'p2aRunJsonKnowledgeAdapter') return '<verified-adapter-symbol>';
    return p2aTechnicalTaxonomy(token) ? segmentTechnicalReference(token) : token;
  });
}

function technicalSecurityKey(
  schemaVersion: string | undefined,
  pointer: string,
  value: string,
): string {
  if (schemaVersion !== 'p2a.current_spec.v1') return value;
  if ((pointer === '/gate_b_approval_audits' || pointer === '/gate_b_promotion_bindings') &&
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(value)) {
    return value.replaceAll('-', ' - ');
  }
  if (pointer === '/pending_iteration/resume_authority' &&
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(value)) {
    return value.replaceAll('_', ' _ ');
  }
  return value;
}

interface P2aRawSecurityState {
  readonly artifactRoot: string;
  readonly commandTokens: ReadonlyMap<number, ReadonlySet<string>>;
  readonly workspacePath: string;
}

function p2aArtifactRoot(sourceRefs: readonly string[]): string {
  const indexSourceRef = sourceRefs.find((sourceRef) => sourceRef.endsWith(P2A_RUN_INDEX_SUFFIX));
  if (indexSourceRef === undefined) return '';
  return indexSourceRef.slice(0, -P2A_RUN_INDEX_SUFFIX.length).replace(/\/$/u, '');
}

function p2aCommandTokens(value: unknown): ReadonlyMap<number, ReadonlySet<string>> {
  const result = new Map<number, ReadonlySet<string>>();
  if (!isRecord(value) || !Array.isArray(value.verification)) return result;
  value.verification.forEach((verification, index) => {
    if (!isRecord(verification) || typeof verification.command !== 'string') return;
    P2A_TECHNICAL_TOKEN_PATTERN.lastIndex = 0;
    result.set(index, new Set(
      [...verification.command.matchAll(P2A_TECHNICAL_TOKEN_PATTERN)].map((match) => match[0]),
    ));
  });
  return result;
}

function segmentVerifiedStdoutPaths(
  value: string,
  pointer: string,
  state: P2aRawSecurityState,
): string {
  const match = /^\/verification\/([0-9]+)\/stdoutTail$/u.exec(pointer);
  if (match === null) return value;
  const commandTokens = state.commandTokens.get(Number(match[1]));
  P2A_TECHNICAL_TOKEN_PATTERN.lastIndex = 0;
  return value.replace(P2A_TECHNICAL_TOKEN_PATTERN, (token) => {
    const isArtifactRoot = state.artifactRoot.length >= 20 && token === state.artifactRoot;
    const isCommandOutputPath = state.workspacePath.length > 0 &&
      token.startsWith(`${state.workspacePath}/`) &&
      [...commandTokens ?? []].some((commandToken) => token.endsWith(commandToken));
    return isArtifactRoot || isCommandOutputPath ? segmentTechnicalReference(token) : token;
  });
}

function technicalSecurityValue(
  schemaVersion: string | undefined,
  pointer: string,
  value: string,
  state: P2aRawSecurityState,
): string | null {
  const digest = /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
  const gitSha = /^[a-f0-9]{40}$/u.test(value);
  const runId = /^run-[A-Za-z0-9._-]+$/u.test(value);
  const portableReference = value.length <= 1_024 && !value.includes('\\') &&
    !/^[A-Za-z]:/u.test(value);
  if (schemaVersion === 'p2a.run.v2') {
    if (digest && (
      /^\/(?:acceptanceReviewEvidenceSha256|currentDevelopmentContractSha256|executionEnvelopeSha256|monitorVerdictEvidenceSha256|productRevisionSha256|startProductRevisionSha256|taskContractSha256|visualReviewEvidenceSha256|workspaceRevisionSha256)$/u.test(pointer) ||
      /^\/executionEnvelopeRef\/sha256$/u.test(pointer) ||
      /^\/verification\/[0-9]+\/(?:productRevisionSha256|relatedFilesSha256|workspaceRevisionSha256)$/u.test(pointer)
    )) return '<verified-digest>';
    if (gitSha && (
      pointer === '/git/headSha' || /^\/verification\/[0-9]+\/gitHeadSha$/u.test(pointer)
    )) return '<verified-git-revision>';
    if (runId && pointer === '/runId') return '<verified-run-id>';
    if (portableReference && /^\/(?:currentDevelopmentContractRef|sourceSpecRef|taskGraphRef)$/u.test(pointer)) {
      return segmentTechnicalReference(value);
    }
    if (/^\/verification\/[0-9]+\/stdoutTail$/u.test(pointer)) {
      return segmentVerifiedStdoutPaths(value, pointer, state);
    }
  }
  if (schemaVersion === 'p2a.run_index.v1') {
    if (runId && (
      /^\/runs\/[0-9]+\/runId$/u.test(pointer) ||
      /^\/tasks\/[0-9]+\/(?:latestRunId|runIds\/[0-9]+)$/u.test(pointer)
    )) return '<verified-run-id>';
    if (portableReference && /^\/runs\/[0-9]+\/(?:runRef|taskGraphRef)$/u.test(pointer)) {
      return segmentTechnicalReference(value);
    }
  }
  if (schemaVersion === 'p2a.task_graph.v1' && portableReference && pointer === '/sourceSpec') {
    return segmentTechnicalReference(value);
  }
  if (schemaVersion === 'p2a.spec.v1' && digest && pointer === '/source_intake_sha256') {
    return '<verified-digest>';
  }
  if (schemaVersion === 'p2a.current_spec.v1') {
    if (digest && (
      /^\/closed_iterations\/[0-9]+\/artifact_hashes\/[^/]+\/sha256$/u.test(pointer) ||
      /^\/gate_b_promotion_bindings\/[^/]+\/source_spec_sha256$/u.test(pointer)
    )) return '<verified-digest>';
    if (portableReference && (
      pointer === '/effective_spec_ref' ||
      /^\/closed_iterations\/[0-9]+\/(?:effective_spec_ref|spec_ref|task_graph_ref)$/u.test(pointer) ||
      /^\/gate_b_promotion_bindings\/[^/]+\/source_spec_ref$/u.test(pointer)
    )) return segmentTechnicalReference(value);
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(value) &&
        /^\/closed_iterations\/[0-9]+\/iteration_id$/u.test(pointer)) {
      return value.replaceAll('-', ' - ');
    }
  }
  if (schemaVersion === 'p2a.current_development_contract.v1') {
    if (digest && (
      /^\/bindings\/(?:activeSpec|constitution)\/sha256$/u.test(pointer) ||
      /^\/bindings\/taskGraph\/tasks\/[0-9]+\/sha256$/u.test(pointer)
    )) return '<verified-digest>';
    if (portableReference && /^\/bindings\/(?:activeSpec|constitution|taskGraph)\/ref$/u.test(pointer)) {
      return segmentTechnicalReference(value);
    }
  }
  if (schemaVersion === undefined) {
    if (digest && /^\/sourceGateRefs\/[0-9]+\/sha256$/u.test(pointer)) {
      return '<verified-digest>';
    }
    if (portableReference && /^\/sourceGateRefs\/[0-9]+\/path$/u.test(pointer)) {
      return segmentTechnicalReference(value);
    }
  }
  if (
    (
      schemaVersion === 'p2a.current_development_contract.v1' &&
      /^(?:\/iterationConstraints\/(?:architecture|dependencies)\/[0-9]+|\/mustPreserve\/[0-9]+)$/u
        .test(pointer)
    ) || (
      schemaVersion === 'p2a.spec.v1' &&
      /^(?:\/implementation\/(?:architecture|dependencies)\/[0-9]+|\/product\/must_preserve\/[0-9]+)$/u
        .test(pointer)
    ) || (
      schemaVersion === undefined &&
      /^(?:\/(?:architecture|dependencies|mustPreserve)\/[0-9]+|\/iterationConstraints\/(?:architecture|dependencies)\/[0-9]+)$/u
        .test(pointer)
    ) || (
      schemaVersion === 'p2a.run.v2' &&
      /^\/executionEnvelope\/(?:mustPreserve\/[0-9]+|iterationConstraints\/(?:architecture|dependencies)\/[0-9]+)$/u
        .test(pointer)
    )
  ) {
    const segmented = segmentTechnicalTaxonomies(value);
    if (segmented !== value) return segmented;
  }
  return null;
}

function rawSecurityValue(
  value: unknown,
  schemaVersion: string | undefined,
  state: P2aRawSecurityState,
  pointer = '',
): unknown {
  if (typeof value === 'string') {
    return technicalSecurityValue(schemaVersion, pointer, value, state) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      rawSecurityValue(entry, schemaVersion, state, `${pointer}/${String(index)}`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((childKey) => {
      const childPointer = `${pointer}/${pointerSegment(childKey)}`;
      return [
        technicalSecurityKey(schemaVersion, pointer, childKey),
        rawSecurityValue(value[childKey], schemaVersion, state, childPointer),
      ];
    }));
  }
  return value;
}

function p2aRawSecurityInput(
  entry: JsonKnowledgeAdapterEntryV1,
  context: Readonly<{
    closure: P2aRunInputClosure | null;
    lineageVerified: boolean;
    projectId: string;
  }>,
): RawSourceInputV1 {
  const schemaVersion = isRecord(entry.value) && typeof entry.value.schema_version === 'string'
    ? entry.value.schema_version
    : undefined;
  const closureEntry = context.closure?.entries.find((candidate) =>
    candidate.sourceRef === entry.sourceRef && candidate.contentHash === entry.contentHash);
  const proofBound = context.lineageVerified && context.closure !== null &&
    context.closure.projectId === context.projectId && closureEntry !== undefined &&
    /^sha256:[a-f0-9]{64}$/u.test(context.closure.closureDigest);
  const state = Object.freeze({
    artifactRoot: p2aArtifactRoot(context.closure?.entries.map(({ sourceRef }) => sourceRef) ?? []),
    commandTokens: p2aCommandTokens(entry.value),
    workspacePath: isRecord(entry.value) && typeof entry.value.workspacePath === 'string'
      ? entry.value.workspacePath
      : '',
  });
  return Object.freeze({
    allowedRedactionRuleIds: RAW_SOURCE_PATH_REDACTION_RULE_IDS,
    body: serializeCanonicalJson(proofBound
      ? rawSecurityValue(entry.value, schemaVersion, state)
      : entry.value),
  });
}

/** Official optional reference adapter built on the same public JSON adapter contract. */
export function p2aRunJsonKnowledgeAdapter(): RegisteredJsonKnowledgeAdapterV1 {
  return registerJsonKnowledgeReferenceAdapter({
    contractVersion: JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
    matches(entry) {
      return isRecognizedShape(entry);
    },
    project(input) {
      const candidates: JsonKnowledgeAdapterCandidateDraftV1[] = [];
      const decisions = new Map<string, Readonly<{
        decision: 'exclude' | 'quarantine';
        reasonCode: string;
        sourceRef: string;
      }>>();
      const decide = (
        entry: JsonKnowledgeAdapterEntryV1,
        decision: 'exclude' | 'quarantine',
        reasonCode: string,
      ): void => {
        if (!decisions.has(entry.sourceRef)) {
          decisions.set(entry.sourceRef, Object.freeze({ decision, reasonCode, sourceRef: entry.sourceRef }));
        }
      };
      const entriesBySourceRef = new Map(input.entries.map((entry) => [entry.sourceRef, entry] as const));
      const indices = input.entries.map((entry) => decodeIndex(entry, input.projectId))
        .filter((entry): entry is DecodedIndexEntry => entry !== null);
      const runs = input.entries.map((entry) => decode(entry, input.projectId))
        .filter((entry): entry is DecodedEntry => entry !== null);
      const graphs = input.entries.map((entry) => decodeGraph(entry, input.projectId))
        .filter((entry): entry is DecodedGraphEntry => entry !== null);
      const specs = input.entries.map((entry) => decodeSpec(entry, input.projectId))
        .filter((entry): entry is DecodedSpecEntry => entry !== null);
      const currentSpecs = input.entries.map((entry) => decodeCurrentSpec(entry, input.projectId))
        .filter((entry): entry is DecodedSpecEntry => entry !== null);
      const contracts = input.entries.map((entry) => decodeDevelopmentContract(entry, input.projectId))
        .filter((entry): entry is DecodedDevelopmentContractEntry => entry !== null);
      const recognized = new Set([
        ...indices.map((entry) => entry.entry.sourceRef),
        ...runs.map((entry) => entry.entry.sourceRef),
        ...graphs.map((entry) => entry.entry.sourceRef),
        ...specs.map((entry) => entry.entry.sourceRef),
        ...currentSpecs.map((entry) => entry.entry.sourceRef),
        ...contracts.map((entry) => entry.entry.sourceRef),
        ...input.entries.filter((entry) => isEnvelopeSourceRef(entry.sourceRef) &&
          p2aExecutionEnvelopeSha256(entry.value) !== null).map((entry) => entry.sourceRef),
      ]);
      for (const entry of input.entries) {
        if (!recognized.has(entry.sourceRef)) decide(entry, 'quarantine', 'adapter_schema_unsupported');
      }
      if (indices.length !== 1) {
        for (const entry of input.entries) {
          if (recognized.has(entry.sourceRef)) decide(entry, 'quarantine', 'p2a_lineage_invalid');
        }
        return Object.freeze({ candidates: Object.freeze([]), entries: Object.freeze([...decisions.values()]) });
      }
      const indexEntry = indices[0]!;
      const runBySourceRef = new Map(runs.map((entry) => [entry.entry.sourceRef, entry] as const));
      const graphsBySourceRef = new Map(graphs.map((entry) => [entry.entry.sourceRef, entry] as const));
      const specsBySourceRef = new Map([...specs, ...currentSpecs]
        .map((entry) => [entry.entry.sourceRef, entry] as const));
      const contractsBySourceRef = new Map(contracts
        .map((entry) => [entry.entry.sourceRef, entry] as const));
      const verified: VerifiedRun[] = [];
      let lineageInvalid = false;
      for (const summary of indexEntry.index.runs) {
        const sourceRef = indexedSourceRef(indexEntry.entry.sourceRef, summary.runRef);
        const item = sourceRef === null ? undefined : runBySourceRef.get(sourceRef);
        const lineageInputSourceRefs = item === undefined ? null : verifyRunLineage(
          item,
          indexEntry.entry.sourceRef,
          graphsBySourceRef,
          specsBySourceRef,
          contractsBySourceRef,
          entriesBySourceRef,
        );
        if (item === undefined || !exactIndexMatch(summary, item.run) ||
            lineageInputSourceRefs === null) {
          lineageInvalid = true;
          break;
        }
        verified.push(Object.freeze({ item, lineageInputSourceRefs }));
      }
      if (lineageInvalid || verified.length !== runs.length ||
          new Set(verified.map(({ item }) => item.entry.sourceRef)).size !== runs.length) {
        for (const entry of input.entries) {
          if (recognized.has(entry.sourceRef)) decide(entry, 'quarantine', 'p2a_lineage_invalid');
        }
        return Object.freeze({ candidates: Object.freeze([]), entries: Object.freeze([...decisions.values()]) });
      }

      const normals = verified.filter(({ item }) => item.normal);
      const finals = verified.filter(({ item }) => item.finalVerification);
      const groups = new Map<string, VerifiedRun[]>();
      for (const entry of normals) {
        const key = [entry.item.run.iterationId, entry.item.run.taskId,
          entry.item.run.taskContractSha256].join('\u0000');
        const values = groups.get(key) ?? [];
        values.push(entry);
        groups.set(key, values);
      }
      const referenced = new Set<string>();
      for (const [, group] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
        group.sort((left, right) => compareText(
          `${left.item.run.startedAt}\u0000${left.item.run.runId}`,
          `${right.item.run.startedAt}\u0000${right.item.run.runId}`,
        ));
        const rendered = renderGroup(group, finals, indexEntry.entry.sourceRef);
        if (rendered !== null) {
          candidates.push(rendered);
          rendered.inputSourceRefs.forEach((sourceRef) => referenced.add(sourceRef));
        }
      }
      for (const entry of input.entries) {
        if (referenced.has(entry.sourceRef) || decisions.has(entry.sourceRef)) continue;
        const run = runBySourceRef.get(entry.sourceRef);
        decide(
          entry,
          'exclude',
          run === undefined
            ? 'p2a_support_only'
            : run.finalVerification
              ? 'p2a_final_unmatched'
              : 'p2a_started',
        );
      }
      candidates.sort((left, right) => compareText(left.logicalId, right.logicalId));
      return Object.freeze({
        candidates: Object.freeze(candidates),
        entries: Object.freeze([...decisions.values()].sort((left, right) =>
          compareText(left.sourceRef, right.sourceRef))),
      });
    },
    unmatchedDecision: 'exclude',
    registration: {
      adapterId: P2A_RUN_SOURCE_ADAPTER_ID,
      adapterVersion: 1,
      kinds: [{ kind: 'json', mediaTypes: ['application/json'] }],
      limits: {
        maxMetadataBytes: MAX_SOURCE_METADATA_BYTES,
        maxMetadataDepth: MAX_SOURCE_METADATA_DEPTH,
        maxMetadataKeys: MAX_SOURCE_METADATA_KEYS,
      },
      metadataNamespace: P2A_RUN_SOURCE_ADAPTER_ID,
      metadataSchemaVersion: 'buildlore.p2a-run-metadata.v1',
    },
  }, { rawSecurityInput: p2aRawSecurityInput });
}
