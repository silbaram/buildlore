import { ProjectionError } from '../projector/errors.js';
import {
  createSourceAdapterRegistry,
  GENERIC_SOURCE_ADAPTER_ID,
  genericSourceAdapter,
  jsonSourceAdapter,
  P2A_SOURCE_ADAPTER_ID,
  p2aSourceAdapter,
  sourceAdapterRegistrationDigest,
  type SourceAdapterDefinitionV1,
  type SourceAdapterRegistry,
} from '../projector/source-adapter-registry.js';
import type { OutputLanguage, ProfileBinding } from './types.js';

export const PROFILE_BINDING_SCHEMA_VERSION = 'buildlore.profile-binding.v1' as const;
export const PROFILE_BINDING_V2_SCHEMA_VERSION = 'buildlore.profile-binding.v2' as const;

export type BuiltInProfileId = 'development' | 'general';

export interface ProfileAdapterBindingV1 {
  readonly adapterId: string;
  readonly adapterVersion: number;
}

export interface ProfileAdapterBindingV2 extends ProfileAdapterBindingV1 {
  readonly registrationDigest: `sha256:${string}`;
}

export interface ProfileBindingV1 {
  readonly adapters: readonly ProfileAdapterBindingV1[];
  readonly outputLanguage: OutputLanguage;
  readonly profileId: BuiltInProfileId;
  readonly schemaVersion: typeof PROFILE_BINDING_SCHEMA_VERSION;
  readonly upstreamProfile: 'custom' | 'default';
}

export interface ProfileBindingV2 {
  readonly adapters: readonly ProfileAdapterBindingV2[];
  readonly outputLanguage: OutputLanguage;
  readonly profileId: BuiltInProfileId;
  readonly schemaVersion: typeof PROFILE_BINDING_V2_SCHEMA_VERSION;
  readonly upstreamProfile: 'custom' | 'default';
}

export type AnyProfileBinding = ProfileBindingV1 | ProfileBindingV2;

export interface RegisteredProfileBindingV1 {
  readonly binding: ProfileBindingV1;
  readonly sourceAdapters: SourceAdapterRegistry;
}

export interface RegisteredProfileBindingV2 {
  readonly binding: ProfileBindingV2;
  readonly sourceAdapters: SourceAdapterRegistry;
}

export type RegisteredProfileBinding = RegisteredProfileBindingV1 | RegisteredProfileBindingV2;

export interface RegisterProfileBindingOptions {
  readonly registrations?: readonly SourceAdapterDefinitionV1[];
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

function parseAdapterBindingV2(value: unknown): ProfileAdapterBindingV2 {
  if (!isRecord(value)) return fail('Profile adapter binding is invalid.');
  exactKeys(value, ['adapterId', 'adapterVersion', 'registrationDigest']);
  const legacy = parseAdapterBinding({
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
  });
  if (typeof value.registrationDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.registrationDigest)) {
    return fail('Profile adapter registration digest is invalid.');
  }
  return Object.freeze({
    ...legacy,
    registrationDigest: value.registrationDigest as `sha256:${string}`,
  });
}

export function parseProfileBinding(value: unknown): AnyProfileBinding {
  if (!isRecord(value)) return fail('Profile binding is invalid.');
  exactKeys(value, [
    'adapters',
    'outputLanguage',
    'profileId',
    'schemaVersion',
    'upstreamProfile',
  ]);
  if (
    value.schemaVersion !== PROFILE_BINDING_SCHEMA_VERSION &&
    value.schemaVersion !== PROFILE_BINDING_V2_SCHEMA_VERSION
  ) return fail('Profile binding schema is unsupported.');
  if (
    (value.profileId !== 'general' && value.profileId !== 'development') ||
    (value.outputLanguage !== 'en' && value.outputLanguage !== 'ko') ||
    (value.upstreamProfile !== 'default' && value.upstreamProfile !== 'custom') ||
    !Array.isArray(value.adapters) ||
    value.adapters.length < 1 ||
    value.adapters.length > (value.schemaVersion === PROFILE_BINDING_SCHEMA_VERSION ? 8 : 32)
  ) return fail('Profile binding is unsupported.');
  const parsedAdapters = value.adapters.map(value.schemaVersion === PROFILE_BINDING_SCHEMA_VERSION
    ? parseAdapterBinding
    : parseAdapterBindingV2);
  const adapters = [...parsedAdapters]
    .sort((left, right) => left.adapterId < right.adapterId ? -1 : 1);
  if (parsedAdapters.some((entry, index) => entry.adapterId !== adapters[index]?.adapterId)) {
    return fail('Profile adapter binding order is invalid.');
  }
  if (new Set(adapters.map((entry) => entry.adapterId)).size !== adapters.length) {
    return fail('Profile adapter binding is duplicated.');
  }
  const expectedProfile = value.profileId === 'general' ? 'default' : 'custom';
  if (value.upstreamProfile !== expectedProfile) {
    return fail('Profile binding combination is unsupported.');
  }
  if (value.schemaVersion === PROFILE_BINDING_SCHEMA_VERSION) {
    const expectedAdapters = value.profileId === 'general'
      ? [GENERIC_SOURCE_ADAPTER_ID]
      : [GENERIC_SOURCE_ADAPTER_ID, P2A_SOURCE_ADAPTER_ID];
    if (adapters.length !== expectedAdapters.length ||
        adapters.some((entry, index) => entry.adapterId !== expectedAdapters[index])) {
      return fail('Profile binding combination is unsupported.');
    }
  } else if (
    !adapters.some((entry) => entry.adapterId === GENERIC_SOURCE_ADAPTER_ID) ||
    (value.profileId === 'general' &&
      adapters.some((entry) => entry.adapterId === P2A_SOURCE_ADAPTER_ID)) ||
    (value.profileId === 'development' &&
      !adapters.some((entry) => entry.adapterId === P2A_SOURCE_ADAPTER_ID))
  ) return fail('Profile binding combination is unsupported.');
  return Object.freeze({
    adapters: Object.freeze(adapters),
    outputLanguage: value.outputLanguage,
    profileId: value.profileId,
    schemaVersion: value.schemaVersion,
    upstreamProfile: value.upstreamProfile,
  }) as AnyProfileBinding;
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
  }) as ProfileBindingV1;
}

export function createProfileBindingV2(
  profileId: BuiltInProfileId,
  outputLanguage: OutputLanguage = profileId === 'general' ? 'en' : 'ko',
  registrations: readonly SourceAdapterDefinitionV1[] = [],
): ProfileBindingV2 {
  const definitions = [
    genericSourceAdapter(),
    jsonSourceAdapter(),
    ...(profileId === 'development' ? [p2aSourceAdapter()] : []),
    ...registrations,
  ];
  createSourceAdapterRegistry(definitions);
  return parseProfileBinding({
    adapters: definitions.map((definition) => ({
      adapterId: definition.registration.adapterId,
      adapterVersion: definition.registration.adapterVersion,
      registrationDigest: sourceAdapterRegistrationDigest(definition.registration),
    })).sort((left, right) => left.adapterId < right.adapterId ? -1 : 1),
    outputLanguage,
    profileId,
    schemaVersion: PROFILE_BINDING_V2_SCHEMA_VERSION,
    upstreamProfile: profileId === 'general' ? 'default' : 'custom',
  }) as ProfileBindingV2;
}

function definitionsForBinding(
  binding: AnyProfileBinding,
  options: RegisterProfileBindingOptions,
): readonly SourceAdapterDefinitionV1[] {
  const pool = [
    genericSourceAdapter(),
    jsonSourceAdapter(),
    p2aSourceAdapter(),
    ...(options.registrations ?? []),
  ];
  const selected = binding.adapters.map((entry) => {
    const matches = pool.filter((definition) =>
      definition.registration.adapterId === entry.adapterId &&
      definition.registration.adapterVersion === entry.adapterVersion);
    if (matches.length !== 1) return fail('Profile adapter registration is unavailable.');
    const definition = matches[0];
    if (definition === undefined ||
        (binding.schemaVersion === PROFILE_BINDING_V2_SCHEMA_VERSION &&
          ('registrationDigest' in entry === false ||
            sourceAdapterRegistrationDigest(definition.registration) !== entry.registrationDigest))) {
      return fail('Profile adapter registration digest does not match.');
    }
    return definition;
  });
  return Object.freeze(selected);
}

export function registerProfileBinding(
  value: unknown,
  options: RegisterProfileBindingOptions = {},
): RegisteredProfileBinding {
  const binding = parseProfileBinding(value);
  const sourceAdapters = createSourceAdapterRegistry(definitionsForBinding(binding, options));
  const registrations = new Map(sourceAdapters.list().map((entry) => [entry.adapterId, entry]));
  for (const adapter of binding.adapters) {
    const registration = registrations.get(adapter.adapterId);
    if (registration === undefined) return fail('Profile adapter registration is unavailable.');
    for (const kind of registration.kinds) {
      sourceAdapters.resolve({
        adapterId: adapter.adapterId,
        adapterVersion: adapter.adapterVersion,
        kind: kind.kind,
      });
    }
  }
  return Object.freeze({ binding, sourceAdapters }) as RegisteredProfileBinding;
}

export function profileBindingForLegacyResolution(value: ProfileBinding): ProfileBindingV1 {
  return createBuiltInProfileBinding(
    value.mode === 'default' ? 'general' : 'development',
    value.outputLanguage,
  );
}
