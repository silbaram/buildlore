import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { renderLifecycleProfile } from './codec.js';
import {
  BUILDLORE_PROFILE_ID,
  BUILDLORE_PROFILE_VERSION,
  type BuildLoreLifecycleProfileV1,
  type MaterializedProfile,
} from './types.js';

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function commonFields(): Readonly<Record<string, unknown>> {
  return {
    title: { type: 'string', required: true, min: 1, max: 200 },
    summary: { type: 'string', required: true, min: 1, max: 4_000 },
    sourceRefs: { type: 'string[]', required: true },
    sourceRevision: { type: 'string', required: true, min: 71, max: 71 },
    confidence: { type: 'number', min: 0, max: 1 },
    provenanceState: {
      type: 'enum',
      enum: ['extracted', 'merged', 'inferred', 'ambiguous'],
    },
    contradictedBy: { type: 'string[]' },
    archived: { type: 'boolean', default: false },
    archiveReason: { type: 'string', min: 1, max: 1_000 },
  };
}

function upstreamProfile(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    profileId: BUILDLORE_PROFILE_ID,
    profileVersion: BUILDLORE_PROFILE_VERSION,
    displayName: 'BuildLore Lifecycle Profile',
    entities: {
      decisions: {
        directory: 'wiki/decisions',
        titleField: 'title',
        requiredFields: ['title', 'summary', 'sourceRefs', 'sourceRevision', 'status'],
        fields: {
          ...commonFields(),
          rationale: { type: 'string', max: 8_000 },
          status: {
            type: 'enum',
            required: true,
            default: 'active',
            enum: ['active', 'superseded', 'archived'],
          },
        },
        retrieval: { includeInSearch: true, includeInContext: true, defaultWeight: 1.2 },
        lifecycle: {
          field: 'status',
          initial: 'active',
          terminal: ['archived'],
          transitions: {
            active: ['superseded', 'archived'],
            superseded: ['archived'],
            archived: [],
          },
          transitionRequirements: { archived: ['archiveReason'] },
          transitionRelationRequirements: {
            superseded: [
              {
                relationType: 'supersedes',
                role: 'to',
                otherTypes: ['decisions'],
                otherStates: ['active'],
                minCount: 1,
              },
            ],
          },
        },
      },
      failures: {
        directory: 'wiki/failures',
        titleField: 'title',
        requiredFields: [
          'title',
          'summary',
          'failureClass',
          'sourceRefs',
          'sourceRevision',
          'status',
        ],
        fields: {
          ...commonFields(),
          failureClass: { type: 'string', required: true, min: 1, max: 200 },
          resolution: { type: 'string', min: 1, max: 8_000 },
          status: {
            type: 'enum',
            required: true,
            default: 'open',
            enum: ['open', 'resolved', 'archived'],
          },
        },
        retrieval: { includeInSearch: true, includeInContext: true, defaultWeight: 1.1 },
        lifecycle: {
          field: 'status',
          initial: 'open',
          terminal: ['archived'],
          transitions: { open: ['resolved'], resolved: ['archived'], archived: [] },
          transitionRequirements: {
            resolved: ['resolution'],
            archived: ['archiveReason'],
          },
          transitionRelationRequirements: {
            resolved: [
              {
                relationType: 'verified-by',
                role: 'from',
                otherTypes: ['verifications'],
                otherStates: ['passed'],
                minCount: 1,
              },
            ],
          },
        },
      },
      verifications: {
        directory: 'wiki/verifications',
        titleField: 'title',
        requiredFields: [
          'title',
          'summary',
          'verificationKind',
          'evidenceRefs',
          'sourceRefs',
          'sourceRevision',
          'status',
        ],
        fields: {
          ...commonFields(),
          verificationKind: { type: 'string', required: true, min: 1, max: 200 },
          evidenceRefs: { type: 'string[]', required: true },
          command: { type: 'string', max: 2_000 },
          status: {
            type: 'enum',
            required: true,
            default: 'recorded',
            enum: ['recorded', 'passed', 'failed', 'archived'],
          },
        },
        retrieval: { includeInSearch: true, includeInContext: true, defaultWeight: 1 },
        lifecycle: {
          field: 'status',
          initial: 'recorded',
          terminal: ['archived'],
          transitions: {
            recorded: ['passed', 'failed'],
            passed: ['archived'],
            failed: ['archived'],
            archived: [],
          },
          transitionRequirements: { archived: ['archiveReason'] },
        },
      },
    },
    relations: {
      supersedes: {
        from: ['decisions'],
        to: ['decisions'],
        direction: 'directed',
      },
      'verified-by': {
        from: ['decisions', 'failures'],
        to: ['verifications'],
        direction: 'directed',
      },
    },
  };
}

function reviewConfig(): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    review: {
      hold: [
        'low-confidence',
        'contradicted',
        'schema-violating',
        'provenance-violating',
      ],
      lowConfidenceThreshold: 0.5,
      treatMissingConfidenceAs: 'low',
    },
  };
}

export function materializeLifecycleProfile(
  profile: BuildLoreLifecycleProfileV1,
): MaterializedProfile {
  const source = renderLifecycleProfile(profile);
  const profileJson = serializeCanonicalJson(upstreamProfile());
  const configJson = serializeCanonicalJson(reviewConfig());
  return Object.freeze({
    configJson,
    configJsonHash: sha256(configJson),
    profileJson,
    profileJsonHash: sha256(profileJson),
    sourceHash: sha256(source),
  });
}
