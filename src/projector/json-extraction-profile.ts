import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import type { StrictJsonDocument } from '../knowledge/strict-json.js';
import { ProjectionError } from './errors.js';
import {
  validateJsonPointer,
  type SourceJsonOriginMappingV1,
  type SourceOriginRangeV1,
} from './source-contracts.js';
import { unicodeScalarLength } from './text-units.js';
import { MAX_SOURCE_BODY_CHARS, MAX_SOURCE_ORIGIN_MAPPINGS } from './types.js';

export const JSON_EXTRACTION_PROFILE_SCHEMA_VERSION =
  'buildlore.json-extraction-profile.v1' as const;
export const MAX_JSON_EXTRACTION_PROFILES = 32;
export const MAX_JSON_PROFILE_SECTIONS = 64;

export type JsonScalar = boolean | null | number | string;
export type JsonArrayMode = 'ordered-list' | 'sections' | 'table';

export interface JsonProfileMatchV1 {
  readonly equals: JsonScalar;
  readonly pointer: string;
}

export interface JsonProfileTitleV1 {
  readonly pointer: string;
}

export interface JsonProfileSortV1 {
  readonly direction?: 'ascending' | 'descending';
  readonly pointer: string;
}

export interface JsonProfileSectionV1 {
  readonly arrayMode?: JsonArrayMode;
  readonly displayLabels?: Readonly<Record<string, string>>;
  readonly fields?: readonly string[];
  readonly pointer: string;
  readonly sort?: 'canonical-key' | JsonProfileSortV1;
  readonly title: string;
}

export interface JsonExtractionProfileV1 {
  readonly exclude?: readonly string[];
  readonly id: string;
  readonly include?: readonly string[];
  readonly match: JsonProfileMatchV1;
  readonly required?: readonly string[];
  readonly schemaVersion: typeof JSON_EXTRACTION_PROFILE_SCHEMA_VERSION;
  readonly sections?: readonly JsonProfileSectionV1[];
  readonly title?: JsonProfileTitleV1;
}

export interface AppliedJsonExtractionProfileV1 {
  readonly contentDigest: `sha256:${string}`;
  readonly profile: JsonExtractionProfileV1;
}

export interface JsonProfileProjection {
  readonly body: string;
  readonly origins: readonly SourceJsonOriginMappingV1[];
  readonly title?: string;
}

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    fail('JSON extraction profile fields are invalid.');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value) ||
      value.length > 128) return fail('JSON extraction profile id is invalid.');
  return value;
}

function displayText(value: unknown, maximum = 500): string {
  if (typeof value !== 'string' || value.length < 1 || unicodeScalarLength(value) > maximum ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      })) {
    return fail('JSON extraction profile text is invalid.');
  }
  return value;
}

function scalar(value: unknown): JsonScalar {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))) return value;
  return fail('JSON extraction profile scalar is invalid.');
}

function exactPointer(value: unknown): string {
  const pointer = validateJsonPointer(value);
  if (pointer.split('/').includes('*')) return fail('JSON extraction profile pointer is invalid.');
  return pointer;
}

function pointerPattern(value: unknown): string {
  const pointer = validateJsonPointer(value);
  for (const segment of pointer.split('/').slice(1)) {
    if (segment.includes('*') && segment !== '*') {
      return fail('JSON extraction profile pointer pattern is invalid.');
    }
  }
  return pointer;
}

function sortedUniquePointers(value: unknown, pattern: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    return fail('JSON extraction profile pointers are invalid.');
  }
  const result = value.map(pattern ? pointerPattern : exactPointer);
  if (new Set(result).size !== result.length || result.some((entry, index) =>
    index > 0 && compareText(entry, result[index - 1] ?? '') <= 0)) {
    return fail('JSON extraction profile pointers are not canonical.');
  }
  return Object.freeze(result);
}

function parseSort(value: unknown): Exclude<JsonProfileSectionV1['sort'], undefined> {
  if (value === 'canonical-key') return value;
  if (!isRecord(value)) return fail('JSON extraction profile sort is invalid.');
  exactKeys(value, ['pointer'], ['direction']);
  if (value.direction !== undefined && value.direction !== 'ascending' &&
      value.direction !== 'descending') return fail('JSON extraction profile sort is invalid.');
  return Object.freeze({
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    pointer: exactPointer(value.pointer),
  });
}

function parseLabels(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    return fail('JSON extraction profile labels are invalid.');
  }
  const result: Record<string, string> = {};
  const keys = Object.keys(value);
  if (keys.some((key, index) => index > 0 && compareText(key, keys[index - 1] ?? '') <= 0)) {
    return fail('JSON extraction profile labels are not canonical.');
  }
  for (const key of keys) result[key] = displayText(value[key], 128);
  return Object.freeze(result);
}

function parseSection(value: unknown): JsonProfileSectionV1 {
  if (!isRecord(value)) return fail('JSON extraction profile section is invalid.');
  exactKeys(value, ['pointer', 'title'], [
    'arrayMode', 'displayLabels', 'fields', 'sort',
  ]);
  if (value.arrayMode !== undefined && value.arrayMode !== 'ordered-list' &&
      value.arrayMode !== 'sections' && value.arrayMode !== 'table') {
    return fail('JSON extraction profile array mode is invalid.');
  }
  let fields: readonly string[] | undefined;
  if (value.fields !== undefined) {
    const rawFields: readonly unknown[] = Array.isArray(value.fields) ? value.fields : [];
    if (rawFields.length < 1 || rawFields.length > 64 ||
        rawFields.some((field) => typeof field !== 'string' || field.length < 1 ||
          unicodeScalarLength(field) > 128) || new Set(rawFields).size !== rawFields.length) {
      return fail('JSON extraction profile fields are invalid.');
    }
    fields = Object.freeze(rawFields.map((field) => String(field)));
  }
  return Object.freeze({
    ...(value.arrayMode === undefined ? {} : { arrayMode: value.arrayMode }),
    ...(value.displayLabels === undefined ? {} : { displayLabels: parseLabels(value.displayLabels) }),
    ...(fields === undefined ? {} : { fields }),
    pointer: exactPointer(value.pointer),
    ...(value.sort === undefined ? {} : { sort: parseSort(value.sort) }),
    title: displayText(value.title),
  });
}

function patternSegments(value: string): readonly string[] {
  return value.split('/').slice(1);
}

function patternsOverlap(left: string, right: string): boolean {
  const a = patternSegments(left);
  const b = patternSegments(right);
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segment === '*' || b[index] === '*' || segment === b[index]);
}

export function parseJsonExtractionProfile(value: unknown): JsonExtractionProfileV1 {
  if (!isRecord(value)) return fail('JSON extraction profile is invalid.');
  exactKeys(value, ['id', 'match', 'schemaVersion'], [
    'exclude', 'include', 'required', 'sections', 'title',
  ]);
  if (value.schemaVersion !== JSON_EXTRACTION_PROFILE_SCHEMA_VERSION || !isRecord(value.match)) {
    return fail('JSON extraction profile schema is unsupported.');
  }
  exactKeys(value.match, ['equals', 'pointer']);
  const include = value.include === undefined ? undefined : sortedUniquePointers(value.include, true);
  const exclude = value.exclude === undefined ? undefined : sortedUniquePointers(value.exclude, true);
  if (include?.some((left) => exclude?.some((right) => patternsOverlap(left, right)) ?? false)) {
    return fail('JSON extraction profile pointer patterns conflict.');
  }
  let sections: readonly JsonProfileSectionV1[] | undefined;
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections) || value.sections.length < 1 ||
        value.sections.length > MAX_JSON_PROFILE_SECTIONS) {
      return fail('JSON extraction profile sections are invalid.');
    }
    sections = Object.freeze(value.sections.map(parseSection));
    for (let index = 0; index < sections.length; index += 1) {
      const pointer = sections[index]?.pointer ?? '';
      if (sections.slice(index + 1).some((other) =>
        other.pointer === pointer || other.pointer.startsWith(`${pointer}/`) ||
        pointer.startsWith(`${other.pointer}/`))) {
        return fail('JSON extraction profile sections overlap.');
      }
    }
  }
  let title: JsonProfileTitleV1 | undefined;
  if (value.title !== undefined) {
    if (!isRecord(value.title)) return fail('JSON extraction profile title is invalid.');
    exactKeys(value.title, ['pointer']);
    title = Object.freeze({ pointer: exactPointer(value.title.pointer) });
  }
  return Object.freeze({
    ...(exclude === undefined ? {} : { exclude }),
    id: identifier(value.id),
    ...(include === undefined ? {} : { include }),
    match: Object.freeze({ equals: scalar(value.match.equals), pointer: exactPointer(value.match.pointer) }),
    ...(value.required === undefined
      ? {}
      : { required: sortedUniquePointers(value.required, false) }),
    schemaVersion: JSON_EXTRACTION_PROFILE_SCHEMA_VERSION,
    ...(sections === undefined ? {} : { sections }),
    ...(title === undefined ? {} : { title }),
  });
}

export function parseJsonExtractionProfiles(value: unknown): readonly JsonExtractionProfileV1[] {
  if (!Array.isArray(value) || value.length > MAX_JSON_EXTRACTION_PROFILES) {
    return fail('JSON extraction profile catalog is invalid.');
  }
  const profiles = value.map(parseJsonExtractionProfile);
  if (profiles.some((profile, index) => index > 0 &&
      compareText(profile.id, profiles[index - 1]?.id ?? '') <= 0)) {
    return fail('JSON extraction profile catalog is not canonical.');
  }
  return Object.freeze(profiles);
}

function decodePointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function jsonValueAtPointer(value: unknown, pointer: string): unknown {
  validateJsonPointer(pointer);
  let current = value;
  if (pointer === '') return current;
  for (const encoded of pointer.split('/').slice(1)) {
    const segment = decodePointerSegment(encoded);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function sameScalar(left: unknown, right: JsonScalar): boolean {
  return (left === null || typeof left === 'boolean' || typeof left === 'number' ||
    typeof left === 'string') && Object.is(left, right);
}

export function selectJsonExtractionProfile(
  document: StrictJsonDocument,
  profiles: readonly JsonExtractionProfileV1[],
  profileRequired = false,
): AppliedJsonExtractionProfileV1 | undefined {
  const matches = profiles.filter((profile) =>
    sameScalar(jsonValueAtPointer(document.value, profile.match.pointer), profile.match.equals));
  if (matches.length > 1 || (matches.length === 0 && profileRequired)) {
    return fail('JSON extraction profile match is not unique.');
  }
  const profile = matches[0];
  if (profile === undefined) return undefined;
  if (profile.required?.some((pointer) =>
    jsonValueAtPointer(document.value, pointer) === undefined)) {
    return fail('JSON extraction profile required pointer is unavailable.');
  }
  return Object.freeze({
    contentDigest: sha256(serializeCanonicalJson(profile)),
    profile,
  });
}

function pointerMatches(pattern: string, pointer: string): boolean {
  const expected = patternSegments(pattern);
  const actual = patternSegments(pointer);
  return expected.length === actual.length && expected.every((segment, index) =>
    segment === '*' || segment === actual[index]);
}

function pointerIsWithinPattern(pattern: string, pointer: string): boolean {
  const expected = patternSegments(pattern);
  const actual = patternSegments(pointer);
  return expected.length <= actual.length && expected.every((segment, index) =>
    segment === '*' || segment === actual[index]);
}

function pointerCanReachPattern(pattern: string, pointer: string): boolean {
  const expected = patternSegments(pattern);
  const actual = patternSegments(pointer);
  return actual.length <= expected.length && actual.every((segment, index) =>
    expected[index] === '*' || expected[index] === segment);
}

function pointerVisible(profile: JsonExtractionProfileV1, pointer: string): boolean {
  if (profile.exclude?.some((pattern) => pointerIsWithinPattern(pattern, pointer)) === true) {
    return false;
  }
  if (profile.include === undefined || profile.include.length === 0) return true;
  return profile.include.some((pattern) =>
    pointerMatches(pattern, pointer) || pointerIsWithinPattern(pattern, pointer) ||
    pointerCanReachPattern(pattern, pointer));
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function scalarText(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? fail('JSON profile projection value is invalid.') : rendered;
}

function heading(depth: number, title: string): string {
  return `${'#'.repeat(Math.min(6, Math.max(2, depth + 2)))} ${title}`;
}

function scalarSortValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' ||
      typeof value === 'string') return serializeCanonicalJson(value);
  return fail('JSON extraction profile sort value is not scalar.');
}

export function renderJsonExtractionProfile(
  document: StrictJsonDocument,
  applied: AppliedJsonExtractionProfileV1,
  sourceRef: string,
  contentHash: `sha256:${string}`,
): JsonProfileProjection {
  const profile = applied.profile;
  const locations = new Map(document.locations.map((entry) => [entry.pointer, entry.range] as const));
  const lines: string[] = [];
  const origins: SourceJsonOriginMappingV1[] = [];
  const emit = (line: string, pointer: string): void => {
    const range = locations.get(pointer);
    if (range === undefined || origins.length >= MAX_SOURCE_ORIGIN_MAPPINGS) {
      return fail('JSON profile projection exceeds its origin mapping limit.');
    }
    const lineNumber = lines.length + 1;
    lines.push(line);
    const originRange: SourceOriginRangeV1 = Object.freeze({
      endColumn: range.end.column,
      endLine: range.end.line,
      startColumn: range.start.column,
      startLine: range.start.line,
    });
    origins.push(Object.freeze({
      canonical: Object.freeze({
        endColumn: unicodeScalarLength(line) + 1,
        endLine: lineNumber,
        startColumn: 1,
        startLine: lineNumber,
      }),
      origin: Object.freeze({ contentHash, jsonPointer: pointer, range: originRange, sourceRef }),
    }));
  };

  const visit = (
    value: unknown,
    pointer: string,
    depth: number,
    arrayMode: JsonArrayMode = 'ordered-list',
    fields?: readonly string[],
    labels: Readonly<Record<string, string>> = {},
    sort?: JsonProfileSectionV1['sort'],
  ): void => {
    if (!pointerVisible(profile, pointer)) return;
    if (Array.isArray(value)) {
      const arrayValue: readonly unknown[] = value;
      let entries = arrayValue.map((entry, index) => ({
        entry,
        index,
        pointer: `${pointer}/${String(index)}`,
      }));
      if (sort !== undefined && sort !== 'canonical-key') {
        entries = [...entries].sort((left, right) => {
          const a = scalarSortValue(jsonValueAtPointer(left.entry, sort.pointer));
          const b = scalarSortValue(jsonValueAtPointer(right.entry, sort.pointer));
          const compared = compareText(a, b) || left.index - right.index;
          return sort.direction === 'descending' ? -compared : compared;
        });
      }
      if (entries.length === 0) emit('_Empty array._', pointer);
      if (arrayMode === 'table') {
        const tableFields = fields ?? [...new Set(entries.flatMap(({ entry }) =>
          isRecord(entry) ? Object.keys(entry) : []))].sort(compareText);
        if (tableFields.length < 1) return fail('JSON table fields are unavailable.');
        emit(`| ${tableFields.map((field) => labels[field] ?? field).join(' | ')} |`, pointer);
        emit(`| ${tableFields.map(() => '---').join(' | ')} |`, pointer);
        for (const item of entries) {
          if (!isRecord(item.entry)) return fail('JSON table row is invalid.');
          const row = item.entry;
          const cells = tableFields.map((field) => {
            const cell = row[field];
            return cell === undefined ? '' : scalarText(cell).replaceAll('|', '\\|');
          });
          emit(`| ${cells.join(' | ')} |`, item.pointer);
        }
        return;
      }
      for (const item of entries) {
        if (arrayMode === 'ordered-list' && (typeof item.entry !== 'object' || item.entry === null)) {
          emit(`${String(item.index + 1)}. ${scalarText(item.entry)}`, item.pointer);
        } else {
          emit(heading(depth, `Item ${String(item.index + 1)}`), item.pointer);
          visit(item.entry, item.pointer, depth + 1, arrayMode, fields, labels);
        }
      }
      return;
    }
    if (isRecord(value)) {
      const keys = (fields ?? Object.keys(value)).filter((key) => Object.hasOwn(value, key));
      if (sort === 'canonical-key' || fields === undefined) keys.sort(compareText);
      if (keys.length === 0) emit('_Empty object._', pointer);
      for (const key of keys) {
        const childPointer = `${pointer}/${pointerSegment(key)}`;
        if (!pointerVisible(profile, childPointer)) continue;
        emit(heading(depth, labels[key] ?? JSON.stringify(key)), childPointer);
        visit(value[key], childPointer, depth + 1, arrayMode, undefined, labels);
      }
      return;
    }
    emit(scalarText(value), pointer);
  };

  if (profile.sections === undefined) {
    visit(document.value, '', 0);
  } else {
    for (const section of profile.sections) {
      const value = jsonValueAtPointer(document.value, section.pointer);
      if (value === undefined) return fail('JSON extraction profile section is unavailable.');
      emit(heading(0, section.title), section.pointer);
      visit(
        value,
        section.pointer,
        1,
        section.arrayMode,
        section.fields,
        section.displayLabels,
        section.sort,
      );
    }
  }
  const body = lines.join('\n');
  if (body.length < 1 || unicodeScalarLength(body) > MAX_SOURCE_BODY_CHARS) {
    return fail('JSON profile projection exceeds its output limit.');
  }
  let title: string | undefined;
  if (profile.title !== undefined) {
    const value = jsonValueAtPointer(document.value, profile.title.pointer);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return fail('JSON extraction profile title is not scalar.');
    }
    title = displayText(String(value));
  }
  return Object.freeze({
    body,
    origins: Object.freeze(origins),
    ...(title === undefined ? {} : { title }),
  });
}
