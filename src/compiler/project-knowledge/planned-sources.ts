import { createProjectSecurityService } from '../../sanitizer/index.js';
import type { PreparedSource } from '../../sanitizer/types.js';
import { invalid, sha256 } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeSourceV1 } from '../../knowledge/project-knowledge/types.js';
import { createSessionCompilePlanner, prepareVerifiedSessionSources, type VerifiedSessionSource, type VerifiedSessionSources } from '../session/source-planner.js';
import { SESSION_COMPILE_LIMITS } from '../session/contracts.js';
import type { SessionCompilePlanV1 } from '../session/types.js';
import { createKnowledgeSessionService, type KnowledgeSessionV1 } from './session.js';
import type { KnowledgeGenerationV1, KnowledgeRendererVersion } from '../../knowledge/project-knowledge/types.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../../projector/json-knowledge-adapter.js';
import { showProject } from '../../knowledge/index.js';
import { resolveLocalProjectBinding } from '../../knowledge/local-project-registry.js';
import { readGitSelectedSourceMetadata } from '../../knowledge/git.js';
import type { KnowledgeAuthoringQuestion } from './authoring-questions.js';
import type { VerifiedKnowledgeHistory } from '../../retrieval/project-knowledge-history-store.js';
import { wrapKnowledgeCompletenessSession, type KnowledgeCompletenessSessionV1 } from './completeness-session.js';

type KnowledgePreparationInput = Readonly<{
  knowledgeRoot: string;
  hubRoot: string;
  projectId: string;
  previousGenerations?: readonly KnowledgeGenerationV1[];
  previousHistory?: VerifiedKnowledgeHistory;
  jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  outputLanguage?: string;
  rendererVersion?: KnowledgeRendererVersion;
  authoringMode?: 'wiki-v1';
  authoringQuestions?: readonly KnowledgeAuthoringQuestion[];
}>;

/** Legacy SDK and persisted runs retain their exact plan and evidence identities. */
export async function preparePlannedKnowledgeSession(input: KnowledgePreparationInput):
  Promise<Readonly<{ plan: SessionCompilePlanV1; session: KnowledgeSessionV1 }>> {
  const compiler = createSessionCompilePlanner({ knowledgeRoot: input.knowledgeRoot, hubRoot: input.hubRoot, rejectCredentialFindings: true,
    ...(input.jsonKnowledgeAdapters === undefined ? {} : { jsonKnowledgeAdapters: input.jsonKnowledgeAdapters }) });
  const { plan } = await compiler.create(input.projectId);
  return Object.freeze({ plan, session: await prepareKnowledgeSession(input, plan, false) });
}

/** Wiki uses verified sanitized sources directly, without legacy anchors, tasks or merges. */
export async function prepareVerifiedKnowledgeSession(input: KnowledgePreparationInput):
  Promise<Readonly<{ session: KnowledgeSessionV1 }>> {
  const verified = await prepareVerifiedSessionSources({ knowledgeRoot: input.knowledgeRoot, hubRoot: input.hubRoot,
    rejectCredentialFindings: true,
    ...(input.jsonKnowledgeAdapters === undefined ? {} : { jsonKnowledgeAdapters: input.jsonKnowledgeAdapters }) }, input.projectId);
  return Object.freeze({ session: await prepareKnowledgeSession(input, verified, true) });
}

function projectedJsonOrigins(source: VerifiedSessionSource): NonNullable<KnowledgeSourceV1['origins']> {
  const lines = source.sanitizedBody.split('\n');
  const seenLines = new Set<number>();
  // Legacy anchors choose the first mapping covering a line, including disjoint columns.
  return (source.jsonOrigins ?? []).flatMap(mapping => {
    const result: NonNullable<KnowledgeSourceV1['origins']>[number][] = [];
    for (let line = mapping.canonical.startLine; line <= mapping.canonical.endLine; line += 1) {
      const quote = lines[line - 1];
      if (seenLines.has(line) || quote === undefined || quote.trim() === '' || quote.length > SESSION_COMPILE_LIMITS.maxQuoteCodeUnits) continue;
      seenLines.add(line);
      result.push({ projectedLine: line, sourceRef: mapping.origin.sourceRef,
        jsonPointer: mapping.origin.jsonPointer, range: mapping.origin.range });
    }
    return result;
  });
}

function projectedRangeMappings(source: VerifiedSessionSource):
  Pick<KnowledgeSourceV1, 'originMappings' | 'originLineEndColumns'> {
  const lines = source.sanitizedBody.split('\n');
  const mappings = source.originMappings ?? [];
  const bounded = mappings.map(mapping => {
    const lastLine = lines[mapping.canonical.endLine - 1];
    if (lastLine === undefined) invalid();
    // Verified stored mappings may retain pre-sanitization columns. Bound only the
    // canonical view; original coordinates and already valid snapshot identities stay intact.
    const endColumn = Math.min(mapping.canonical.endColumn, Array.from(lastLine).length + 1);
    return endColumn === mapping.canonical.endColumn ? mapping
      : { ...mapping, canonical: { ...mapping.canonical, endColumn } };
  });
  const corrections = source.originLineEndColumns ?? [];
  if (corrections.length === 0) return { originMappings: bounded };
  // Older v2 snapshots used split mappings. Keep their exact identities while
  // representing larger correction sets without expanding the 128-map contract.
  if (bounded.length + corrections.length > 128) {
    return { originMappings: bounded, originLineEndColumns: corrections };
  }
  const columns = new Map(corrections.map(item => [item.canonicalLine, item.endColumn]));
  const expanded = bounded.flatMap(mapping => {
    const ranges: NonNullable<KnowledgeSourceV1['originMappings']>[number][] = [];
    let canonicalStartLine = mapping.canonical.startLine, canonicalStartColumn = mapping.canonical.startColumn;
    let originStartLine = mapping.origin.startLine, originStartColumn = mapping.origin.startColumn;
    for (let line = mapping.canonical.startLine; line < mapping.canonical.endLine; line += 1) {
      const originalEndColumn = columns.get(line);
      if (originalEndColumn === undefined) continue;
      const canonicalLine = lines[line - 1];
      if (canonicalLine === undefined) invalid();
      const canonicalEndColumn = Array.from(canonicalLine).length + 1;
      if (line === canonicalStartLine &&
          (canonicalEndColumn < canonicalStartColumn || originalEndColumn < originStartColumn)) invalid();
      const originEndLine = mapping.origin.startLine + line - mapping.canonical.startLine;
      ranges.push({ canonical: { startLine: canonicalStartLine, startColumn: canonicalStartColumn,
        endLine: line, endColumn: canonicalEndColumn },
      origin: { startLine: originStartLine, startColumn: originStartColumn,
        endLine: originEndLine, endColumn: originalEndColumn } });
      canonicalStartLine = line + 1; canonicalStartColumn = 1;
      originStartLine = originEndLine + 1; originStartColumn = 1;
    }
    ranges.push({ canonical: { startLine: canonicalStartLine, startColumn: canonicalStartColumn,
      endLine: mapping.canonical.endLine, endColumn: mapping.canonical.endColumn },
    origin: { startLine: originStartLine, startColumn: originStartColumn,
      endLine: mapping.origin.endLine, endColumn: mapping.origin.endColumn } });
    return ranges;
  });
  return { originMappings: expanded };
}

async function prepareKnowledgeSession(input: KnowledgePreparationInput,
  plan: VerifiedSessionSources | SessionCompilePlanV1, mapped: boolean): Promise<KnowledgeSessionV1> {
  const project = await showProject(input.knowledgeRoot, input.projectId);
  const binding = await resolveLocalProjectBinding(input.hubRoot, input.projectId, project.entry.sourceRepository);
  const tracking = await readGitSelectedSourceMetadata(binding.checkout.resolveRootForInternalUse(),
    plan.sources.map((source) => source.sourceRef));
  const security = createProjectSecurityService({ knowledgeRoot: input.knowledgeRoot });
  const sources: Readonly<{ source: KnowledgeSourceV1; prepared: PreparedSource }>[] = [];
  for (const planned of plan.sources) {
    const result = await security.prepareSource({ projectId: input.projectId,
      body: planned.sanitizedBody, bodyDigest: sha256(planned.sanitizedBody), source: planned.sourceRef,
      sourceKind: planned.sourceKind, sourceRevisionOrContentSha256: planned.originalContentDigest });
    if (!result.ok || result.report.outputDigest !== planned.sanitizedContentDigest ||
        result.report.policyDigest !== plan.policyDigest) invalid();
    const source: KnowledgeSourceV1 = {
      ...(mapped ? { originPolicy: 'projected-v1' as const,
        ...(planned.chunk === undefined ? {} : { chunk: planned.chunk }),
        ...(planned.originMappings === undefined ? {} : projectedRangeMappings(planned)) }
        : planned.chunk === undefined ? {} : { chunk: planned.chunk, originMappings: planned.originMappings ?? [] }),
      sourceId: planned.sourceId, sourceRef: planned.sourceRef,
      sourceContentDigest: planned.originalContentDigest,
      // The checkout HEAD is metadata, not proof of the working source or tests.
      sourceRevision: null, codeRevision: null, tracked: tracking.trackedPaths.has(planned.sourceRef),
      repositoryRevision: tracking.repositoryRevision,
      format: 'markdown', content: planned.sanitizedBody,
      origins: 'citationAnchors' in planned ? planned.citationAnchors.flatMap((anchor) =>
        anchor.canonicalLine === undefined || anchor.jsonPointer === undefined || anchor.originalRange === undefined
          ? [] : [{ projectedLine: anchor.canonicalLine, sourceRef: anchor.originalFile,
            jsonPointer: anchor.jsonPointer, range: anchor.originalRange }]) : projectedJsonOrigins(planned),
    };
    sources.push({ source, prepared: result.prepared });
  }
  const session = await createKnowledgeSessionService({ knowledgeRoot: input.knowledgeRoot }).prepare({
    projectId: input.projectId, selectionDigest: plan.selectionDigest, sources,
    ...(input.previousGenerations === undefined ? {} : { previousGenerations: input.previousGenerations }),
    ...(input.previousHistory === undefined ? {} : { previousHistory: input.previousHistory }),
    ...(input.outputLanguage === undefined ? {} : { outputLanguage: input.outputLanguage }),
    ...(input.authoringMode === undefined ? {} : { authoringMode: input.authoringMode }),
    ...(input.rendererVersion === undefined ? {} : { rendererVersion: input.rendererVersion }),
    ...(input.authoringQuestions === undefined ? {} : { authoringQuestions: input.authoringQuestions }),
  });
  return session;
}

/** Explicit v4 admission reuses the selected-source and verified-history path. */
export async function preparePlannedKnowledgeCompletenessSession(input: Omit<Parameters<typeof preparePlannedKnowledgeSession>[0],
  'rendererVersion' | 'authoringQuestions'> & Readonly<{ runId: string; authoringQuestions: readonly KnowledgeAuthoringQuestion[];
    proofPolicy?: 'persisted-v1' | 'legacy-v1'; inventoryPolicy?: 'completeness-v1' | 'completeness-v2' }>):
  Promise<Readonly<{ plan: SessionCompilePlanV1; session: KnowledgeCompletenessSessionV1 }>> {
  const { runId, authoringQuestions, proofPolicy, inventoryPolicy, ...baseInput } = input;
  const { plan, session } = await preparePlannedKnowledgeSession({ ...baseInput, rendererVersion: 'knowledge-markdown-v2' });
  return Object.freeze({ plan, session: await wrapKnowledgeCompletenessSession(session, authoringQuestions, runId, proofPolicy, inventoryPolicy) });
}
