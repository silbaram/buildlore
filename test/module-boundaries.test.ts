import { describe, expect, it } from 'vitest';

import * as buildlore from '../src/index.js';

describe('public module boundaries', () => {
  it('exports every approved architecture boundary', () => {
    expect(Object.keys(buildlore).sort()).toEqual([
      'cli',
      'compiler',
      'knowledge',
      'profile',
      'projector',
      'retrieval',
      'sanitizer',
      'wiki',
    ]);
    expect(typeof buildlore.projector.createP2aExecutionKnowledgeProjector).toBe('function');
    expect(typeof buildlore.projector.createP2aPlanningProjector).toBe('function');
    expect(typeof buildlore.projector.createSourceDocument).toBe('function');
    expect(typeof buildlore.projector.parseSourceDocument).toBe('function');
    expect(typeof buildlore.projector.renderSourceDocument).toBe('function');
    expect(typeof buildlore.projector.createSourceAdapterRegistry).toBe('function');
    expect(typeof buildlore.projector.parseSourceDescriptor).toBe('function');
    expect(buildlore.projector).not.toHaveProperty('decodeP2aRun');
    expect(buildlore.compiler).not.toHaveProperty('createCompilerEgressAuthorizer');
    expect(typeof buildlore.sanitizer.createProjectSecurityService).toBe('function');
    expect(typeof buildlore.profile.parseLifecycleProfile).toBe('function');
    expect(typeof buildlore.profile.materializeLifecycleProfile).toBe('function');
    expect(typeof buildlore.profile.registerProfileBinding).toBe('function');
    expect(typeof buildlore.wiki.createWikiReadService).toBe('function');
    expect(typeof buildlore.wiki.createWikiExportService).toBe('function');
    expect(typeof buildlore.compiler.createCompilationPurpose).toBe('function');
    expect(typeof buildlore.compiler.createTextUnit).toBe('function');
    expect(typeof buildlore.compiler.createDocumentInterpretation).toBe('function');
    expect(typeof buildlore.compiler.createCorpusSnapshot).toBe('function');
    expect(typeof buildlore.compiler.buildSparseRelationGraph).toBe('function');
    expect(typeof buildlore.compiler.startCompileContinuation).toBe('function');
    expect(typeof buildlore.compiler.advanceCompileContinuation).toBe('function');
    expect(typeof buildlore.compiler.finalizePlanningDispositionInventory).toBe('function');
    expect(typeof buildlore.compiler.createDocumentInterpretationRule).toBe('function');
    expect(typeof buildlore.compiler.interpretDocumentFromRules).toBe('function');
    expect(typeof buildlore.compiler.createWikiOutline).toBe('function');
    expect(typeof buildlore.compiler.diffWikiOutlines).toBe('function');
    expect(typeof buildlore.compiler.reviewWikiOutline).toBe('function');
    expect(typeof buildlore.compiler.createEvidencePack).toBe('function');
    expect(typeof buildlore.compiler.createCurrentSessionGenerationRequest).toBe('function');
    expect(typeof buildlore.compiler.submitCurrentSessionProposal).toBe('function');
    expect(typeof buildlore.compiler.reconcileWikiProposalLinks).toBe('function');
    expect(typeof buildlore.compiler.evaluateSemanticQuality).toBe('function');
    expect(typeof buildlore.compiler.finalizeCompileRun).toBe('function');
    expect(typeof buildlore.compiler.createPageOwnershipGraph).toBe('function');
    expect(typeof buildlore.compiler.approveCompileRun).toBe('function');
    expect(typeof buildlore.compiler.checkAuthoritativeWikiState).toBe('function');
    expect(typeof buildlore.compiler.createLegacyWikiMigration).toBe('function');
    expect(typeof buildlore.compiler.createLegacyWikiMigrationReview).toBe('function');
    expect(typeof buildlore.compiler.activateLegacyWikiMigration).toBe('function');
    expect(typeof buildlore.retrieval.embedding.createLocalEmbeddingProvider).toBe('function');
    expect(typeof buildlore.retrieval.createApprovedWikiProjectionStore).toBe('function');
    expect(typeof buildlore.retrieval.createLocalWikiOperator).toBe('function');
    expect(typeof buildlore.cli.createHierarchicalWikiActivationService).toBe('function');
    expect(buildlore.retrieval.embedding).not.toHaveProperty('LocalModelDirectoryHandle');
    expect(buildlore.retrieval.embedding).not.toHaveProperty('resolveVerifiedLocalModelBinding');
    expect(buildlore.retrieval.embedding).not.toHaveProperty('transformersJsCpuRuntimeFactory');
    expect(buildlore.sanitizer).not.toHaveProperty('issueSanitizationApproval');
    expect(buildlore.projector.createP2aPlanningProjector().apply.length).toBe(1);
    expect(buildlore.projector.createP2aExecutionKnowledgeProjector().apply.length).toBe(1);
  });
});
