import { createKnowledgeGenerationHistoryStore, requireVerifiedKnowledgeHistory, type VerifiedKnowledgeHistory } from '../../retrieval/project-knowledge-history-store.js';
import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { boundedJson, digest, hashes, invalid, ProjectKnowledgeError, record, sha256 } from '../../knowledge/project-knowledge/guards.js';
import { consumePreparedSource } from '../../sanitizer/approval.js';
import { createProjectSecurityService, readSecurityPolicy } from '../../sanitizer/index.js';
import { parseAnswerEvaluationContract } from './answer-evaluation-contract.js';
import { answerLookupContext, answerInitialContext, answerRuntimeContext, createAnswerEvaluationWithHistory, createAnswerEvaluation } from './answer-evaluation.js';
import { KNOWLEDGE_ANSWER_BUDGET } from './answer-evaluation-types.js';
import type { AnswerContextItemV1, AnswerLookupV1, AnswerLookupV2, AnswerRuntimeContextV1 } from './answer-evaluation-types.js';
import { parseKnowledgeGenerationChain } from './generation.js';
import { screenRetainedKnowledgeHistory } from './history-security.js';
import type { KnowledgeDigest } from '../../knowledge/project-knowledge/types.js';

export interface KnowledgeAnswerEvaluationSessionV1 {
  readonly initialContext: readonly AnswerContextItemV1[];
  readonly runtimeContext: AnswerRuntimeContextV1;
  lookup(questionId: string, evidenceIds: unknown): Promise<AnswerLookupV1 | AnswerLookupV2>;
  lookupFacts(questionId: string, factIds: unknown): Promise<AnswerLookupV2>;
  /** Returns checked, screened JSON. The caller owns its explicit local audit-file write. */
  serializeReport(input: unknown): Promise<string>;
}

export interface KnowledgeAnswerEvaluationInput {
  readonly projectId: string;
  readonly contract: unknown;
  readonly generations?: unknown;
  readonly history?: VerifiedKnowledgeHistory;
  readonly runtimeContext?: unknown;
}

/** Screened size diagnostics, not an answer judgment or a model context-window estimate. */
export interface KnowledgeAnswerContextInspectionV1 {
  readonly projectId: string;
  readonly contractDigest: KnowledgeDigest;
  readonly generationDigest: KnowledgeDigest;
  readonly contextFormat: 'full-wiki' | 'knowledge-reader-v1' | 'knowledge-cli-reader-v1' | 'knowledge-reader-packet-v1';
  readonly parts: readonly Readonly<{ kind: AnswerContextItemV1['kind'] | 'runtime'; ref: string; utf8Bytes: number }>[];
  readonly knownInitialUtf8Bytes: number;
  readonly runtimeContextKnown: boolean;
  readonly initialLimitUtf8Bytes: number;
  readonly exceedsBudget: boolean;
}

/** No provider, subprocess or output-file write. This boundary precedes context disclosure and report persistence. */
export function createKnowledgeAnswerEvaluationService(options: Readonly<{ knowledgeRoot: string }>): Readonly<{
  prepare(input: KnowledgeAnswerEvaluationInput): Promise<KnowledgeAnswerEvaluationSessionV1>;
  inspect(input: KnowledgeAnswerEvaluationInput): Promise<KnowledgeAnswerContextInspectionV1>;
}> {
  const security = createProjectSecurityService(options);
  const historyStore = createKnowledgeGenerationHistoryStore(options);
  async function load(input: KnowledgeAnswerEvaluationInput) {
    const contract = parseAnswerEvaluationContract(input.contract, input.projectId);
    const runtimeContext = answerRuntimeContext(input.runtimeContext ?? { body: null, unavailableReason: 'Runtime context not supplied.' });
    if ((input.generations === undefined) === (input.history === undefined)) invalid();
    const history = input.history === undefined ? null : await historyStore.verify(
      requireVerifiedKnowledgeHistory(input.history, input.projectId).reference, input.projectId);
    const generations = history === null ? parseKnowledgeGenerationChain(input.generations, input.projectId) : [];
    const generation = history?.latest ?? generations.at(-1);
    if (!generation) invalid();
    const policy = await readSecurityPolicy(options.knowledgeRoot, input.projectId);
    async function screenBody(body: string): Promise<void> {
      const bodyDigest = sha256(body);
      const result = await security.prepareSource({ projectId: input.projectId, body, bodyDigest,
        source: 'project-knowledge-evaluation.md', sourceKind: 'markdown', sourceRevisionOrContentSha256: bodyDigest });
      if (!result.ok) {
        throw new ProjectKnowledgeError(result.report.summaries.some(summary => summary.ruleId === 'input.oversized')
          ? 'KNOWLEDGE_SECURITY_INPUT_TOO_LARGE' : 'KNOWLEDGE_SECURITY_BLOCKED');
      }
      const prepared = consumePreparedSource(result.prepared);
      if (!prepared || prepared.projectId !== input.projectId || prepared.policyDigest !== policy.digest ||
          prepared.approvedBody !== body || prepared.approvedBodyDigest !== bodyDigest) {
        throw new ProjectKnowledgeError('KNOWLEDGE_SECURITY_BLOCKED');
      }
    }
    async function screen(value: unknown): Promise<void> {
      const bounded = boundedJson(value);
      // Codecs have already rejected unknown keys. Scan every decoded value, including
      // embedded source JSON, without treating generated byte-counter field names as input.
      const strings: string[] = [];
      const visit = (item: unknown): void => {
        if (typeof item === 'string') strings.push(item);
        else if (Array.isArray(item)) for (const child of item as readonly unknown[]) visit(child);
        else if (item !== null && typeof item === 'object') for (const child of Object.values(item)) visit(child);
      };
      visit(bounded);
      await screenBody(strings.join('\n'));
    }
    // Replay/aggregate bounds above remain unchanged. Retained history is not
    // reader context: screen every whole field in bounded batches before any
    // disclosure, then independently screen the exact reader/report surfaces.
    await screenRetainedKnowledgeHistory(generations, screenBody);
    await screen({ contract, runtimeContext });
    const initialContext = answerInitialContext(contract, generation);
    await screen(initialContext);
    const parts = Object.freeze([
      ...initialContext.map(item => Object.freeze({ kind: item.kind, ref: item.ref, utf8Bytes: item.utf8Bytes })),
      ...(runtimeContext.body === null ? [] : [Object.freeze({ kind: 'runtime' as const, ref: 'runtime-context',
        utf8Bytes: Buffer.byteLength(runtimeContext.body) })]),
    ]);
    const knownInitialUtf8Bytes = parts.reduce((sum, part) => sum + part.utf8Bytes, 0);
    const inspection: KnowledgeAnswerContextInspectionV1 = Object.freeze({ projectId: input.projectId,
      contractDigest: contract.contractDigest, generationDigest: generation.generationDigest,
      contextFormat: contract.schemaVersion !== 'buildlore.knowledge-answer-contract.v1' ? contract.contextFormat : 'full-wiki',
      parts, knownInitialUtf8Bytes, runtimeContextKnown: runtimeContext.body !== null,
      initialLimitUtf8Bytes: KNOWLEDGE_ANSWER_BUDGET.initialContextUtf8Bytes,
      exceedsBudget: knownInitialUtf8Bytes > KNOWLEDGE_ANSWER_BUDGET.initialContextUtf8Bytes });
    return { contract, generation, generations, history, runtimeContext, initialContext, inspection, screen };
  }
  return Object.freeze({
    async inspect(input): Promise<KnowledgeAnswerContextInspectionV1> {
      return (await load(input)).inspection;
    },
    async prepare(input): Promise<KnowledgeAnswerEvaluationSessionV1> {
      const { contract, generation, generations, history, runtimeContext, initialContext, inspection, screen } = await load(input);
      if (inspection.exceedsBudget) throw new ProjectKnowledgeError('KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED');
      const budget = KNOWLEDGE_ANSWER_BUDGET;
      const lookups: (AnswerLookupV1 | AnswerLookupV2)[] = [];
      let lastQuestionIndex = -1;
      let lookupBytes = 0;
      let busy = false;
      const lookup = async (questionId: string, idsValue: unknown, kind: 'source' | 'fact'): Promise<AnswerLookupV1 | AnswerLookupV2> => {
          if (busy) invalid();
          busy = true;
          try {
            const questionIndex = contract.questions.findIndex((q) => q.id === questionId);
            if (questionIndex < 0 || questionIndex < lastQuestionIndex) invalid();
            if (lookups.length >= budget.maximumLookups) throw new ProjectKnowledgeError('KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED');
            const ids = hashes(boundedJson(idsValue), 64);
            const evidenceIds = kind === 'source' ? ids : Object.freeze([]);
            const returned = answerLookupContext(contract, generation, kind === 'source' ? 'evidence' : 'fact', ids);
            if (lookupBytes + returned.utf8Bytes > budget.evidenceLookupUtf8Bytes) {
              throw new ProjectKnowledgeError('KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED');
            }
            await screen(returned);
            const result = generation.rendererVersion === 'knowledge-markdown-v1'
              ? Object.freeze({ questionId, evidenceIds, returned })
              : Object.freeze({ questionId, evidenceIds, factIds: kind === 'fact' ? ids : Object.freeze([]), returned });
            lookups.push(result);
            lastQuestionIndex = questionIndex;
            lookupBytes += returned.utf8Bytes;
            return result;
          } finally { busy = false; }
      };
      return Object.freeze({ initialContext, runtimeContext,
        lookup(questionId: string, ids: unknown): Promise<AnswerLookupV1 | AnswerLookupV2> { return lookup(questionId, ids, 'source'); },
        async lookupFacts(questionId: string, ids: unknown): Promise<AnswerLookupV2> {
          const result = await lookup(questionId, ids, 'fact');
          if (!('factIds' in result)) invalid();
          return result;
        },
        async serializeReport(value: unknown): Promise<string> {
          if (busy) invalid();
          busy = true;
          try {
            const candidate = record(boundedJson(value));
            if (digest(candidate.initialContext) !== digest(initialContext) || digest(candidate.runtimeContext) !== digest(runtimeContext) ||
                digest(candidate.lookups) !== digest(lookups)) invalid();
            const report = history === null ? createAnswerEvaluation(candidate, contract, generations, input.projectId)
              : createAnswerEvaluationWithHistory(candidate, contract, await historyStore.verify(history.reference, input.projectId), input.projectId);
            await screen(report);
            return serializeCanonicalJson(report);
          } finally { busy = false; }
        },
      });
    },
  });
}
