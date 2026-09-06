import { consumePreparedSource } from '../../sanitizer/approval.js';
import { createProjectSecurityService, readSecurityPolicy, SANITIZER_RULES_VERSION } from '../../sanitizer/index.js';
import type { PreparedSource } from '../../sanitizer/types.js';
import { createKnowledgeSnapshot, parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { digest, invalid, sha256, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgeProposalV1, KnowledgeSnapshotV1,
  KnowledgeSourceV1 } from '../../knowledge/project-knowledge/types.js';
import { createKnowledgeGeneration, parseKnowledgeGenerationChain } from './generation.js';
import { knowledgeReviewTargets, parseKnowledgeProposal, parseKnowledgeSemanticReview } from './proposal.js';

export interface KnowledgeExchangeV1 {
  readonly schemaVersion: 'buildlore.knowledge-exchange.v1';
  readonly projectId: string;
  readonly snapshot: KnowledgeSnapshotV1;
  readonly baselineGenerationDigest: KnowledgeDigest | null;
  readonly previousRecords: KnowledgeGenerationV1['records'];
  readonly previousEvidence: KnowledgeGenerationV1['evidence'];
  readonly instructions: readonly string[];
  readonly boundary: Readonly<{ generationActor: 'current-agent-session'; egress: 'none'; processSpawned: false }>;
  readonly exchangeDigest: KnowledgeDigest;
}

export interface KnowledgeSessionV1 {
  readonly exchange: KnowledgeExchangeV1;
  submit(input: unknown, expectExchange: KnowledgeDigest): Promise<KnowledgeProposalV1>;
  reviewTargets(): readonly string[];
  finalize(review: unknown, expectProposal: KnowledgeDigest): Promise<KnowledgeGenerationV1>;
}

const safeGenerations = new WeakSet<KnowledgeGenerationV1>();
export function isSanitizedKnowledgeGeneration(value: KnowledgeGenerationV1): boolean {
  return safeGenerations.has(value);
}

/** The only authoring handoff consumes actual same-process sanitizer capabilities. */
export function createKnowledgeSessionService(options: Readonly<{ knowledgeRoot: string }>): Readonly<{
  prepare(input: Readonly<{ projectId: string; selectionDigest: KnowledgeDigest;
    sources: readonly Readonly<{ source: KnowledgeSourceV1; prepared: PreparedSource }>[];
    outputLanguage?: string;
    previousGenerations?: readonly KnowledgeGenerationV1[] }>): Promise<KnowledgeSessionV1>;
}> {
  const security = createProjectSecurityService(options);
  async function safeBody(projectId: string, body: string, policyDigest: KnowledgeDigest): Promise<void> {
    const result = await security.prepareSource({ projectId, body, bodyDigest: sha256(body),
      source: 'project-knowledge-review.md', sourceKind: 'markdown', sourceRevisionOrContentSha256: sha256(body) });
    const prepared = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!prepared || prepared.policyDigest !== policyDigest || prepared.approvedBody !== body ||
        prepared.approvedBodyDigest !== sha256(body)) throw new ProjectKnowledgeError();
  }
  return Object.freeze({
    async prepare(input): Promise<KnowledgeSessionV1> {
      const outputLanguage = input.outputLanguage ?? 'und';
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(outputLanguage)) invalid();
      const policy = await readSecurityPolicy(options.knowledgeRoot, input.projectId);
      const sources = input.sources.map(({ source, prepared }) => {
        const approved = consumePreparedSource(prepared);
        if (!approved || approved.projectId !== input.projectId || approved.source !== source.sourceRef ||
            approved.approvedBody !== source.content || approved.approvedBodyDigest !== sha256(source.content) ||
            approved.sourceRevisionOrContentSha256 !== source.sourceContentDigest || approved.policyDigest !== policy.digest) invalid();
        return source;
      });
      const snapshot = createKnowledgeSnapshot({ projectId: input.projectId, sources,
        selectionDigest: input.selectionDigest, sanitizerPolicyDigest: policy.digest,
        sanitizerRulesVersion: SANITIZER_RULES_VERSION }, input.projectId);
      const chain = input.previousGenerations?.length
        ? parseKnowledgeGenerationChain(input.previousGenerations, input.projectId) : [];
      const previous = chain.at(-1) ?? null;
      // The complete retained chain will be re-persisted in the next authority,
      // including old review rationale and snapshots that are no longer displayed.
      if (chain.length > 0) await safeBody(input.projectId, JSON.stringify(chain), policy.digest);
      // Retained historical prose is re-screened under the current policy before disclosure.
      const historyBody = previous === null ? '' : [
        ...previous.records.flatMap((r) => [r.subject, r.predicate ?? '', r.statement, r.scope,
          r.derivation.actor.sessionId, r.derivation.actor.model]),
        ...previous.evidence.flatMap((e) => [e.sourceId, e.sourceRef, e.sourceRevision ?? '',
          e.codeRevision ?? '', e.locator.kind === 'json-pointer' ? e.locator.pointer : '', e.excerpt,
          e.origin?.sourceRef ?? '', e.origin?.jsonPointer ?? '']),
      ].join('\n');
      if (historyBody !== '') await safeBody(input.projectId, historyBody, policy.digest);
      await safeBody(input.projectId, sources.map((s) => [s.sourceId, s.sourceRef,
        s.sourceRevision ?? '', s.codeRevision ?? '',
        ...(s.origins ?? []).flatMap((o) => [o.sourceRef, o.jsonPointer])].join('\n')).join('\n'), policy.digest);
      const basis = { schemaVersion: 'buildlore.knowledge-exchange.v1' as const, projectId: input.projectId,
        snapshot, baselineGenerationDigest: previous?.generationDigest ?? null,
        previousRecords: previous?.records ?? [], previousEvidence: previous?.evidence ?? [],
        instructions: Object.freeze([
          `Output language: ${outputLanguage}. When und, preserve the source language.`,
          'Write exactly overview, architecture and decisions pages, organized by project questions, not source files.',
          'Every substantive sentence must be a claim bound to facts and actual supporting evidence.',
          'Record decision reasons, alternatives, constraints, changes and unknowns without inventing them.',
          'Keep declared plans and old verification separate from current implementation and verification.',
          'Use observed only for the exact source-literal statement and source-literal-only scope.',
          'Propose explicit scoped supersessions/conflicts. Missing evidence does not prove removal.',
          'Independent source-support-and-currentness review is required; self-review is insufficient.',
        ]), boundary: Object.freeze({ generationActor: 'current-agent-session' as const, egress: 'none' as const,
          processSpawned: false as const }) };
      const exchange = Object.freeze({ ...basis, exchangeDigest: digest(basis) });
      let proposal: KnowledgeProposalV1 | null = null;
      let busy = false;
      return Object.freeze({ exchange,
        async submit(value: unknown, expectExchange: KnowledgeDigest): Promise<KnowledgeProposalV1> {
          if (busy || expectExchange !== exchange.exchangeDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
          busy = true;
          try {
            const candidate = parseKnowledgeProposal(value, snapshot);
            if (candidate.baselineGenerationDigest !== exchange.baselineGenerationDigest) invalid();
            await safeBody(input.projectId, [candidate.actor.sessionId, candidate.actor.model,
              ...candidate.facts.flatMap((f) => [f.subject, f.predicate ?? '', f.statement, f.scope]),
              ...candidate.pages.flatMap((p) => [p.title, ...p.sections.flatMap((s) => [s.title,
                ...s.claims.flatMap((c) => [c.claimId, c.text])])])].join('\n'), policy.digest);
            proposal = candidate;
            return candidate;
          } finally { busy = false; }
        },
        reviewTargets(): readonly string[] { return proposal === null ? [] : knowledgeReviewTargets(proposal); },
        async finalize(value: unknown, expectProposal: KnowledgeDigest): Promise<KnowledgeGenerationV1> {
          if (busy || proposal === null || expectProposal !== proposal.proposalDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
          busy = true;
          try {
            const review = parseKnowledgeSemanticReview(value, proposal, snapshot, previous);
            await safeBody(input.projectId, [review.reviewer.sessionId, review.reviewer.model,
              ...review.judgments.map((j) => j.rationale)].join('\n'), policy.digest);
            const result = createKnowledgeGeneration(parseKnowledgeSnapshot(snapshot, input.projectId), proposal, review, previous);
            safeGenerations.add(result);
            return result;
          } finally { busy = false; }
        },
      });
    },
  });
}
