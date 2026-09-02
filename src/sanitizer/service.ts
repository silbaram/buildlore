import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import { issuePreparedSource } from './approval.js';
import { SecurityOperationError } from './errors.js';
import {
  generatedSourceFilenameKind,
  isGeneratedIdentifier,
} from './generated-identifiers.js';
import {
  classificationFor,
  readSecurityPolicy,
  type LoadedSecurityPolicy,
} from './policy.js';
import {
  MAX_SANITIZER_INPUT_BYTES,
  MAX_SECURITY_FINDINGS,
  securityRule,
} from './rules.js';
import {
  SANITIZER_RULES_VERSION,
  SANITIZATION_REPORT_SCHEMA_VERSION,
  type CreateProjectSecurityServiceOptions,
  type ProjectSecurityService,
  type SanitizationReport,
  type SecurityDecision,
  type SecurityFindingAction,
  type SecurityPolicy,
  type SecurityRuleSummary,
  type SourceSecurityRequest,
  type SourceSecurityResult,
} from './types.js';

const CREDENTIAL_PLACEHOLDER = '<REDACTED:CREDENTIAL>';
const ABSOLUTE_PATH_PLACEHOLDER = '<ABSOLUTE_PATH>';
const HOME_PLACEHOLDER = '<HOME>';
const WORKSPACE_PLACEHOLDER = '<WORKSPACE>';
const ABSOLUTE_PATH_START_DELIMITERS = new Set([
  '"', "'", '`', '<', '>', '[', ']', '(', ')', '{', '}', '|', ',', ';', '!', '?', '=', ':',
]);
const POSIX_ABSOLUTE_PATH_ROOTS = Object.freeze([
  '/home/',
  '/Users/',
  '/root/',
  '/var/',
  '/etc/',
  '/opt/',
  '/srv/',
  '/usr/',
  '/tmp/',
  '/mnt/',
  '/media/',
  '/proc/',
  '/dev/',
]);
const HTTP_URI_TERMINATORS = new Set([
  '"', "'", '`', '<', '>',
]);
const PATH_TOKEN_TERMINATORS = new Set([
  '"', "'", '`', '<', '>', '[', ']', '(', ')', '{', '}', '|', ',', ';', '!', '?',
]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_SOURCE_PATTERN = /^[\u0020-\u007e]{1,4096}$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TOKEN_PATTERN = /(?<![A-Za-z0-9+.-])(?:https:\/\/[A-Za-z0-9_+./=%@-]{12,}|http:\/\/[A-Za-z0-9_+./=%@-]{13,})|[A-Za-z0-9_+./=-]{20,}/giu;
const MAX_NEW_SAFE_ENTROPY_TOKEN_LENGTH = 128;
const SOURCE_KINDS = new Set([
  'code',
  'compiler-cache',
  'execution',
  'markdown',
  'planning',
  'profile',
  'provider-request',
  'text',
  'wiki',
]);
const SOURCE_REQUEST_FIELDS = new Set([
  'body',
  'bodyDigest',
  'projectId',
  'source',
  'sourceKind',
  'sourceRevisionOrContentSha256',
]);

interface Finding {
  readonly action: SecurityFindingAction;
  readonly end?: number;
  readonly replacement?: string;
  readonly ruleId: string;
  readonly start?: number;
}

interface ScanState {
  findingsOverflow: boolean;
  readonly findings: Finding[];
  readonly totals: Map<string, number>;
}

interface ProtectedPathCandidate {
  readonly order: number;
  readonly replacement: string;
  readonly ruleId: string;
  readonly value: string;
}

interface TextRange {
  readonly end: number;
  readonly start: number;
}

interface InvalidHttpUriRange extends TextRange {
  readonly contentStart: number;
}

interface HttpUriRanges {
  readonly excluded: readonly TextRange[];
  readonly invalid: readonly InvalidHttpUriRange[];
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function sourceIdentitySha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function addFinding(state: ScanState, finding: Finding): void {
  state.totals.set(finding.ruleId, (state.totals.get(finding.ruleId) ?? 0) + 1);
  if (state.findings.length < MAX_SECURITY_FINDINGS) state.findings.push(finding);
  else state.findingsOverflow = true;
}

function addMatches(
  state: ScanState,
  body: string,
  pattern: RegExp,
  ruleId: string,
  replacement: string,
  capture = 0,
): void {
  pattern.lastIndex = 0;
  let match = pattern.exec(body);
  while (match !== null) {
    const value = match[capture];
    if (value !== undefined && value.length > 0 &&
        !(replacement === CREDENTIAL_PLACEHOLDER && value === CREDENTIAL_PLACEHOLDER)) {
      const relative = capture === 0 ? 0 : match[0].indexOf(value);
      const start = match.index + relative;
      addFinding(state, {
        action: 'redact',
        end: start + value.length,
        replacement,
        ruleId,
        start,
      });
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(body);
  }
}

function overlaps(left: Finding, right: Finding): boolean {
  return left.start !== undefined && left.end !== undefined && right.start !== undefined &&
    right.end !== undefined && left.start < right.end && right.start < left.end;
}

function addLiteralPath(
  state: ScanState,
  body: string,
  value: string,
  ruleId: string,
  replacement: string,
  httpUriRanges: HttpUriRanges,
): void {
  if (value.length < 2) return;
  let start = body.indexOf(value);
  while (start >= 0) {
    const finding: Finding = {
      action: 'redact',
      end: start + value.length,
      replacement,
      ruleId,
      start,
    };
    if (!rangeContains(httpUriRanges.excluded, start) && !state.findings.some((candidate) =>
      candidate.action === 'redact' && overlaps(candidate, finding))) {
      addFinding(state, finding);
    }
    start = body.indexOf(value, start + value.length);
  }
}

function addAsciiCaseInsensitivePath(
  state: ScanState,
  body: string,
  value: string,
  ruleId: string,
  replacement: string,
  httpUriRanges: HttpUriRanges,
): void {
  if (value.length < 2 || !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(value)) return;
  const foldedBody = body.toLowerCase();
  const foldedValue = value.toLowerCase();
  let start = foldedBody.indexOf(foldedValue);
  while (start >= 0) {
    const finding: Finding = {
      action: 'redact',
      end: start + value.length,
      replacement,
      ruleId,
      start,
    };
    if (!rangeContains(httpUriRanges.excluded, start) && !state.findings.some((candidate) =>
      candidate.action === 'redact' && overlaps(candidate, finding))) {
      addFinding(state, finding);
    }
    start = foldedBody.indexOf(foldedValue, start + value.length);
  }
}

function addPathMatches(
  state: ScanState,
  body: string,
  pattern: RegExp,
  ruleId: string,
  replacement: string,
  httpUriRanges: HttpUriRanges,
): void {
  pattern.lastIndex = 0;
  let match = pattern.exec(body);
  while (match !== null) {
    const finding: Finding = {
      action: 'redact',
      end: match.index + match[0].length,
      replacement,
      ruleId,
      start: match.index,
    };
    if (!rangeContains(httpUriRanges.excluded, match.index) && !state.findings.some((candidate) =>
      candidate.action === 'redact' && overlaps(candidate, finding))) {
      addFinding(state, finding);
    }
    match = pattern.exec(body);
  }
}

function pathVariants(value: string): readonly string[] {
  return [...new Set([
    value,
    value.replaceAll('/', '\\'),
    value.replaceAll('\\', '/'),
  ])];
}

function protectedPathCandidates(
  workspace: string,
  knowledgeRoot: string,
  homePath: string,
): readonly ProtectedPathCandidate[] {
  const roots = [
    { order: 0, replacement: WORKSPACE_PLACEHOLDER, ruleId: 'path.workspace', value: workspace },
    { order: 1, replacement: WORKSPACE_PLACEHOLDER, ruleId: 'path.workspace', value: knowledgeRoot },
    { order: 2, replacement: HOME_PLACEHOLDER, ruleId: 'path.home', value: homePath },
  ] as const;
  return roots.flatMap((root) => pathVariants(root.value).map((value) => ({
    order: root.order,
    replacement: root.replacement,
    ruleId: root.ruleId,
    value,
  }))).sort((left, right) => {
    const byLength = right.value.length - left.value.length;
    if (byLength !== 0) return byLength;
    const byOrder = left.order - right.order;
    if (byOrder !== 0) return byOrder;
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  });
}

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z]$/u.test(value);
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /^\s$/u.test(value);
}

function isPathTokenTerminator(value: string | undefined): boolean {
  return value === undefined || isWhitespace(value) || PATH_TOKEN_TERMINATORS.has(value);
}

function isGenericPathBoundary(body: string, start: number): boolean {
  const previous = body[start - 1];
  return previous === undefined || isWhitespace(previous) ||
    ABSOLUTE_PATH_START_DELIMITERS.has(previous);
}

function validHttpUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function httpUriEnd(body: string, start: number): number {
  const depths = { round: 0, square: 0, curly: 0 };
  let end = start;
  while (body[end] !== undefined && !isWhitespace(body[end]) &&
      !HTTP_URI_TERMINATORS.has(body[end] ?? '')) {
    const character = body[end];
    if (character === '(') depths.round += 1;
    else if (character === '[') depths.square += 1;
    else if (character === '{') depths.curly += 1;
    else if (character === ')') {
      if (depths.round === 0) break;
      depths.round -= 1;
    } else if (character === ']') {
      if (depths.square === 0) break;
      depths.square -= 1;
    } else if (character === '}') {
      if (depths.curly === 0) break;
      depths.curly -= 1;
    }
    end += 1;
  }
  return end;
}

function collectHttpUriRanges(body: string): HttpUriRanges {
  const excluded: TextRange[] = [];
  const invalid: InvalidHttpUriRange[] = [];
  const pattern = /https?:\/\//giu;
  let match = pattern.exec(body);
  while (match !== null) {
    const start = match.index;
    const previous = body[start - 1];
    if (previous !== undefined && /^[A-Za-z0-9+.-]$/u.test(previous)) {
      match = pattern.exec(body);
      continue;
    }
    const contentStart = pattern.lastIndex;
    const end = httpUriEnd(body, contentStart);
    if (validHttpUri(body.slice(start, end))) excluded.push({ end, start });
    else invalid.push({ contentStart, end, start });
    pattern.lastIndex = end;
    match = pattern.exec(body);
  }
  return { excluded, invalid };
}

function rangeContains(ranges: readonly TextRange[], index: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (range === undefined) return false;
    if (index < range.start) high = middle - 1;
    else if (index >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function followsNonHttpUriRoot(body: string, start: number): boolean {
  if (start < 3 || body.slice(start - 2, start) !== '//' || body[start - 3] !== ':') return false;
  let schemeStart = start - 3;
  while (schemeStart > 0 && /^[A-Za-z0-9+.-]$/u.test(body[schemeStart - 1] ?? '')) {
    schemeStart -= 1;
  }
  const scheme = body.slice(schemeStart, start - 3);
  return /^[A-Za-z][A-Za-z0-9+.-]*$/u.test(scheme) && !/^https?$/iu.test(scheme);
}

function followsDrivePrefix(body: string, start: number): boolean {
  return body[start - 1] === ':' && isAsciiLetter(body[start - 2]) &&
    (start === 2 || !/^[A-Za-z0-9+.-]$/u.test(body[start - 3] ?? ''));
}

function absolutePathEnd(body: string, start: number, allowInvalidHttpBoundary: boolean): number | null {
  const first = body[start];
  if (first === '/') {
    if (body[start + 1] === '/' || isPathTokenTerminator(body[start + 1])) return null;
    if (followsDrivePrefix(body, start)) return null;
    if (!POSIX_ABSOLUTE_PATH_ROOTS.some((root) => body.startsWith(root, start))) return null;
    if (!allowInvalidHttpBoundary && !isGenericPathBoundary(body, start) &&
        !followsNonHttpUriRoot(body, start)) return null;
    let end = start + 1;
    while (!isPathTokenTerminator(body[end])) end += 1;
    return end;
  }
  if (!isAsciiLetter(first) || body[start + 1] !== ':' ||
      (body[start + 2] !== '/' && body[start + 2] !== '\\') ||
      body[start + 3] === '/' || body[start + 3] === '\\' ||
      isPathTokenTerminator(body[start + 3]) ||
      (!allowInvalidHttpBoundary && !isGenericPathBoundary(body, start))) return null;
  let end = start + 3;
  while (!isPathTokenTerminator(body[end])) end += 1;
  return end;
}

function collectAbsolutePathFindings(
  state: ScanState,
  body: string,
  httpUriRanges: HttpUriRanges,
): void {
  let excludedRangeIndex = 0;
  let invalidRangeIndex = 0;
  for (let start = 0; start < body.length; start += 1) {
    if (body[start] !== '/' && !isAsciiLetter(body[start])) continue;
    while (true) {
      const expired = httpUriRanges.excluded[excludedRangeIndex];
      if (expired === undefined || expired.end > start) break;
      excludedRangeIndex += 1;
    }
    const excludedRange = httpUriRanges.excluded[excludedRangeIndex];
    if (excludedRange !== undefined &&
        start >= excludedRange.start && start < excludedRange.end) continue;
    while (true) {
      const expired = httpUriRanges.invalid[invalidRangeIndex];
      if (expired === undefined || expired.end > start) break;
      invalidRangeIndex += 1;
    }
    const invalidRange = httpUriRanges.invalid[invalidRangeIndex];
    const allowInvalidHttpBoundary = invalidRange !== undefined &&
      start >= invalidRange.contentStart && start < invalidRange.end;
    const end = absolutePathEnd(body, start, allowInvalidHttpBoundary);
    if (end === null) continue;
    const finding: Finding = {
      action: 'redact',
      end,
      replacement: ABSOLUTE_PATH_PLACEHOLDER,
      ruleId: 'path.absolute',
      start,
    };
    if (!state.findings.some((candidate) =>
      candidate.action === 'redact' && overlaps(candidate, finding))) {
      addFinding(state, finding);
    }
    start = end - 1;
  }
}

function collectPathFindings(
  state: ScanState,
  body: string,
  workspace: string,
  homePath: string,
  knowledgeRoot: string,
): void {
  const httpUriRanges = collectHttpUriRanges(body);
  for (const candidate of protectedPathCandidates(workspace, knowledgeRoot, homePath)) {
    addLiteralPath(
      state,
      body,
      candidate.value,
      candidate.ruleId,
      candidate.replacement,
      httpUriRanges,
    );
    addAsciiCaseInsensitivePath(
      state,
      body,
      candidate.value,
      candidate.ruleId,
      candidate.replacement,
      httpUriRanges,
    );
  }
  addPathMatches(
    state,
    body,
    /\/(?:home|Users)\/[^/\s"'`]+/gu,
    'path.home',
    HOME_PLACEHOLDER,
    httpUriRanges,
  );
  addPathMatches(
    state,
    body,
    /[A-Za-z]:\\Users\\[^\\\s"'`]+/gu,
    'path.home',
    HOME_PLACEHOLDER,
    httpUriRanges,
  );
  collectAbsolutePathFindings(state, body, httpUriRanges);
}

function collectCredentialFindings(state: ScanState, body: string): void {
  addMatches(state, body, /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{8,512})/giu,
    'credential.bearer', CREDENTIAL_PLACEHOLDER, 1);
  addMatches(state, body, /\bBasic[ \t]+([A-Za-z0-9+/=]{8,512})/giu,
    'credential.basic', CREDENTIAL_PLACEHOLDER, 1);
  addMatches(state, body, /\bCookie[ \t]*:[ \t]*([^\r\n]{1,2048})/giu,
    'credential.cookie', CREDENTIAL_PLACEHOLDER, 1);
  addMatches(
    state,
    body,
    /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|COOKIE|PASSWORD|SECRET)[ \t]*=[ \t]*([^\s"']{4,512})/giu,
    'credential.environment',
    CREDENTIAL_PLACEHOLDER,
    1,
  );
  addMatches(state, body, /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    'credential.jwt', CREDENTIAL_PLACEHOLDER);
  addMatches(state, body, /\bAKIA[0-9A-Z]{16}\b/gu,
    'credential.provider.aws', CREDENTIAL_PLACEHOLDER);
  addMatches(state, body, /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/gu,
    'credential.provider.github', CREDENTIAL_PLACEHOLDER);
  addMatches(state, body, /\bnpm_[A-Za-z0-9]{20,255}\b/gu,
    'credential.provider.npm', CREDENTIAL_PLACEHOLDER);
  addMatches(state, body, /\bsk-[A-Za-z0-9_-]{20,255}\b/gu,
    'credential.provider.openai', CREDENTIAL_PLACEHOLDER);
  addMatches(state, body, /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/gu,
    'credential.provider.anthropic', CREDENTIAL_PLACEHOLDER);
  addMatches(state, body, /\bAIza[A-Za-z0-9_-]{32,64}\b/gu,
    'credential.provider.google', CREDENTIAL_PLACEHOLDER);
  addMatches(
    state,
    body,
    /\b[a-z][a-z0-9+.-]*:\/\/([^\s/@:]{1,256}:[^\s/@]{1,256})@/giu,
    'credential.url',
    CREDENTIAL_PLACEHOLDER,
    1,
  );
}

function collectResidualCredentialFinding(state: ScanState, body: string): void {
  const residual = initialState();
  collectCredentialFindings(residual, body);
  if (residual.findings.length > 0 || residual.findingsOverflow) {
    addFinding(state, { action: 'block', ruleId: 'input.redaction-incomplete' });
  }
}

function collectPrivateKeyFindings(state: ScanState, body: string): void {
  const pattern = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu;
  let match = pattern.exec(body);
  while (match !== null) {
    addFinding(state, { action: 'block', ruleId: 'private-key.pem' });
    match = pattern.exec(body);
  }
}

function containsUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function collectPromptFindings(state: ScanState, body: string): void {
  const normalized = body.normalize('NFKC');
  const patterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/giu,
      'prompt-injection.override-instructions'],
    [/(?:send|exfiltrate|upload|reveal|print)\b[^\r\n]{0,120}\b(?:secret|token|credential|system prompt)/giu,
      'prompt-injection.secret-exfiltration'],
    [/(?:system|developer)\s+(?:message|instruction|prompt)\s*:/giu,
      'prompt-injection.role-instruction'],
    [/(?:you|assistant|agent)\s+(?:must|shall|should)\s+(?:call|invoke|run|execute|use)\b[^\r\n]{0,80}\b(?:tool|command|shell|terminal)\b/giu,
      'prompt-injection.tool-action'],
  ];
  for (const [pattern, ruleId] of patterns) {
    let match = pattern.exec(normalized);
    while (match !== null) {
      addFinding(state, { action: 'quarantine', ruleId });
      match = pattern.exec(normalized);
    }
  }
}

function compatibleRedactions(left: Finding, right: Finding): boolean {
  return left.start === right.start && left.end === right.end &&
    left.replacement === right.replacement;
}

function findingPriority(finding: Finding): number {
  return securityRule(finding.ruleId)?.priority ?? Number.MAX_SAFE_INTEGER;
}

function applyRedactions(state: ScanState, body: string): string | null {
  const redactions = state.findings.filter((finding) => finding.action === 'redact').sort((left, right) => {
    const byPriority = findingPriority(left) - findingPriority(right);
    if (byPriority !== 0) return byPriority;
    const leftStart = left.start ?? 0;
    const rightStart = right.start ?? 0;
    if (leftStart !== rightStart) return leftStart - rightStart;
    const leftEnd = left.end ?? 0;
    const rightEnd = right.end ?? 0;
    if (leftEnd !== rightEnd) return leftEnd - rightEnd;
    return left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0;
  });
  const selected: Finding[] = [];
  for (const finding of redactions) {
    const conflict = selected.find((candidate) => overlaps(candidate, finding));
    if (conflict === undefined) selected.push(finding);
    else if (!compatibleRedactions(conflict, finding)) {
      addFinding(state, { action: 'block', ruleId: 'input.redaction-overlap' });
      return null;
    }
  }
  let output = body;
  for (const finding of selected.sort((left, right) => (right.start ?? 0) - (left.start ?? 0))) {
    if (finding.start === undefined || finding.end === undefined || finding.replacement === undefined) {
      return null;
    }
    output = `${output.slice(0, finding.start)}${finding.replacement}${output.slice(finding.end)}`;
  }
  return output;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function technicalIdentifierSegments(value: string): readonly string[] | null {
  const segments: string[] = [];
  let index = 0;
  while (index < value.length) {
    const rest = value.slice(index);
    const capitalized = /^[A-Z][a-z]{1,15}(?=[A-Z0-9]|$)/u.exec(rest)?.[0];
    const lowercase = /^[a-z]{2,16}(?=[A-Z0-9]|$)/u.exec(rest)?.[0];
    const acronymBoundary = /^[A-Z]{2,8}(?=[A-Z][a-z])/u.exec(rest)?.[0];
    const acronym = /^[A-Z]{2,8}(?=[0-9]|$)/u.exec(rest)?.[0];
    const numericSuffix = /^[0-9]{1,4}D?(?=$)/u.exec(rest)?.[0];
    const segment = capitalized ?? lowercase ?? acronymBoundary ?? acronym ?? numericSuffix;
    if (segment === undefined) return null;
    segments.push(segment);
    index += segment.length;
  }
  return segments;
}

function safeTechnicalIdentifier(value: string): boolean {
  if (value.length < 20 || value.length > MAX_NEW_SAFE_ENTROPY_TOKEN_LENGTH ||
      !/^[A-Za-z][A-Za-z0-9]*$/u.test(value)) return false;
  const segments = technicalIdentifierSegments(value);
  if (segments === null || segments.length < 2 || segments.length > 12) return false;
  const alphabetic = segments.filter((segment) => /^[A-Za-z]+$/u.test(segment));
  return alphabetic.length >= 2 &&
    alphabetic.some((segment) => /[a-z]/u.test(segment));
}

function safeEnvironmentVariableName(value: string): boolean {
  if (value.length < 20 || value.length > MAX_NEW_SAFE_ENTROPY_TOKEN_LENGTH) return false;
  const segments = value.split('_');
  return segments.length >= 2 && segments.length <= 8 && segments.every((segment) =>
    /^[A-Z][A-Z0-9]{0,15}$/u.test(segment) && !/[0-9][A-Z]/u.test(segment));
}

function safeBuildLoreSchemaIdentifier(value: string): boolean {
  if (value.length < 20 || value.length > MAX_NEW_SAFE_ENTROPY_TOKEN_LENGTH) return false;
  const match = /^buildlore\.([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)\.v(?:0|[1-9][0-9]{0,3})$/u
    .exec(value);
  if (match === null) return false;
  const segments = match[1]?.split('-') ?? [];
  return segments.length >= 1 && segments.length <= 6 &&
    segments.every((segment) => segment.length <= 16);
}

function safeTechnicalTaxonomy(value: string): boolean {
  if (value.length < 20 || value.length > MAX_NEW_SAFE_ENTROPY_TOKEN_LENGTH ||
      value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false;
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > 8) return false;
  return segments.some((segment) => /[a-z]/u.test(segment)) && segments.every((segment) =>
    /^(?:[a-z]{2,16}|[A-Z][a-z]{1,15}|[A-Z]{2,8})$/u.test(segment));
}

function safeCredentialFreeHttpUri(value: string): boolean {
  if (value.length > MAX_NEW_SAFE_ENTROPY_TOKEN_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '' &&
      parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

function safeEntropyToken(value: string): boolean {
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value) ||
      /^sha256:[a-f0-9]{64}$/u.test(value) ||
      /^(?:\.\/)?page-[a-f0-9]{64}\.md$/u.test(value) ||
      generatedSourceFilenameKind(value) !== null ||
      isGeneratedIdentifier(value) ||
      /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-task-[a-z0-9-]+$/u.test(value) ||
      /^(?:[A-Za-z0-9._-]{1,64}\/)+[A-Za-z0-9._-]{1,64}\.(?:cjs|js|json|md|mjs|ts|tsx|yaml|yml)$/u.test(value) ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value) ||
      /^<(?:HOME|WORKSPACE|REDACTED:CREDENTIAL)>$/u.test(value)) return true;
  return safeTechnicalIdentifier(value) || safeEnvironmentVariableName(value) ||
    safeBuildLoreSchemaIdentifier(value) || safeTechnicalTaxonomy(value) ||
    safeCredentialFreeHttpUri(value);
}

function collectEntropyCandidate(state: ScanState, value: string): void {
  if (value.length < 20) return;
  const classCount = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_+./=-]/u]
    .filter((pattern) => pattern.test(value)).length;
  if (classCount >= 3 && shannonEntropy(value) >= 4 && !safeEntropyToken(value)) {
    addFinding(state, { action: 'block', ruleId: 'entropy.candidate' });
  }
}

function collectEntropyFindings(state: ScanState, body: string): void {
  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(body);
  while (match !== null) {
    const value = match[0];
    const assignmentSeparator = value.indexOf('=');
    const assignmentName = assignmentSeparator < 0 ? '' : value.slice(0, assignmentSeparator);
    if (safeEnvironmentVariableName(assignmentName)) {
      collectEntropyCandidate(state, value.slice(assignmentSeparator + 1));
    } else collectEntropyCandidate(state, value);
    match = TOKEN_PATTERN.exec(body);
  }
}

function matchingOverride(
  policy: SecurityPolicy,
  request: SourceSecurityRequest,
  identity: string,
  ruleId: string,
): boolean {
  const rule = securityRule(ruleId);
  if (rule?.overridable !== true) return false;
  return policy.overrides.some((override) =>
    override.sourceIdentitySha256 === identity &&
    override.sourceRevisionOrContentSha256 === request.sourceRevisionOrContentSha256 &&
    override.ruleId === ruleId);
}

function summaries(
  state: ScanState,
  policy: SecurityPolicy,
  request: SourceSecurityRequest,
  identity: string,
): readonly SecurityRuleSummary[] {
  return Object.freeze([...state.totals.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([ruleId, count]) => {
      const rule = securityRule(ruleId);
      const action = rule?.action ?? 'block';
      return Object.freeze({
        action,
        count,
        overriddenCount: matchingOverride(policy, request, identity, ruleId) ? count : 0,
        ruleId,
      });
    }));
}

function decisionFor(
  state: ScanState,
  policy: SecurityPolicy,
  request: SourceSecurityRequest,
  identity: string,
): SecurityDecision {
  if (state.findingsOverflow) return 'blocked';
  let quarantine = false;
  for (const finding of state.findings) {
    if (matchingOverride(policy, request, identity, finding.ruleId)) continue;
    if (finding.action === 'block') return 'blocked';
    if (finding.action === 'quarantine') quarantine = true;
  }
  return quarantine ? 'quarantine' : 'include';
}

function initialState(): ScanState {
  return { findings: [], findingsOverflow: false, totals: new Map() };
}

function scan(
  request: SourceSecurityRequest,
  loaded: LoadedSecurityPolicy,
  homePath: string,
  knowledgeRoot: string,
  oversized = false,
): Readonly<{ approvedBody?: string; report: SanitizationReport }> {
  const identity = sourceIdentitySha256(request.source);
  const classification = classificationFor(loaded.policy, request.sourceKind, identity);
  const state = initialState();
  if (oversized) {
    addFinding(state, { action: 'block', ruleId: 'input.oversized' });
  } else {
    if (request.body.includes('\0')) addFinding(state, { action: 'block', ruleId: 'input.nul' });
    if (containsUnsafeCharacter(request.body)) {
      addFinding(state, { action: 'block', ruleId: 'input.invalid-character' });
    }
    collectPathFindings(state, request.body, loaded.workspace, homePath, knowledgeRoot);
    collectCredentialFindings(state, request.body);
    collectPrivateKeyFindings(state, request.body);
    collectPromptFindings(state, request.body);
  }
  const redacted = oversized || state.findingsOverflow
    ? null
    : applyRedactions(state, request.body);
  if (redacted !== null) {
    collectResidualCredentialFinding(state, redacted);
    collectEntropyFindings(state, redacted);
  }
  if (state.findingsOverflow) {
    state.totals.set('input.finding-overflow', 1);
    if (state.findings.length < MAX_SECURITY_FINDINGS) {
      state.findings.push({ action: 'block', ruleId: 'input.finding-overflow' });
    }
  }
  const decision = decisionFor(state, loaded.policy, request, identity);
  const approvedBody = decision === 'include' && redacted !== null ? redacted : undefined;
  const report: SanitizationReport = Object.freeze({
    schemaVersion: SANITIZATION_REPORT_SCHEMA_VERSION,
    classification,
    decision,
    findingsOverflow: state.findingsOverflow,
    inputDigest: request.bodyDigest,
    ...(approvedBody === undefined ? {} : { outputDigest: sha256(approvedBody) }),
    policyDigest: loaded.digest,
    projectId: request.projectId,
    rulesVersion: SANITIZER_RULES_VERSION,
    sourceIdentitySha256: identity,
    summaries: summaries(state, loaded.policy, request, identity),
  });
  return { ...(approvedBody === undefined ? {} : { approvedBody }), report };
}

function structurallyValidRequest(value: unknown): value is SourceSecurityRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Readonly<Record<string, unknown>>;
  return typeof request.body === 'string' &&
    typeof request.bodyDigest === 'string' && SHA256_PATTERN.test(request.bodyDigest) &&
    typeof request.projectId === 'string' && request.projectId.length <= 64 &&
    PROJECT_ID_PATTERN.test(request.projectId) &&
    typeof request.source === 'string' && SAFE_SOURCE_PATTERN.test(request.source) &&
    typeof request.sourceKind === 'string' && SOURCE_KINDS.has(request.sourceKind) &&
    typeof request.sourceRevisionOrContentSha256 === 'string' &&
    SHA256_PATTERN.test(request.sourceRevisionOrContentSha256) &&
    Object.keys(request).every((key) => SOURCE_REQUEST_FIELDS.has(key));
}

function inputTooLarge(body: string): boolean {
  return body.length > MAX_SANITIZER_INPUT_BYTES ||
    Buffer.byteLength(body, 'utf8') > MAX_SANITIZER_INPUT_BYTES;
}

function normalizeSecurityBody(body: string): string {
  return body.replace(/\r\n?/gu, '\n').normalize('NFC');
}

function invalidBindingReport(
  request: SourceSecurityRequest,
  loaded: LoadedSecurityPolicy,
): SanitizationReport {
  return Object.freeze({
    schemaVersion: SANITIZATION_REPORT_SCHEMA_VERSION,
    classification: 'restricted',
    decision: 'blocked',
    findingsOverflow: false,
    inputDigest: request.bodyDigest,
    policyDigest: loaded.digest,
    projectId: request.projectId,
    rulesVersion: SANITIZER_RULES_VERSION,
    sourceIdentitySha256: sourceIdentitySha256(request.source),
    summaries: Object.freeze([
      Object.freeze({
        action: 'block' as const,
        count: 1,
        overriddenCount: 0,
        ruleId: 'input.invalid-binding',
      }),
    ]),
  });
}

export function createProjectSecurityService(
  options: CreateProjectSecurityServiceOptions,
): ProjectSecurityService {
  const homePath = options.homePath ?? homedir();
  const knowledgeRoot = options.knowledgeRoot;
  return {
    async prepareSource(inputRequest): Promise<SourceSecurityResult> {
      let request: unknown;
      try {
        request = Object.freeze({ ...inputRequest });
      } catch {
        throw new SecurityOperationError('SECURITY_BINDING_INVALID', { projectId: 'unknown' });
      }
      if (!structurallyValidRequest(request)) {
        throw new SecurityOperationError('SECURITY_BINDING_INVALID', { projectId: 'unknown' });
      }
      const loaded = await readSecurityPolicy(knowledgeRoot, request.projectId);
      const oversized = inputTooLarge(request.body);
      if (!oversized && request.bodyDigest !== sha256(request.body)) {
        return {
          ok: false,
          report: invalidBindingReport(request, loaded),
        };
      }
      const normalizedRequest = oversized
        ? request
        : (() => {
            const body = normalizeSecurityBody(request.body);
            return { ...request, body, bodyDigest: sha256(body) };
          })();
      const outcome = scan(normalizedRequest, loaded, homePath, knowledgeRoot, oversized);
      if (outcome.approvedBody === undefined) return { ok: false, report: outcome.report };
      return {
        ok: true,
        prepared: issuePreparedSource({
          approvedBody: outcome.approvedBody,
          approvedBodyDigest: sha256(outcome.approvedBody),
          classification: outcome.report.classification,
          inputBodyDigest: request.bodyDigest,
          policyDigest: loaded.digest,
          projectId: request.projectId,
          rulesVersion: SANITIZER_RULES_VERSION,
          source: request.source,
          sourceKind: request.sourceKind,
          sourceRevisionOrContentSha256: request.sourceRevisionOrContentSha256,
          untrustedData: outcome.report.summaries.some((summary) =>
            summary.action === 'quarantine' && summary.count > 0),
        }),
        report: outcome.report,
      };
    },
  };
}
