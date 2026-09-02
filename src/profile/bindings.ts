import { ProjectionError } from '../projector/errors.js';
import {
  createBuiltInSourceAdapterRegistry,
  GENERIC_SOURCE_ADAPTER_ID,
  P2A_SOURCE_ADAPTER_ID,
  type SourceAdapterRegistry,
} from '../projector/source-adapter-registry.js';
import type { OutputLanguage, ProfileBinding } from './types.js';

export const PROFILE_BINDING_SCHEMA_VERSION = 'buildlore.profile-binding.v1' as const;

export type BuiltInProfileId = 'development' | 'general';

export interface ProfileAdapterBindingV1 {
  readonly adapterId: string;
  readonly adapterVersion: number;
}

export interface ProfileBindingV1 {
  readonly adapters: readonly ProfileAdapterBindingV1[];
  readonly outputLanguage: OutputLanguage;
  readonly profileId: BuiltInProfileId;
  readonly schemaVersion: typeof PROFILE_BINDING_SCHEMA_VERSION;
  readonly upstreamProfile: 'custom' | 'default';
}

export interface RegisteredProfileBindingV1 {
  readonly binding: ProfileBindingV1;
  readonly sourceAdapters: SourceAdapterRegistry;
}

const ADAPTER_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) return fail('Profile binding fields are invalid.');
}

function parseAdapterBinding(value: unknown): ProfileAdapterBindingV1 {
  if (!isRecord(value)) return fail('Profile adapter binding is invalid.');
  exactKeys(value, ['adapterId', 'adapterVersion']);
  if (
    typeof value.adapterId !== 'string' ||
    value.adapterId.length > 128 ||
    !ADAPTER_ID_PATTERN.test(value.adapterId) ||
    value.adapterVersion !== 1
  ) return fail('Profile adapter binding is invalid.');
  return Object.freeze({
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
  });
}

export function parseProfileBinding(value: unknown): ProfileBindingV1 {
  if (!isRecord(value)) return fail('Profile binding is invalid.');
  exactKeys(value, [
    'adapters',
    'outputLanguage',
    'profileId',
    'schemaVersion',
    'upstreamProfile',
  ]);
  if (
    value.schemaVersion !== PROFILE_BINDING_SCHEMA_VERSION ||
    (value.profileId !== 'general' && value.profileId !== 'development') ||
    (value.outputLanguage !== 'en' && value.outputLanguage !== 'ko') ||
    (value.upstreamProfile !== 'default' && value.upstreamProfile !== 'custom') ||
    !Array.isArray(value.adapters) ||
    value.adapters.length < 1 ||
    value.adapters.length > 8
  ) return fail('Profile binding is unsupported.');
  const parsedAdapters = value.adapters.map(parseAdapterBinding);
  const adapters = [...parsedAdapters]
    .sort((left, right) => left.adapterId < right.adapterId ? -1 : 1);
  if (parsedAdapters.some((entry, index) => entry.adapterId !== adapters[index]?.adapterId)) {
    return fail('Profile adapter binding order is invalid.');
  }
  if (new Set(adapters.map((entry) => entry.adapterId)).size !== adapters.length) {
    return fail('Profile adapter binding is duplicated.');
  }
  const expectedProfile = value.profileId === 'general' ? 'default' : 'custom';
  const expectedAdapters = value.profileId === 'general'
    ? [GENERIC_SOURCE_ADAPTER_ID]
    : [GENERIC_SOURCE_ADAPTER_ID, P2A_SOURCE_ADAPTER_ID];
  if (
    value.upstreamProfile !== expectedProfile ||
    adapters.length !== expectedAdapters.length ||
    adapters.some((entry, index) => entry.adapterId !== expectedAdapters[index])
  ) return fail('Profile binding combination is unsupported.');
  return Object.freeze({
    adapters: Object.freeze(adapters),
    outputLanguage: value.outputLanguage,
    profileId: value.profileId,
    schemaVersion: PROFILE_BINDING_SCHEMA_VERSION,
    upstreamProfile: value.upstreamProfile,
  });
}

export function createBuiltInProfileBinding(
  profileId: BuiltInProfileId,
  outputLanguage: OutputLanguage = profileId === 'general' ? 'en' : 'ko',
): ProfileBindingV1 {
  return parseProfileBinding({
    adapters: profileId === 'general'
      ? [{ adapterId: GENERIC_SOURCE_ADAPTER_ID, adapterVersion: 1 }]
      : [
          { adapterId: GENERIC_SOURCE_ADAPTER_ID, adapterVersion: 1 },
          { adapterId: P2A_SOURCE_ADAPTER_ID, adapterVersion: 1 },
        ],
    outputLanguage,
    profileId,
    schemaVersion: PROFILE_BINDING_SCHEMA_VERSION,
    upstreamProfile: profileId === 'general' ? 'default' : 'custom',
  });
}

export function registerProfileBinding(value: unknown): RegisteredProfileBindingV1 {
  const binding = parseProfileBinding(value);
  const sourceAdapters = createBuiltInSourceAdapterRegistry({
    includeP2a: binding.adapters.some((entry) => entry.adapterId === P2A_SOURCE_ADAPTER_ID),
  });
  for (const adapter of binding.adapters) {
    sourceAdapters.resolve({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      kind: adapter.adapterId === P2A_SOURCE_ADAPTER_ID ? 'planning' : 'markdown',
    });
    if (adapter.adapterId === P2A_SOURCE_ADAPTER_ID) {
      sourceAdapters.resolve({
        adapterId: adapter.adapterId,
        adapterVersion: adapter.adapterVersion,
        kind: 'execution',
      });
    }
  }
  return Object.freeze({ binding, sourceAdapters });
}

export function profileBindingForLegacyResolution(value: ProfileBinding): ProfileBindingV1 {
  return createBuiltInProfileBinding(
    value.mode === 'default' ? 'general' : 'development',
    value.outputLanguage,
  );
}
