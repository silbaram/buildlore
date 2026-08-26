import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { consumePreparedSource } from '../../sanitizer/approval.js';
import {
  createProjectSecurityService,
  SANITIZER_RULES_VERSION,
} from '../../sanitizer/index.js';
import { compareSessionText, digestSessionValue, sessionSha256 } from './canonical.js';
import { SESSION_COMPILE_LIMITS } from './contracts.js';
import { SessionCompileError, type SessionCompileErrorCode } from './errors.js';
import {
  transitionSessionMarkdownFence,
  type SessionMarkdownFence,
} from './markdown-fence.js';
import type { SessionCompilePlanSnapshot } from './source-planner.js';
import {
  SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
  type SessionCompileProposalV1,
  type SessionCompileProvenanceV1,
  type SessionMergeCandidate,
  type SessionProfileFieldValue,
  type SessionProposalCitation,
  type SessionRequestedPageKind,
  type SessionSha256Digest,
} from './types.js';

export interface ValidatedSessionProposal {
  readonly proposal: SessionCompileProposalV1;
  readonly provenance: SessionCompileProvenanceV1;
}

export interface ValidatedSessionBatch {
  readonly batchDigest: SessionSha256Digest;
  readonly harness: SessionCompileProposalV1['callerHarness'];
  readonly pages: readonly ValidatedSessionProposal[];
}

function fail(code: SessionCompileErrorCode, projectId: string): never {
  throw new SessionCompileError(code, projectId);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function outsideFences(body: string): string {
  const lines = body.split('\n');
  let fence: SessionMarkdownFence | null = null;
  return lines.map((line) => {
    const transition = transitionSessionMarkdownFence(line, fence);
    const wasInsideFence = fence !== null;
    fence = transition.fence;
    return wasInsideFence || transition.isFenceLine ? '' : line;
  }).join('\n');
}

function citationMarkers(body: string, projectId: string): readonly string[] {
  const visible = outsideFences(body);
  if (/\[\^[a-z0-9][a-z0-9._-]{0,127}\]:/u.test(visible)) {
    return fail('SESSION_CITATION_INVALID', projectId);
  }
  const markers: string[] = [];
  const pattern = /\[\^([a-z0-9][a-z0-9._-]{0,127})\](?!:)/gu;
  let match = pattern.exec(visible);
  while (match !== null) {
    const id = match[1];
    if (id === undefined) return fail('SESSION_CITATION_INVALID', projectId);
    markers.push(id);
    match = pattern.exec(visible);
  }
  return Object.freeze(markers.sort(compareSessionText));
}

function wikilinkTargets(body: string, projectId: string): readonly string[] {
  const visible = outsideFences(body);
  const targets: string[] = [];
  const pattern = /\[\[([a-z0-9]+(?:-[a-z0-9]+)*)(?:\|[^\]\r\n]+)?\]\]/gu;
  let match = pattern.exec(visible);
  while (match !== null) {
    const slug = match[1];
    if (slug === undefined) return fail('SESSION_LINK_INVALID', projectId);
    targets.push(slug);
    match = pattern.exec(visible);
  }
  const residue = visible.replace(pattern, '');
  if (residue.includes('[[') || residue.includes(']]')) {
    return fail('SESSION_LINK_INVALID', projectId);
  }
  return Object.freeze([...new Set(targets)].sort(compareSessionText));
}

function connectedSources(
  taskId: string,
  merges: readonly SessionMergeCandidate[],
  projectId: string,
): readonly string[] {
  const connectedTasks = new Set([taskId]);
  const pending = [...merges];
  let changed = true;
  while (changed) {
    changed = false;
    for (const merge of pending) {
      if (merge.memberTaskIds.some((id) => connectedTasks.has(id))) {
        for (const id of merge.memberTaskIds) {
          if (!connectedTasks.has(id)) {
            connectedTasks.add(id);
            changed = true;
          }
        }
      }
    }
  }
  if (merges.some((merge) => merge.memberTaskIds.every((id) => !connectedTasks.has(id)))) {
    return fail('SESSION_CONTRACT_INVALID', projectId);
  }
  return Object.freeze([...new Set(merges.flatMap((merge) => merge.memberSourceIds))]
    .sort(compareSessionText));
}

function citationMatches(
  citation: SessionProposalCitation,
  snapshot: SessionCompilePlanSnapshot,
): boolean {
  const source = snapshot.plan.sources.find((item) => item.sourceId === citation.sourceId);
  if (source === undefined || source.sourceRef !== citation.file) return false;
  return source.citationAnchors.some((anchor) =>
    anchor.sourceId === citation.sourceId &&
    anchor.originalFile === citation.file &&
    anchor.originalLine === citation.line &&
    anchor.quote === citation.quote &&
    anchor.quoteDigest === sessionSha256(citation.quote));
}

function requireProfileText(
  fields: Readonly<Record<string, SessionProfileFieldValue>>,
  key: string,
  projectId: string,
  maximum = 8_000,
): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    return fail('SESSION_CONTRACT_INVALID', projectId);
  }
  return value;
}

function requireProfileStringArray(
  fields: Readonly<Record<string, SessionProfileFieldValue>>,
  key: string,
  projectId: string,
): readonly string[] {
  const value = fields[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > 128 ||
      value.some((item: unknown) => typeof item !== 'string' || item.length === 0 ||
        item.length > 1_000)) {
    return fail('SESSION_CONTRACT_INVALID', projectId);
  }
  return Object.freeze([...(value as readonly string[])]);
}

function validateProfileFields(
  proposal: SessionCompileProposalV1,
  profileMode: SessionCompilePlanSnapshot['profileMode'],
  projectId: string,
): void {
  if (profileMode === 'default') {
    if ((proposal.kind !== 'concept' && proposal.kind !== 'query') ||
        proposal.profileFields !== undefined) {
      return fail('SESSION_CONTRACT_INVALID', projectId);
    }
    return;
  }
  if (proposal.kind === 'concept' || proposal.kind === 'query' ||
      proposal.profileFields === undefined) return fail('SESSION_CONTRACT_INVALID', projectId);
  const customKind: 'decision' | 'failure' | 'verification' = proposal.kind;
  const fields = proposal.profileFields;
  const allowed: Readonly<Record<Exclude<SessionRequestedPageKind, 'concept' | 'query'>, ReadonlySet<string>>> = {
    decision: new Set(['rationale', 'status']),
    failure: new Set(['failureClass', 'resolution', 'status']),
    verification: new Set(['command', 'evidenceRefs', 'status', 'verificationKind']),
  };
  if (Object.keys(fields).some((key) => !allowed[customKind].has(key))) {
    return fail('SESSION_CONTRACT_INVALID', projectId);
  }
  if (proposal.kind === 'decision' && fields.rationale !== undefined) {
    requireProfileText(fields, 'rationale', projectId);
  }
  if (proposal.kind === 'failure') {
    requireProfileText(fields, 'failureClass', projectId, 200);
    if (fields.resolution !== undefined) requireProfileText(fields, 'resolution', projectId);
  }
  if (proposal.kind === 'verification') {
    requireProfileText(fields, 'verificationKind', projectId, 200);
    requireProfileStringArray(fields, 'evidenceRefs', projectId);
    if (fields.command !== undefined) requireProfileText(fields, 'command', projectId, 2_000);
  }
  const status = requireProfileText(fields, 'status', projectId);
  const initialStatus = proposal.kind === 'decision'
    ? 'active'
    : proposal.kind === 'failure'
      ? 'open'
      : 'recorded';
  if (status !== initialStatus) {
    return fail('SESSION_CONTRACT_INVALID', projectId);
  }
}

async function validateGeneratedContent(
  proposal: SessionCompileProposalV1,
  snapshot: SessionCompilePlanSnapshot,
  knowledgeRoot: string,
  projectId: string,
): Promise<void> {
  const scanBody = [
    proposal.title,
    proposal.summary,
    proposal.body,
    serializeCanonicalJson({
      callerHarness: {
        kind: proposal.callerHarness.kind,
        version: proposal.callerHarness.version,
      },
      citations: proposal.citations,
      profileFields: proposal.profileFields ?? {},
    }),
  ].join('\n');
  const digest = sessionSha256(scanBody);
  const source = 'buildlore://session-output/' + proposal.proposalDigest.slice('sha256:'.length);
  const result = await createProjectSecurityService({ knowledgeRoot }).prepareSource({
    body: scanBody,
    bodyDigest: digest,
    projectId,
    source,
    sourceKind: 'wiki',
    sourceRevisionOrContentSha256: proposal.proposalDigest,
  });
  if (
    !result.ok ||
    result.report.decision !== 'include' ||
    result.report.findingsOverflow ||
    result.report.inputDigest !== digest ||
    result.report.outputDigest !== digest ||
    result.report.policyDigest !== snapshot.plan.policyDigest ||
    result.report.projectId !== projectId ||
    result.report.rulesVersion !== SANITIZER_RULES_VERSION
  ) return fail('SESSION_OUTPUT_UNSAFE', projectId);
  const prepared = consumePreparedSource(result.prepared);
  if (
    prepared === null ||
    prepared.approvedBody !== scanBody ||
    prepared.approvedBodyDigest !== digest ||
    prepared.inputBodyDigest !== digest ||
    prepared.policyDigest !== snapshot.plan.policyDigest ||
    prepared.projectId !== projectId ||
    prepared.source !== source ||
    prepared.sourceKind !== 'wiki' ||
    prepared.sourceRevisionOrContentSha256 !== proposal.proposalDigest
  ) return fail('SESSION_OUTPUT_UNSAFE', projectId);
}

function provenanceFor(
  proposal: SessionCompileProposalV1,
  snapshot: SessionCompilePlanSnapshot,
): SessionCompileProvenanceV1 {
  const binding = {
    schemaVersion: SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
    projectId: proposal.projectId,
    planDigest: snapshot.plan.planDigest,
    proposalDigest: proposal.proposalDigest,
    sourceManifestDigest: snapshot.plan.sourceManifestDigest,
    profileDigest: snapshot.plan.profileDigest,
    policyDigest: snapshot.plan.policyDigest,
    callerHarness: proposal.callerHarness,
    contractDigest: snapshot.plan.contractDigest,
  };
  return Object.freeze({ ...binding, bindingDigest: digestSessionValue(binding) });
}

export async function validateSessionProposalBatch(
  snapshot: SessionCompilePlanSnapshot,
  proposals: readonly SessionCompileProposalV1[],
  knowledgeRoot: string,
  projectId: string,
): Promise<ValidatedSessionBatch> {
  if (proposals.length === 0 || proposals.length > SESSION_COMPILE_LIMITS.maxProposals) {
    return fail('SESSION_CONTRACT_INVALID', projectId);
  }
  const pages = [...proposals].sort((left, right) =>
    compareSessionText(left.proposalId, right.proposalId));
  if (
    new Set(pages.map((proposal) => proposal.proposalId)).size !== pages.length ||
    new Set(pages.map((proposal) => proposal.pageId)).size !== pages.length ||
    new Set(pages.map((proposal) => proposal.slug)).size !== pages.length
  ) return fail('SESSION_CONTRACT_INVALID', projectId);
  const first = pages[0];
  if (first === undefined) return fail('SESSION_CONTRACT_INVALID', projectId);
  const liveSlugs = new Set(snapshot.plan.allowedLinkTargets.map((target) => target.slug));
  const batchSlugs = new Set(pages.map((proposal) => proposal.slug));
  const planTasks = new Map(snapshot.plan.tasks.map((task) => [task.taskId, task] as const));
  const planMerges = new Map(snapshot.plan.mergeCandidates.map((merge) =>
    [merge.candidateId, merge] as const));
  const validated: ValidatedSessionProposal[] = [];
  for (const proposal of pages) {
    if (proposal.projectId !== projectId || proposal.planDigest !== snapshot.plan.planDigest) {
      return fail('SESSION_PLAN_STALE', projectId);
    }
    if (
      proposal.callerHarness.kind !== first.callerHarness.kind ||
      proposal.callerHarness.version !== first.callerHarness.version ||
      proposal.callerHarness.compatibilityDigest !== first.callerHarness.compatibilityDigest
    ) return fail('SESSION_CONTRACT_INVALID', projectId);
    if (liveSlugs.has(proposal.slug) || snapshot.pendingSlugs.has(proposal.slug)) {
      return fail('SESSION_CONTRACT_INVALID', projectId);
    }
    const task = planTasks.get(proposal.taskId);
    if (task === undefined || !task.requestedPageKinds.includes(proposal.kind) ||
        proposal.mergeCandidateIds.some((id) => !task.mergeCandidateIds.includes(id))) {
      return fail('SESSION_CONTRACT_INVALID', projectId);
    }
    const merges = proposal.mergeCandidateIds.map((id) => {
      const merge = planMerges.get(id);
      if (merge === undefined) return fail('SESSION_CONTRACT_INVALID', projectId);
      return merge;
    });
    const connected = connectedSources(proposal.taskId, merges, projectId);
    const allowedSources = [...new Set([...task.allowedSourceIds, ...connected])]
      .sort(compareSessionText);
    if (!sameStrings(proposal.sources, allowedSources)) {
      return fail('SESSION_CONTRACT_INVALID', projectId);
    }
    if (proposal.citations.some((citation) =>
      !proposal.sources.includes(citation.sourceId) ||
      !citationMatches(citation, snapshot))) {
      return fail('SESSION_CITATION_INVALID', projectId);
    }
    const markers = citationMarkers(proposal.body, projectId);
    const citationIds = proposal.citations.map((citation) => citation.id);
    if (!sameStrings(markers, citationIds)) return fail('SESSION_CITATION_INVALID', projectId);
    const links = wikilinkTargets(proposal.body, projectId);
    if (!sameStrings(links, proposal.wikilinks) ||
        links.some((slug) => !liveSlugs.has(slug) && !batchSlugs.has(slug))) {
      return fail('SESSION_LINK_INVALID', projectId);
    }
    validateProfileFields(proposal, snapshot.profileMode, projectId);
    await validateGeneratedContent(proposal, snapshot, knowledgeRoot, projectId);
    validated.push(Object.freeze({ proposal, provenance: provenanceFor(proposal, snapshot) }));
  }
  return Object.freeze({
    batchDigest: digestSessionValue({
      planDigest: snapshot.plan.planDigest,
      proposalDigests: pages.map((proposal) => proposal.proposalDigest),
    }),
    harness: first.callerHarness,
    pages: Object.freeze(validated),
  });
}
