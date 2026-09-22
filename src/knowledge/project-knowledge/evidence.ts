import { enforceResourceBudget, ResourceBudgetError } from '../resource-budget.js';
import { parseJsonWithLocationsStrict } from '../strict-json.js';
import { serializeCanonicalJson } from '../atomic-file.js';
import { containsSecretRedaction } from '../../sanitizer/redaction-marker.js';
import { parseSourceChunk, sourceChunkPayload } from '../../projector/source-chunk-contract.js';
import { sourceChunkIdentity } from '../../projector/source-identity.js';
import { validateSourceOriginRange, validateJsonPointer } from '../../projector/source-contracts.js';
import { boundedJson, choice, compare, digest, hash, identifier, invalid, keys, list,
  nullableText, portablePath, project, record, serializeBoundedJson, sha256, text } from './guards.js';
import type { KnowledgeEvidenceV1, KnowledgeLocatorV1, KnowledgeSnapshotV1,
  KnowledgeSourceV1, KnowledgeSourceOriginV1 } from './types.js';

function origins(value: unknown, content: string): NonNullable<KnowledgeSourceV1['origins']> {
  const lines = content.split('\n');
  const result = list(value, 8192).map((item) => {
    const origin = record(item);
    keys(origin, ['projectedLine', 'sourceRef', 'jsonPointer', 'range']);
    if (typeof origin.projectedLine !== 'number' || !Number.isSafeInteger(origin.projectedLine) ||
        origin.projectedLine < 1 || origin.projectedLine > lines.length ||
        (lines[origin.projectedLine - 1] ?? '').trim() === '') invalid();
    try {
      return Object.freeze({ projectedLine: origin.projectedLine, sourceRef: portablePath(origin.sourceRef),
        jsonPointer: validateJsonPointer(origin.jsonPointer),
        range: validateSourceOriginRange(origin.range) });
    } catch { return invalid(); }
  }).sort((a, b) => a.projectedLine - b.projectedLine);
  if (new Set(result.map((o) => o.projectedLine)).size !== result.length) invalid();
  return Object.freeze(result);
}

function parseSource(value: unknown, projectId: string): KnowledgeSourceV1 {
  const input = record(value);
  keys(input, ['sourceId', 'sourceRef', 'sourceContentDigest', 'sourceRevision', 'codeRevision',
    'tracked', 'format', 'content', ...(Object.hasOwn(input, 'origins') ? ['origins'] : []),
    ...(Object.hasOwn(input, 'originPolicy') ? ['originPolicy'] : []),
    ...(Object.hasOwn(input, 'chunk') ? ['chunk'] : []),
    ...(Object.hasOwn(input, 'originMappings') ? ['originMappings'] : []),
    ...(Object.hasOwn(input, 'repositoryRevision') ? ['repositoryRevision'] : [])]);
  if (input.tracked !== null && typeof input.tracked !== 'boolean') invalid();
  const content = text(input.content, 262_144);
  if (input.origins !== undefined && input.format !== 'markdown') invalid();
  if (input.originPolicy !== undefined && input.originPolicy !== 'projected-v1') invalid();
  if (input.originMappings !== undefined && input.chunk === undefined && input.originPolicy === undefined) invalid();
  let fragment: Pick<KnowledgeSourceV1, 'chunk' | 'originMappings'> = {};
  if (input.chunk !== undefined || input.originMappings !== undefined) {
    if (input.format !== 'markdown') invalid();
    try {
      if (input.chunk !== undefined) {
        const raw = record(input.chunk);
        const chunk = parseSourceChunk(raw, content, sourceChunkIdentity(String(raw.parentSource), Number(raw.index)));
        const parent = chunk.parentSource.split('/');
        if (decodeURIComponent(parent[2] ?? '') !== projectId || decodeURIComponent(parent[5] ?? '') !== input.sourceRef) invalid();
        fragment = { chunk };
      }
      let endLine = 0;
      const lines = content.split('\n');
      const originMappings = list(input.originMappings, 128).map((value) => {
        const mapping = record(value); keys(mapping, ['canonical', 'origin']);
        const canonical = validateSourceOriginRange(mapping.canonical), origin = validateSourceOriginRange(mapping.origin);
        if (canonical.startLine <= endLine || canonical.endLine - canonical.startLine !== origin.endLine - origin.startLine ||
            canonical.endLine > lines.length || canonical.endColumn > Array.from(lines[canonical.endLine - 1] ?? '').length + 1) invalid();
        endLine = canonical.endLine;
        return Object.freeze({ canonical, origin });
      });
      fragment = { ...fragment, originMappings: Object.freeze(originMappings) };
    } catch { return invalid(); }
  }
  if (input.repositoryRevision !== undefined && input.repositoryRevision !== null &&
      (typeof input.repositoryRevision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.repositoryRevision))) invalid();
  return Object.freeze({
    ...fragment,
    ...(input.originPolicy === undefined ? {} : { originPolicy: input.originPolicy }),
    sourceId: identifier(input.sourceId), sourceRef: portablePath(input.sourceRef),
    sourceContentDigest: hash(input.sourceContentDigest),
    sourceRevision: nullableText(input.sourceRevision), codeRevision: nullableText(input.codeRevision),
    tracked: input.tracked, format: choice(input.format, ['markdown', 'json']),
    content,
    ...(input.repositoryRevision === undefined ? {} : { repositoryRevision: input.repositoryRevision }),
    ...(input.origins === undefined ? {} : { origins: origins(input.origins, content) }),
  });
}

function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) invalid();
  let result = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(result)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(key)) invalid();
      const items: readonly unknown[] = result;
      result = items[Number(key)];
    } else {
      const object = record(result);
      if (!Object.hasOwn(object, key)) invalid();
      result = object[key];
    }
  }
  if (result === undefined) invalid();
  return result;
}

function evidence(source: KnowledgeSourceV1, locator: KnowledgeLocatorV1,
  excerpt: string, projectId: string, origin?: KnowledgeSourceOriginV1): KnowledgeEvidenceV1 {
  const basis = {
    projectId,
    sourceId: source.sourceId, sourceRef: source.sourceRef,
    sourceContentDigest: source.sourceContentDigest, sanitizedContentDigest: sha256(source.content),
    sourceRevision: source.sourceRevision, codeRevision: source.codeRevision,
    ...(source.repositoryRevision === undefined ? {} : { repositoryRevision: source.repositoryRevision }),
    sourceRevisionUnavailableReason: source.sourceRevision === null ? 'not-provided-by-source-inventory' as const : null,
    codeRevisionUnavailableReason: source.codeRevision === null ? 'not-proven-by-source-inventory' as const : null,
    locator, excerpt, excerptDigest: sha256(excerpt),
    ...(origin === undefined ? {} : { origin }),
  };
  return Object.freeze({ ...basis, evidenceId: digest(basis) });
}

/** Sources must be sanitized by the caller before this pure transformation or persistence. */
export function extractKnowledgeEvidence(source: KnowledgeSourceV1, projectId: string,
  excludeRedacted = false): readonly KnowledgeEvidenceV1[] {
  if (source.format === 'json') {
    const parsed = parseJsonWithLocationsStrict(source.content);
    return Object.freeze(parsed.locations.flatMap(({ pointer }) => {
      const value = resolvePointer(parsed.value, pointer);
      if (typeof value === 'object' && value !== null) return [];
      if (excludeRedacted && (containsSecretRedaction(pointer) ||
        containsSecretRedaction(serializeCanonicalJson(value)))) return [];
      return [evidence(source, { kind: 'json-pointer', pointer }, serializeCanonicalJson(value).trimEnd(), projectId)];
    }));
  }
  const lines = source.content.split(/\r\n|\r|\n/u);
  const result: KnowledgeEvidenceV1[] = [];
  let start = 0;
  const originByLine = new Map(source.origins?.map((o) => [o.projectedLine, o]));
  const chunk = source.chunk;
  const prefix = chunk === undefined ? '' : Array.from(source.content).slice(0, chunk.payloadStart).join('');
  const firstPayloadLine = prefix.split('\n').length;
  const payload = chunk === undefined ? source.content : sourceChunkPayload(source.content, chunk);
  const lastPayloadLine = firstPayloadLine + payload.replace(/\n$/u, '').split('\n').length - 1;
  while (start < lines.length) {
    if (start + 1 < firstPayloadLine || start + 1 > lastPayloadLine || (lines[start] ?? '').trim() === '' ||
        (excludeRedacted && containsSecretRedaction(lines[start] ?? ''))) { start += 1; continue; }
    const mapped = source.originPolicy === 'projected-v1' && source.originMappings !== undefined;
    const mappedRange = source.originMappings?.find(item => item.canonical.startLine <= start + 1 && item.canonical.endLine >= start + 1);
    if (mapped && mappedRange === undefined && !originByLine.has(start + 1)) { start += 1; continue; }
    const origin = originByLine.get(start + 1);
    if (origin !== undefined) {
      result.push(evidence(source, { kind: 'lines', start: start + 1, end: start + 1 },
        lines[start] ?? '', projectId, origin));
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && end < lastPayloadLine && (!mapped || end < (mappedRange?.canonical.endLine ?? end)) && (lines[end] ?? '').trim() !== '' && !originByLine.has(end + 1) &&
      !(excludeRedacted && containsSecretRedaction(lines[end] ?? ''))) end += 1;
    const mapping = source.originMappings?.find((item) =>
      item.canonical.startLine <= start + 1 && item.canonical.endLine >= end);
    const rangeOrigin: KnowledgeSourceOriginV1 | undefined = mapping === undefined ? undefined : {
      projectedLine: start + 1, sourceRef: source.sourceRef,
      range: { startLine: start + 1 + mapping.origin.startLine - mapping.canonical.startLine,
        endLine: end + mapping.origin.startLine - mapping.canonical.startLine,
        startColumn: start + 1 === mapping.canonical.startLine ? mapping.origin.startColumn : 1,
        endColumn: end === mapping.canonical.endLine ? mapping.origin.endColumn : Array.from(lines[end - 1] ?? '').length + 1 },
    };
    result.push(evidence(source, { kind: 'lines', start: start + 1, end }, lines.slice(start, end).join('\n'), projectId, rangeOrigin));
    start = end;
  }
  return Object.freeze(result);
}

export function createKnowledgeSnapshot(value: unknown, expectedProjectId: string): KnowledgeSnapshotV1 {
  const input = record(boundedJson(value, 'knowledge-snapshot'));
  keys(input, ['projectId', 'selectionDigest', 'sanitizerPolicyDigest', 'sanitizerRulesVersion', 'sources']);
  if (Array.isArray(input.sources)) enforceResourceBudget('knowledge-snapshot', 'sources', input.sources.length, 2048);
  const sources = list(input.sources, 2048).map(value => parseSource(value, expectedProjectId)).sort((a, b) => compare(a.sourceId, b.sourceId));
  if (sources.length === 0 || new Set(sources.map((s) => s.sourceId)).size !== sources.length) invalid();
  const groups = new Map<string, KnowledgeSourceV1[]>();
  for (const source of sources) {
    const group = groups.get(source.sourceRef) ?? []; group.push(source); groups.set(source.sourceRef, group);
  }
  for (const group of groups.values()) {
    if (group.length === 1 && group[0]?.chunk === undefined) continue;
    group.sort((a, b) => (a.chunk?.index ?? 0) - (b.chunk?.index ?? 0));
    const first = group[0]!, chunk = first.chunk;
    if (chunk === undefined || group.length !== chunk.count) invalid();
    let end = 0;
    const payloads: string[] = [];
    for (const [index, source] of group.entries()) {
      const current = source.chunk;
      if (current === undefined || current.parentSource !== chunk.parentSource || current.index !== index + 1 ||
          current.count !== chunk.count || current.start !== end || current.totalChars !== chunk.totalChars ||
          current.fullContentHash !== chunk.fullContentHash || source.sourceContentDigest !== first.sourceContentDigest) invalid();
      payloads.push(sourceChunkPayload(source.content, current)); end = current.end;
    }
    if (end !== chunk.totalChars || sha256(payloads.join('')) !== chunk.fullContentHash) invalid();
  }
  let extracted: readonly KnowledgeEvidenceV1[];
  const projectId = project(input.projectId, expectedProjectId);
  try {
    const items: KnowledgeEvidenceV1[] = [];
    for (const s of sources) {
      const next = extractKnowledgeEvidence(s, projectId,
    input.sanitizerRulesVersion === 'buildlore.sanitizer-rules.v6' ||
    input.sanitizerRulesVersion === 'buildlore.sanitizer-rules.v7' ||
    input.sanitizerRulesVersion === 'buildlore.sanitizer-rules.v8' ||
    input.sanitizerRulesVersion === 'buildlore.sanitizer-rules.v9');
      enforceResourceBudget('knowledge-snapshot', 'evidence', items.length + next.length, 8192);
      items.push(...next);
    }
    extracted = items.sort((a, b) => compare(a.evidenceId, b.evidenceId));
  } catch (error) { if (error instanceof ResourceBudgetError) throw error; return invalid(); }
  const basis = {
    schemaVersion: 'buildlore.knowledge-snapshot.v1' as const,
    projectId, selectionDigest: hash(input.selectionDigest),
    sanitizerPolicyDigest: hash(input.sanitizerPolicyDigest), sanitizerRulesVersion: text(input.sanitizerRulesVersion, 256),
    sources: Object.freeze(sources), evidence: Object.freeze(extracted),
  };
  serializeBoundedJson(basis, 'knowledge-snapshot');
  return Object.freeze({ ...basis, snapshotDigest: digest(basis) });
}

export function parseKnowledgeSnapshot(value: unknown, expectedProjectId: string): KnowledgeSnapshotV1 {
  const input = record(boundedJson(value, 'knowledge-snapshot'));
  keys(input, ['schemaVersion', 'projectId', 'selectionDigest', 'sanitizerPolicyDigest',
    'sanitizerRulesVersion', 'sources', 'evidence', 'snapshotDigest']);
  const rebuilt = createKnowledgeSnapshot({
    projectId: input.projectId, selectionDigest: input.selectionDigest,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest, sanitizerRulesVersion: input.sanitizerRulesVersion,
    sources: input.sources,
  }, expectedProjectId);
  if (digest(input) !== digest(rebuilt)) invalid();
  return rebuilt;
}

/** Literal statement used for observed facts. It asserts no execution or project-wide truth. */
export function knowledgeObservationStatement(item: KnowledgeEvidenceV1): string {
  return `Sanitized source representation ${item.sourceRef} at ${serializeCanonicalJson(item.locator).trimEnd()} contains ${item.excerpt}`;
}
