import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import type { Sha256Digest } from '../knowledge/local-project-registry.js';
import { validateP2aCurrentSpec, validateP2aSpec } from './p2a-codecs.js';
import {
  canonicalExecutionJson,
  decodeP2aCurrentDevelopmentContract,
  decodeP2aRun,
  decodeP2aRunIndex,
  decodeP2aTaskGraph,
  p2aExecutionEnvelopeSha256,
  resolveTaskLineage,
} from './p2a-execution-codecs.js';
import type { ObservedP2aRun, P2aRunIndexEntry } from './execution-types.js';
import { validatePortableSourceRef } from './source-contracts.js';

export const P2A_RUN_SOURCE_ADAPTER_ID = 'buildlore.p2a-run' as const;
export const P2A_RUN_INDEX_SUFFIX = 'runs/run-index.json' as const;

export type P2aRunInputRole =
  | 'current-spec'
  | 'development-contract'
  | 'effective-spec'
  | 'envelope'
  | 'gate'
  | 'index'
  | 'run'
  | 'task-graph';

export interface P2aRunClosureSource {
  readonly contentHash: Sha256Digest;
  readonly sourceRef: string;
  readonly value: unknown;
}

export interface P2aRunInputClosureEntry {
  readonly contentHash: Sha256Digest;
  readonly role: P2aRunInputRole;
  readonly sourceRef: string;
}

export interface P2aRunInputClosure {
  readonly closureDigest: Sha256Digest;
  readonly entries: readonly P2aRunInputClosureEntry[];
  readonly indexSourceRef: string;
  readonly projectId: string;
}

export class P2aRunInputClosureError extends Error {
  constructor() {
    super('P2A run input lineage is invalid.');
    this.name = 'P2aRunInputClosureError';
  }
}

interface DecodedSpec {
  readonly effectiveSpecRef?: string;
  readonly kind: 'approved' | 'current';
  readonly source: P2aRunClosureSource;
}

function fail(): never {
  throw new P2aRunInputClosureError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function artifactRoot(indexSourceRef: string): string {
  if (!indexSourceRef.endsWith(P2A_RUN_INDEX_SUFFIX)) return fail();
  const root = indexSourceRef.slice(0, -P2A_RUN_INDEX_SUFFIX.length).replace(/\/$/u, '');
  return validatePortableSourceRef(root);
}

function confinedReference(base: string, reference: string, root: string): string {
  if (typeof reference !== 'string' || reference.length < 1 || reference.includes('\\') ||
      reference.startsWith('/') || /^[A-Za-z]:/u.test(reference)) return fail();
  const resolved = validatePortableSourceRef(posix.normalize(posix.join(base, reference)));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return fail();
  return resolved;
}

function relativeReference(sourceRef: string, reference: string, root: string): string {
  return confinedReference(posix.dirname(sourceRef), reference, root);
}

function rootReference(root: string, reference: string): string {
  return confinedReference(root, reference, root);
}

function optionalReference(resolve: () => string): string | null {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof P2aRunInputClosureError) return null;
    throw error;
  }
}

function exactIndexMatch(summary: P2aRunIndexEntry, run: ObservedP2aRun): boolean {
  return summary.runId === run.runId && summary.taskId === run.taskId &&
    summary.iterationId === run.iterationId && summary.status === run.status &&
    summary.startedAt === run.startedAt && summary.finishedAt === run.finishedAt &&
    summary.agentTool === run.agentTool && summary.taskGraphRef === run.taskGraphRef &&
    summary.workspaceRef === run.workspaceRef && summary.runKind === run.runKind;
}

function decodeSpec(source: P2aRunClosureSource, projectId: string): DecodedSpec {
  if (!isRecord(source.value)) return fail();
  if (source.value.schema_version === 'p2a.spec.v1') {
    try {
      validateP2aSpec(source.value, projectId);
    } catch {
      return fail();
    }
    return Object.freeze({ kind: 'approved' as const, source });
  }
  if (source.value.schema_version !== 'p2a.current_spec.v1') return fail();
  try {
    validateP2aCurrentSpec(source.value, projectId);
  } catch {
    return fail();
  }
  if (typeof source.value.effective_spec_ref !== 'string' ||
      !Array.isArray(source.value.open_decisions) || source.value.open_decisions.length > 0) {
    return fail();
  }
  return Object.freeze({
    effectiveSpecRef: source.value.effective_spec_ref,
    kind: 'current' as const,
    source,
  });
}

function entryMatchesDigest(source: P2aRunClosureSource, digest: string): boolean {
  return source.contentHash === `sha256:${digest}` ||
    createHash('sha256').update(JSON.stringify(source.value)).digest('hex') === digest ||
    createHash('sha256').update(canonicalExecutionJson(source.value)).digest('hex') === digest;
}

function envelopeGateRefs(value: Readonly<Record<string, unknown>>): readonly Readonly<{
  path: string;
  sha256: string;
}>[] {
  if (!Array.isArray(value.sourceGateRefs)) return fail();
  const refs: Readonly<{ path: string; sha256: string }>[] = [];
  for (const item of value.sourceGateRefs) {
    if (!isRecord(item) || typeof item.path !== 'string' ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) return fail();
    refs.push(Object.freeze({ path: item.path, sha256: item.sha256 }));
  }
  return Object.freeze(refs);
}

export async function resolveP2aRunInputClosure(input: Readonly<{
  indexSourceRef: string;
  projectId: string;
  read: (sourceRef: string, required: boolean) => Promise<P2aRunClosureSource | null>;
}>): Promise<P2aRunInputClosure> {
  const root = artifactRoot(input.indexSourceRef);
  const entries = new Map<string, P2aRunInputClosureEntry>();
  const add = async (
    sourceRef: string,
    role: P2aRunInputRole,
    required = true,
  ): Promise<P2aRunClosureSource | null> => {
    const normalized = validatePortableSourceRef(sourceRef);
    if (normalized !== root && !normalized.startsWith(`${root}/`)) return fail();
    const source = await input.read(normalized, required);
    if (source === null) return required ? fail() : null;
    const current = entries.get(normalized);
    if (current !== undefined && current.contentHash !== source.contentHash) return fail();
    if (current === undefined) {
      entries.set(normalized, Object.freeze({
        contentHash: source.contentHash,
        role,
        sourceRef: normalized,
      }));
    }
    return source;
  };

  const indexSource = await add(input.indexSourceRef, 'index');
  if (indexSource === null) return fail();
  const decodedIndex = decodeP2aRunIndex(indexSource.value, input.projectId);
  if (!decodedIndex.ok) return fail();

  for (const summary of [...decodedIndex.value.runs].sort((left, right) =>
    compareText(left.runRef, right.runRef))) {
    const runRef = relativeReference(input.indexSourceRef, summary.runRef, root);
    const runSource = await add(runRef, 'run');
    if (runSource === null) return fail();
    const decodedRun = decodeP2aRun(runSource.value, input.projectId);
    if (!decodedRun.ok || !exactIndexMatch(summary, decodedRun.value)) return fail();
    const run = decodedRun.value;

    const graphRef = rootReference(root, run.taskGraphRef);
    const graphSource = await add(graphRef, 'task-graph');
    if (graphSource === null) return fail();
    const decodedGraph = decodeP2aTaskGraph(graphSource.value, input.projectId);
    if (!decodedGraph.ok || decodedGraph.value.version !== run.iterationId ||
        decodedGraph.value.sourceSpec !== run.sourceSpecRef) return fail();

    const graphSpecRef = relativeReference(graphRef, decodedGraph.value.sourceSpec, root);
    const graphSpecSource = await add(graphSpecRef, 'current-spec');
    if (graphSpecSource === null) return fail();
    const graphSpec = decodeSpec(graphSpecSource, input.projectId);
    const effectiveSpecRef = graphSpec.kind === 'current'
      ? relativeReference(graphSpecRef, graphSpec.effectiveSpecRef ?? '', root)
      : graphSpecRef;
    const effectiveSpecSource = graphSpec.kind === 'current'
      ? await add(effectiveSpecRef, 'effective-spec')
      : graphSpecSource;
    if (effectiveSpecSource === null) return fail();
    const effectiveSpec = decodeSpec(effectiveSpecSource, input.projectId);
    if (effectiveSpec.kind !== 'approved') return fail();
    const lineage = resolveTaskLineage(
      decodedGraph.value,
      graphRef,
      graphSource.contentHash,
      effectiveSpecRef,
      effectiveSpecSource.contentHash,
      run,
    );
    if (!lineage.ok || lineage.value.taskTitle !== run.taskTitle) return fail();

    let envelope: Readonly<Record<string, unknown>> | null = null;
    if (run.sourceLayout !== 'maintenance') {
      if (run.embeddedExecutionEnvelope !== undefined) {
        envelope = run.embeddedExecutionEnvelope;
      } else {
        const digest = run.executionEnvelopeReferenceSha256;
        if (digest === undefined) return fail();
        const envelopeRef = relativeReference(runRef, `envelopes/${digest}.json`, root);
        const envelopeSource = await add(envelopeRef, 'envelope');
        if (envelopeSource === null ||
            p2aExecutionEnvelopeSha256(envelopeSource.value) !== digest ||
            !isRecord(envelopeSource.value)) return fail();
        envelope = envelopeSource.value;
      }
    }

    if (envelope !== null) {
      for (const gate of envelopeGateRefs(envelope)) {
        const candidates = [...new Set([
          optionalReference(() => rootReference(root, gate.path)),
          optionalReference(() => relativeReference(graphRef, gate.path, root)),
          optionalReference(() => relativeReference(effectiveSpecRef, gate.path, root)),
        ].filter((sourceRef): sourceRef is string => sourceRef !== null))].sort(compareText);
        const matches: P2aRunClosureSource[] = [];
        for (const candidate of candidates) {
          const source = await input.read(candidate, false);
          if (source !== null && entryMatchesDigest(source, gate.sha256)) matches.push(source);
        }
        if (matches.length !== 1) return fail();
        const selectedGate = await add(matches[0]!.sourceRef, 'gate');
        if (selectedGate === null || !entryMatchesDigest(selectedGate, gate.sha256)) return fail();
      }
    }

    if (run.currentDevelopmentContractRef !== undefined &&
        run.currentDevelopmentContractSha256 !== undefined) {
      const contractRef = rootReference(root, run.currentDevelopmentContractRef);
      const contractSource = await add(contractRef, 'development-contract');
      if (contractSource === null ||
          !entryMatchesDigest(contractSource, run.currentDevelopmentContractSha256) ||
          !decodeP2aCurrentDevelopmentContract(contractSource.value, input.projectId).ok) return fail();
    }
  }

  const sorted = Object.freeze([...entries.values()].sort((left, right) =>
    compareText(left.sourceRef, right.sourceRef)));
  return Object.freeze({
    closureDigest: sha256(serializeCanonicalJson({
      entries: sorted.map(({ contentHash, role, sourceRef }) => ({ contentHash, role, sourceRef })),
      indexSourceRef: input.indexSourceRef,
      projectId: input.projectId,
      schemaVersion: 'buildlore.p2a-run-input-closure.v1',
    })),
    entries: sorted,
    indexSourceRef: input.indexSourceRef,
    projectId: input.projectId,
  });
}
