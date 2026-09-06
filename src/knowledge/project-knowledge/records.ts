import { choice, compare, digest, hash, hashes, identifier, invalid, keys, list, nullableText,
  project, record, text } from './guards.js';
import { knowledgeObservationStatement } from './evidence.js';
import type { KnowledgeActorV1, KnowledgeFactInputV1, KnowledgeRecordV1, KnowledgeSnapshotV1,
  KnowledgeDigest } from './types.js';

export function parseKnowledgeActor(value: unknown): KnowledgeActorV1 {
  const actor = record(value);
  keys(actor, ['sessionId', 'model', 'kind']);
  return Object.freeze({ sessionId: identifier(actor.sessionId), model: text(actor.model, 256),
    kind: choice(actor.kind, ['agent', 'human']) });
}

export function factIdentity(projectId: string, fact: KnowledgeFactInputV1): KnowledgeDigest {
  return digest({ projectId, subject: fact.subject, predicate: fact.predicate,
    statement: fact.statement, scope: fact.scope, classification: fact.classification });
}

function parseFact(value: unknown, snapshot: KnowledgeSnapshotV1): KnowledgeFactInputV1 {
  const fact = record(value);
  keys(fact, ['subject', 'predicate', 'statement', 'scope', 'classification', 'lifecycle', 'evidenceIds', 'observation']);
  const evidenceIds = hashes(fact.evidenceIds);
  if (evidenceIds.length === 0 || evidenceIds.some((id) => !snapshot.evidence.some((e) => e.evidenceId === id))) invalid();
  const classification = choice(fact.classification, ['observed', 'declared', 'inferred']);
  const statement = text(fact.statement);
  const scope = text(fact.scope);
  let observation: KnowledgeFactInputV1['observation'] = null;
  if (fact.observation !== null) {
    const proof = record(fact.observation);
    keys(proof, ['kind', 'evidenceId']);
    observation = Object.freeze({ kind: choice(proof.kind, ['source-literal']), evidenceId: hash(proof.evidenceId) });
  }
  if (classification === 'observed') {
    const observed = snapshot.evidence.find((item) => item.evidenceId === observation?.evidenceId);
    if (!observed || evidenceIds.length !== 1 || evidenceIds[0] !== observed.evidenceId ||
        statement !== knowledgeObservationStatement(observed) || scope !== 'source-literal-only') invalid();
  } else if (observation !== null) invalid();
  return Object.freeze({ subject: text(fact.subject, 1024), predicate: nullableText(fact.predicate),
    statement, scope, classification, lifecycle: choice(fact.lifecycle, ['current', 'historical', 'stale']),
    evidenceIds, observation });
}

export function withRecordState(recordValue: Omit<KnowledgeRecordV1, 'recordDigest'>): KnowledgeRecordV1 {
  return Object.freeze({ ...recordValue, recordDigest: digest(recordValue) });
}

export function createProposedKnowledgeRecord(value: unknown, snapshot: KnowledgeSnapshotV1,
  actor: KnowledgeActorV1): KnowledgeRecordV1 {
  const fact = parseFact(value, snapshot);
  return withRecordState({ ...fact, id: factIdentity(snapshot.projectId, fact), projectId: snapshot.projectId,
    reviewStatus: 'proposed', supersededBy: Object.freeze([]),
    derivation: Object.freeze({ actor: parseKnowledgeActor(actor), snapshotDigest: snapshot.snapshotDigest }) });
}

export function verifyProposedKnowledgeRecords(value: unknown, snapshot: KnowledgeSnapshotV1,
  actor: KnowledgeActorV1): readonly KnowledgeRecordV1[] {
  const facts = list(value, 2048).map((item) => {
    const r = record(item);
    keys(r, ['subject', 'predicate', 'statement', 'scope', 'classification', 'evidenceIds', 'observation',
      'id', 'projectId', 'lifecycle', 'reviewStatus', 'supersededBy', 'derivation', 'recordDigest']);
    project(r.projectId, snapshot.projectId);
    const rebuilt = createProposedKnowledgeRecord({ subject: r.subject, predicate: r.predicate,
      statement: r.statement, scope: r.scope, classification: r.classification,
      lifecycle: r.lifecycle, evidenceIds: r.evidenceIds, observation: r.observation }, snapshot, actor);
    if (digest(r) !== digest(rebuilt)) invalid();
    return rebuilt;
  }).sort((a, b) => compare(a.id, b.id));
  if (facts.length === 0 || new Set(facts.map((f) => f.id)).size !== facts.length) invalid();
  return Object.freeze(facts);
}
