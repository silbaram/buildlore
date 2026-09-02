import {
  APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
  type ApprovedWikiAuthorityV1,
} from '../../src/retrieval/index.js';
import {
  checkAuthoritativeWikiState,
  createCompileIntegrityReport,
  createHumanActivationApproval,
  createPageOwnershipGraph,
  finalizeCompileRun,
  verifyCompileRunApproval,
  type FinalizeCompileRunInputV1,
} from '../../src/compiler/index.js';

import {
  createDeterministicHierarchicalGenerationFixture,
  createSharedCitationHierarchicalGenerationFixture,
  type HierarchicalGenerationFixtureV1,
} from './hierarchical-generation-fixture.js';

function createAuthority(
  fixture: HierarchicalGenerationFixtureV1,
  projectId: string,
): ApprovedWikiAuthorityV1 {
  const finalization: FinalizeCompileRunInputV1 = Object.freeze({
    ...fixture.integrityInput,
    integrityReport: createCompileIntegrityReport(fixture.integrityInput, projectId),
  });
  const ledger = finalizeCompileRun(finalization, projectId);
  const ownershipGraph = createPageOwnershipGraph(
    fixture.snapshot,
    finalization.outline,
    ledger,
    finalization.proposals,
    finalization.evidencePacks,
    projectId,
  );
  const currentState = null;
  const humanActivationApproval = createHumanActivationApproval({
    ledger,
    ownershipGraph,
    currentState,
    decision: 'approved',
    explicitConfirmation: true,
  }, projectId);
  const state = verifyCompileRunApproval({
    currentState,
    finalization,
    humanActivationApproval,
    ledger,
    liveSnapshot: fixture.snapshot,
    ownershipGraph,
  }, projectId);
  const authorityCheck = checkAuthoritativeWikiState(
    state,
    ownershipGraph,
    fixture.snapshot,
    humanActivationApproval,
    projectId,
  );
  return Object.freeze({
    authorityCheck,
    currentState,
    finalization,
    humanActivationApproval,
    ledger,
    liveSnapshot: fixture.snapshot,
    ownershipGraph,
    projectId,
    schemaVersion: APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
    state,
  });
}

export function createApprovedAuthorityFixture(
  projectId: string,
  sanitizerPolicyDigest: `sha256:${string}`,
): ApprovedWikiAuthorityV1 {
  const fixture = createDeterministicHierarchicalGenerationFixture(
    projectId,
    sanitizerPolicyDigest,
  );
  return createAuthority(fixture, projectId);
}

/** Test-only approved authority with canonical-equal citation IDs reused across page packs. */
export function createSharedCitationApprovedAuthorityFixture(
  projectId: string,
  sanitizerPolicyDigest: `sha256:${string}`,
): ApprovedWikiAuthorityV1 {
  return createAuthority(
    createSharedCitationHierarchicalGenerationFixture(projectId, sanitizerPolicyDigest),
    projectId,
  );
}
