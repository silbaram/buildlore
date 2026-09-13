import { boundedJson, choice, digest, hash, identifier, invalid, keys, list, project,
  record, text } from '../../knowledge/project-knowledge/guards.js';
import { KNOWLEDGE_ANSWER_BUDGET } from './answer-evaluation-types.js';
import type { AnswerEvaluationContract, AnswerEvaluationContractV1, AnswerEvaluationContractV2, AnswerEvaluationContractV3 } from './answer-evaluation-types.js';

/** Freeze this contract before authoring. Construction does not attest to independent oracle review. */
export function createAnswerEvaluationContract(value: unknown, expectedProjectId: string): AnswerEvaluationContractV1 {
  const input = record(boundedJson(value));
  keys(input, ['projectId', 'sampleId', 'revision', 'fixtureDigest', 'oracleDigest', 'questions']);
  const questions = list(input.questions, 5).map((item) => {
    const question = record(item);
    keys(question, ['id', 'question', 'criteria']);
    const criteria = list(question.criteria, 64).map((entry) => {
      const criterion = record(entry);
      keys(criterion, ['id', 'kind', 'statement']);
      return Object.freeze({ id: identifier(criterion.id), kind: choice(criterion.kind, ['mandatory', 'forbidden', 'unknown']),
        statement: text(criterion.statement, 4096) });
    });
    if (criteria.length === 0 || new Set(criteria.map((c) => c.id)).size !== criteria.length ||
        !criteria.some((c) => c.kind === 'mandatory')) invalid();
    return Object.freeze({ id: identifier(question.id), question: text(question.question, 4096), criteria: Object.freeze(criteria) });
  });
  if (questions.length !== 5 || new Set(questions.map((q) => q.id)).size !== 5) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-answer-contract.v1' as const,
    projectId: project(input.projectId, expectedProjectId), sampleId: identifier(input.sampleId), revision: identifier(input.revision),
    fixtureDigest: hash(input.fixtureDigest), oracleDigest: hash(input.oracleDigest), budget: KNOWLEDGE_ANSWER_BUDGET,
    questions: Object.freeze(questions) };
  return Object.freeze({ ...basis, contractDigest: digest(basis) });
}

/** Same questions and byte budgets, explicitly bound to a different reader presentation. */
export function createReaderAnswerEvaluationContract(value: unknown, expectedProjectId: string): AnswerEvaluationContractV2 {
  const { schemaVersion: unusedVersion, contractDigest: unusedDigest, ...common } = createAnswerEvaluationContract(value, expectedProjectId);
  void unusedVersion; void unusedDigest;
  const basis = { ...common, schemaVersion: 'buildlore.knowledge-answer-contract.v2' as const,
    contextFormat: 'knowledge-reader-v1' as const };
  return Object.freeze({ ...basis, contractDigest: digest(basis) });
}

/** Same frozen questions/budgets; measures the complete CLI data objects, not just their prose. */
export function createCliReaderAnswerEvaluationContract(value: unknown, expectedProjectId: string): AnswerEvaluationContractV2 {
  const { contractDigest: unusedDigest, ...common } = createReaderAnswerEvaluationContract(value, expectedProjectId);
  void unusedDigest;
  const basis = { ...common, contextFormat: 'knowledge-cli-reader-v1' as const };
  return Object.freeze({ ...basis, contractDigest: digest(basis) });
}

/** Lossless packet data and compact lookup encoding; prior formats keep their exact digests. */
export function createPacketAnswerEvaluationContract(value: unknown, expectedProjectId: string): AnswerEvaluationContractV3 {
  const { schemaVersion: unusedVersion, contractDigest: unusedDigest, ...common } = createAnswerEvaluationContract(value, expectedProjectId);
  void unusedVersion; void unusedDigest;
  const basis = { ...common, schemaVersion: 'buildlore.knowledge-answer-contract.v3' as const,
    contextFormat: 'knowledge-reader-packet-v1' as const };
  return Object.freeze({ ...basis, contractDigest: digest(basis) });
}

export function parseAnswerEvaluationContract(value: unknown, expectedProjectId: string): AnswerEvaluationContract {
  const input = record(boundedJson(value));
  const version = choice(input.schemaVersion, ['buildlore.knowledge-answer-contract.v1', 'buildlore.knowledge-answer-contract.v2', 'buildlore.knowledge-answer-contract.v3']);
  keys(input, ['schemaVersion', 'projectId', 'sampleId', 'revision', 'fixtureDigest', 'oracleDigest', 'budget', 'questions', 'contractDigest',
    ...(version !== 'buildlore.knowledge-answer-contract.v1' ? ['contextFormat'] : [])]);
  const create = version === 'buildlore.knowledge-answer-contract.v3' ? createPacketAnswerEvaluationContract
    : version === 'buildlore.knowledge-answer-contract.v1' ? createAnswerEvaluationContract
    : input.contextFormat === 'knowledge-cli-reader-v1' ? createCliReaderAnswerEvaluationContract : createReaderAnswerEvaluationContract;
  const result = create({ projectId: input.projectId, sampleId: input.sampleId, revision: input.revision,
    fixtureDigest: input.fixtureDigest, oracleDigest: input.oracleDigest, questions: input.questions }, expectedProjectId);
  if (digest(input) !== digest(result)) invalid();
  return result;
}
