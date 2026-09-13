import { createProjectSecurityService } from '../../sanitizer/index.js';
import type { PreparedSource } from '../../sanitizer/types.js';
import { invalid, sha256 } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeSourceV1 } from '../../knowledge/project-knowledge/types.js';
import { createSessionCompilePlanner } from '../session/source-planner.js';
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

/** Reuse the existing selected-file, raw sanitizer and stored-source verification path. */
export async function preparePlannedKnowledgeSession(input: Readonly<{
  knowledgeRoot: string;
  hubRoot: string;
  projectId: string;
  previousGenerations?: readonly KnowledgeGenerationV1[];
  previousHistory?: VerifiedKnowledgeHistory;
  jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  outputLanguage?: string;
  rendererVersion?: KnowledgeRendererVersion;
  authoringQuestions?: readonly KnowledgeAuthoringQuestion[];
}>): Promise<Readonly<{ plan: SessionCompilePlanV1; session: KnowledgeSessionV1 }>> {
  const compiler = createSessionCompilePlanner({ knowledgeRoot: input.knowledgeRoot, hubRoot: input.hubRoot, rejectCredentialFindings: true,
    ...(input.jsonKnowledgeAdapters === undefined ? {} : { jsonKnowledgeAdapters: input.jsonKnowledgeAdapters }) });
  const { plan } = await compiler.create(input.projectId);
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
      sourceId: planned.sourceId, sourceRef: planned.sourceRef,
      sourceContentDigest: planned.originalContentDigest,
      // The checkout HEAD is metadata, not proof of the working source or tests.
      sourceRevision: null, codeRevision: null, tracked: tracking.trackedPaths.has(planned.sourceRef),
      repositoryRevision: tracking.repositoryRevision,
      format: 'markdown', content: planned.sanitizedBody,
      origins: planned.citationAnchors.flatMap((anchor) =>
        anchor.canonicalLine === undefined || anchor.jsonPointer === undefined || anchor.originalRange === undefined
          ? [] : [{ projectedLine: anchor.canonicalLine, sourceRef: anchor.originalFile,
            jsonPointer: anchor.jsonPointer, range: anchor.originalRange }]),
    };
    sources.push({ source, prepared: result.prepared });
  }
  const session = await createKnowledgeSessionService({ knowledgeRoot: input.knowledgeRoot }).prepare({
    projectId: input.projectId, selectionDigest: plan.selectionDigest, sources,
    ...(input.previousGenerations === undefined ? {} : { previousGenerations: input.previousGenerations }),
    ...(input.previousHistory === undefined ? {} : { previousHistory: input.previousHistory }),
    ...(input.outputLanguage === undefined ? {} : { outputLanguage: input.outputLanguage }),
    ...(input.rendererVersion === undefined ? {} : { rendererVersion: input.rendererVersion }),
    ...(input.authoringQuestions === undefined ? {} : { authoringQuestions: input.authoringQuestions }),
  });
  return Object.freeze({ plan, session });
}

/** Explicit v4 admission reuses the selected-source and verified-history path. */
export async function preparePlannedKnowledgeCompletenessSession(input: Omit<Parameters<typeof preparePlannedKnowledgeSession>[0],
  'rendererVersion' | 'authoringQuestions'> & Readonly<{ runId: string; authoringQuestions: readonly KnowledgeAuthoringQuestion[] }>):
  Promise<Readonly<{ plan: SessionCompilePlanV1; session: KnowledgeCompletenessSessionV1 }>> {
  const { runId, authoringQuestions, ...baseInput } = input;
  const { plan, session } = await preparePlannedKnowledgeSession({ ...baseInput, rendererVersion: 'knowledge-markdown-v2' });
  return Object.freeze({ plan, session: await wrapKnowledgeCompletenessSession(session, authoringQuestions, runId) });
}
