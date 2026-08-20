import { createHash } from 'node:crypto';

import { validateProjectId } from '../knowledge/validation.js';
import { ProfileOperationError } from './errors.js';
import type {
  LifecycleEntityType,
  LifecycleFixture,
  LifecycleFixtureResult,
  LifecycleReviewSignals,
  ProfileEntityType,
  ProfileHeldReason,
} from './types.js';

const ENTITY_DIRECTORY: Readonly<Record<LifecycleEntityType, ProfileEntityType>> = {
  decision: 'decisions',
  failure: 'failures',
  verification: 'verifications',
};

function safeStableKey(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
  });
  return value.length >= 1 && value.length <= 2_048 &&
    !hasControlCharacter &&
    !/(?:^|[\\/])(?:home|Users)(?:[\\/]|$)/u.test(value) &&
    !/^[A-Za-z]:[\\/]/u.test(value);
}

export function deriveLifecyclePageId(input: {
  readonly entityType: LifecycleEntityType;
  readonly producerStableKey: string;
  readonly projectId: string;
}): `${ProfileEntityType}/${string}` {
  const projectId = validateProjectId(input.projectId);
  if (!safeStableKey(input.producerStableKey)) {
    throw new ProfileOperationError('PROFILE_SOURCE_INVALID', { projectId });
  }
  const digest = createHash('sha256')
    .update(
      `buildlore.lifecycle-page.v1\0${projectId}\0${input.entityType}\0${input.producerStableKey}`,
      'utf8',
    )
    .digest('hex');
  return `${ENTITY_DIRECTORY[input.entityType]}/${digest}`;
}

export function evaluateLifecycleReview(
  signals: LifecycleReviewSignals,
): readonly ProfileHeldReason[] {
  if (signals.confidence !== undefined &&
      (!Number.isFinite(signals.confidence) || signals.confidence < 0 || signals.confidence > 1)) {
    return ['schema-violating'];
  }
  const reasons: ProfileHeldReason[] = [];
  if (signals.confidence === undefined || signals.confidence < 0.5) {
    reasons.push('low-confidence');
  }
  if (signals.contradicted === true) reasons.push('contradicted');
  if ((signals.schemaViolations?.length ?? 0) > 0) reasons.push('schema-violating');
  if ((signals.provenanceViolations?.length ?? 0) > 0) {
    reasons.push('provenance-violating');
  }
  return reasons;
}

export function isLifecycleTransitionAllowed(
  entityType: LifecycleEntityType,
  from: string,
  to: string,
): boolean {
  const transitions: Readonly<Record<LifecycleEntityType, Readonly<Record<string, readonly string[]>>>> = {
    decision: {
      active: ['superseded', 'archived'],
      superseded: ['archived'],
      archived: [],
    },
    failure: { open: ['resolved'], resolved: ['archived'], archived: [] },
    verification: {
      recorded: ['passed', 'failed'],
      passed: ['archived'],
      failed: ['archived'],
      archived: [],
    },
  };
  return transitions[entityType][from]?.includes(to) === true;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function validateLifecycleFixture(fixture: LifecycleFixture): LifecycleFixtureResult {
  const issues: string[] = [];
  const allowedStates: Readonly<Record<LifecycleEntityType, readonly string[]>> = {
    decision: ['active', 'superseded', 'archived'],
    failure: ['open', 'resolved', 'archived'],
    verification: ['recorded', 'passed', 'failed', 'archived'],
  };
  if (!allowedStates[fixture.entityType].includes(fixture.state)) issues.push('state-unsupported');
  if (fixture.entityType === 'decision' && fixture.state === 'superseded' &&
      (fixture.incomingSupersedesFromActive ?? 0) < 1) {
    issues.push('supersedes-required');
  }
  if (fixture.entityType === 'failure' && fixture.state === 'resolved') {
    if (!nonEmpty(fixture.resolution)) issues.push('resolution-required');
    if ((fixture.outgoingPassedVerifications ?? 0) < 1) issues.push('verified-by-required');
  }
  if (fixture.entityType === 'verification' &&
      (fixture.state === 'passed' || fixture.state === 'failed') &&
      (fixture.evidenceRefs?.length ?? 0) < 1) {
    issues.push('evidence-required');
  }
  if (fixture.state === 'archived' && !nonEmpty(fixture.archiveReason)) {
    issues.push('archive-reason-required');
  }
  const heldReasons = evaluateLifecycleReview(fixture);
  return Object.freeze({
    heldReasons: Object.freeze([...heldReasons]),
    issues: Object.freeze(issues.sort()),
    valid: issues.length === 0,
  });
}
