import type { KnowledgeActorV1, KnowledgeDigest } from '../../knowledge/project-knowledge/types.js';

export const KNOWLEDGE_ANSWER_BUDGET = Object.freeze({ initialContextUtf8Bytes: 32768,
  evidenceLookupUtf8Bytes: 16384, maximumLookups: 10, answerUtf8Bytes: 8192 });

export interface AnswerEvaluationContractV1 {
  readonly schemaVersion: 'buildlore.knowledge-answer-contract.v1';
  readonly projectId: string;
  readonly sampleId: string;
  readonly revision: string;
  readonly fixtureDigest: KnowledgeDigest;
  readonly oracleDigest: KnowledgeDigest;
  readonly budget: typeof KNOWLEDGE_ANSWER_BUDGET;
  readonly questions: readonly Readonly<{ id: string; question: string;
    criteria: readonly Readonly<{ id: string; kind: 'mandatory' | 'forbidden' | 'unknown'; statement: string }>[] }>[];
  readonly contractDigest: KnowledgeDigest;
}

/** Opt-in reading format; v1 retains its exact full-Markdown input and audit digests. */
export interface AnswerEvaluationContractV2 extends Omit<AnswerEvaluationContractV1, 'schemaVersion'> {
  readonly schemaVersion: 'buildlore.knowledge-answer-contract.v2';
  readonly contextFormat: 'knowledge-reader-v1' | 'knowledge-cli-reader-v1';
}

export interface AnswerEvaluationContractV3 extends Omit<AnswerEvaluationContractV1, 'schemaVersion'> {
  readonly schemaVersion: 'buildlore.knowledge-answer-contract.v3';
  readonly contextFormat: 'knowledge-reader-packet-v1';
}

export type AnswerEvaluationContract = AnswerEvaluationContractV1 | AnswerEvaluationContractV2 | AnswerEvaluationContractV3;

export interface AnswerContextItemV1 {
  readonly ref: string;
  readonly kind: 'instructions' | 'questions' | 'wiki' | 'evidence';
  readonly body: string;
  readonly bodyDigest: KnowledgeDigest;
  readonly utf8Bytes: number;
}

export type AnswerTokenUsageV1 =
  | Readonly<{ status: 'measured'; inputTokens: number; outputTokens: number; unavailableReason: null }>
  | Readonly<{ status: 'unavailable'; inputTokens: null; outputTokens: null; unavailableReason: string }>;

/** System/role messages and session framing outside the supplied Wiki task packet. */
export type AnswerRuntimeContextV1 =
  | Readonly<{ body: string; unavailableReason: null }>
  | Readonly<{ body: null; unavailableReason: string }>;

/** Independent judgments are supplied by a reviewer, never inferred from word matches. */
export interface AnswerEvaluationAnswerV1 {
  readonly questionId: string;
  readonly answer: string;
  readonly answerDigest: KnowledgeDigest;
  readonly utf8Bytes: number;
  readonly tokenUsage: AnswerTokenUsageV1;
  readonly claims: readonly Readonly<{
    id: string; startUtf8: number; endUtf8: number; text: string;
    verdict: 'supported' | 'unsupported' | 'insufficient' | 'conflicting';
    evidenceIds: readonly KnowledgeDigest[]; rationale: string;
    unsupportedImplementationOrVerification: boolean;
    historicalAsCurrent: boolean; hiddenContradiction: boolean;
  }>[];
  readonly criteria: readonly Readonly<{ criterionId: string;
    verdict: 'satisfied' | 'violated' | 'unassessed'; rationale: string }>[];
}

export interface AnswerEvaluationV1 {
  readonly schemaVersion: 'buildlore.knowledge-answer-evaluation.v1';
  readonly projectId: string;
  readonly contractDigest: KnowledgeDigest;
  readonly generationDigest: KnowledgeDigest;
  readonly origin: 'live-session' | 'deterministic-replay';
  readonly writer: KnowledgeActorV1;
  readonly reader: KnowledgeActorV1;
  readonly reviewer: KnowledgeActorV1;
  /** Digest references are audit bindings, not proof that external sessions took place. */
  readonly attestations: Readonly<{ freshReader: boolean; oracleWithheld: boolean;
    writerHistoryWithheld: boolean; oracleFrozenBeforeGeneration: boolean;
    readerSessionDigest: KnowledgeDigest | null; reviewerSessionDigest: KnowledgeDigest | null }>;
  readonly initialContext: readonly AnswerContextItemV1[];
  readonly runtimeContext: AnswerRuntimeContextV1;
  readonly lookups: readonly Readonly<{ questionId: string; evidenceIds: readonly KnowledgeDigest[];
    returned: AnswerContextItemV1 }>[];
  readonly answers: readonly AnswerEvaluationAnswerV1[];
  readonly usage: Readonly<{ initialContextUtf8Bytes: number | null; providedContextUtf8Bytes: number; evidenceLookupUtf8Bytes: number;
    lookupCount: number; answerUtf8Bytes: number }>;
  readonly outcome: 'recorded-pass' | 'failed' | 'incomplete' | 'fixture-only';
  readonly evaluationDigest: KnowledgeDigest;
}

export interface AnswerEvaluationAnswerV2 extends Omit<AnswerEvaluationAnswerV1, 'claims'> {
  readonly claims: readonly (AnswerEvaluationAnswerV1['claims'][number] & Readonly<{ factIds: readonly KnowledgeDigest[] }>)[];
}

export type AnswerLookupV1 = AnswerEvaluationV1['lookups'][number];
export type AnswerLookupV2 = AnswerLookupV1 & Readonly<{ factIds: readonly KnowledgeDigest[] }>;

/** V2 binds typed fact-state citations separately from source evidence; the frozen questions/budget are unchanged. */
export interface AnswerEvaluationV2 extends Omit<AnswerEvaluationV1, 'schemaVersion' | 'answers' | 'lookups'> {
  readonly schemaVersion: 'buildlore.knowledge-answer-evaluation.v2';
  readonly answers: readonly AnswerEvaluationAnswerV2[];
  readonly lookups: readonly AnswerLookupV2[];
}

export type AnswerEvaluation = AnswerEvaluationV1 | AnswerEvaluationV2;
