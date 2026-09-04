import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
  digestCurrentSessionProposalSecurityBody,
  type CorpusSnapshotV1,
} from '../compiler/index.js';
import { readConfinedSessionUtf8 } from '../compiler/session/safe-io.js';
import { resolveLocalProjectBinding } from '../knowledge/local-project-registry.js';
import { createRepositoryWriterLease } from '../knowledge/repository-writer-lease.js';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { showProject } from '../knowledge/workspace.js';
import { resolveRegisteredProfileBinding } from '../profile/preflight.js';
import { createSourceCollectionAdapter } from '../projector/collection-adapters.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../projector/json-knowledge-adapter.js';
import {
  boundRawSourceInputsAreSafe,
  inspectRawSourceInputs,
  rawSourceInputSanitizationIsSafe,
} from '../projector/raw-source-inputs.js';
import { createSourceDocument } from '../projector/source-document.js';
import {
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
} from '../projector/source-manifest.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import {
  createProjectSecurityService,
  readSecurityPolicy,
  type ProjectSecurityService,
} from '../sanitizer/index.js';
import {
  APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
  readApprovedWikiPublicationSnapshot,
  type ApprovedWikiAuthorityV1,
} from '../retrieval/index.js';
import { verifyApprovedWikiAuthority } from '../retrieval/approved-corpus-store.js';
import {
  createHierarchicalMarkdownPublication,
  type HierarchicalMarkdownPublicationPort,
} from '../retrieval/hierarchical-markdown-publication.js';

export const HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION =
  'buildlore.hierarchical-wiki-activation-input.v1' as const;
export const HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-wiki-activation-result.v2' as const;
export const DEFAULT_HIERARCHICAL_WIKI_ACTIVATION_INPUT =
  '.buildlore/approved-wiki.json' as const;

const MAXIMUM_ACTIVATION_BYTES = 64 * 1024 * 1024;
const FIXED_COLLECTION_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type HierarchicalWikiActivationErrorCode =
  | 'HIERARCHICAL_WIKI_ACTIVATION_APPROVAL_MISMATCH'
  | 'HIERARCHICAL_WIKI_ACTIVATION_INVALID'
  | 'HIERARCHICAL_WIKI_ACTIVATION_PROJECT_MISMATCH'
  | 'HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT';

export class HierarchicalWikiActivationError extends Error {
  readonly code: HierarchicalWikiActivationErrorCode;
  readonly retryable = false;

  constructor(code: HierarchicalWikiActivationErrorCode) {
    super(code === 'HIERARCHICAL_WIKI_ACTIVATION_APPROVAL_MISMATCH'
      ? 'Hierarchical Wiki activation approval confirmation does not match.'
      : code === 'HIERARCHICAL_WIKI_ACTIVATION_PROJECT_MISMATCH'
      ? 'Hierarchical Wiki activation project does not match.'
      : code === 'HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT'
        ? 'Hierarchical Wiki activation inputs are no longer current.'
        : 'Hierarchical Wiki activation input is invalid.');
    this.name = 'HierarchicalWikiActivationError';
    this.code = code;
  }
}

export interface HierarchicalWikiLiveSnapshotVerifierPort {
  verify(authority: ApprovedWikiAuthorityV1, projectId: string): Promise<void>;
}

export interface HierarchicalWikiActivationResultV2 {
  readonly schemaVersion: typeof HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION;
  readonly corpusDigest: `sha256:${string}`;
  readonly egress: 'none';
  readonly generationDigest: `sha256:${string}`;
  readonly materialization: Readonly<{
    readonly fileCount: number;
    readonly generationDigest: `sha256:${string}`;
    readonly materializationDigest: `sha256:${string}`;
    readonly pageCount: number;
    readonly projectId: string;
    readonly schemaVersion: 'buildlore.hierarchical-markdown-materialization-status.v2';
    readonly state: 'ready';
  }>;
  readonly pageCount: number;
  readonly projectId: string;
  readonly projectionDigest: `sha256:${string}`;
  readonly providerUsed: 'none';
}

export interface HierarchicalWikiActivationPort {
  activate(input: Readonly<{
    readonly confirmationDigest?: `sha256:${string}`;
    readonly inputFile?: string;
    readonly projectId: string;
    readonly rematerialize?: true;
  }>): Promise<Readonly<HierarchicalWikiActivationResultV2>>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(code: HierarchicalWikiActivationErrorCode): never {
  throw new HierarchicalWikiActivationError(code);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function parseActivation(value: unknown, projectId: string): ApprovedWikiAuthorityV1 {
  const expectedKeys = ['authority', 'projectId', 'schemaVersion'].sort();
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== expectedKeys.join('\0') ||
      value.schemaVersion !== HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION ||
      typeof value.projectId !== 'string' || !isRecord(value.authority) ||
      value.authority.schemaVersion !== APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION ||
      !isRecord(value.authority.liveSnapshot) ||
      !isRecord(value.authority.humanActivationApproval) ||
      typeof value.authority.humanActivationApproval.approvalDigest !== 'string' ||
      !DIGEST_PATTERN.test(value.authority.humanActivationApproval.approvalDigest)) {
    invalid('HIERARCHICAL_WIKI_ACTIVATION_INVALID');
  }
  if (value.projectId !== projectId || value.authority.projectId !== projectId) {
    invalid('HIERARCHICAL_WIKI_ACTIVATION_PROJECT_MISMATCH');
  }
  return value.authority as unknown as ApprovedWikiAuthorityV1;
}

async function replayProposalSecurity(
  authority: ApprovedWikiAuthorityV1,
  projectId: string,
  security: ProjectSecurityService,
): Promise<void> {
  const snapshot = authority.liveSnapshot;
  for (const proposal of authority.finalization.proposals) {
    const body = [
      proposal.title,
      proposal.summary,
      ...proposal.sections.map((section) => section.body),
      ...proposal.claims.map((claim) => claim.text),
    ].join('\n');
    if (sha256(body) !== digestCurrentSessionProposalSecurityBody(proposal, projectId)) {
      invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
    }
    const result = await security.prepareSource({
      body,
      bodyDigest: sha256(body),
      projectId,
      source: `hierarchical-wiki-${proposal.pageId}`,
      sourceKind: 'wiki',
      sourceRevisionOrContentSha256: proposal.proposalDigest,
    });
    const prepared = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!result.ok || result.report.outputDigest !== sha256(body) ||
        result.report.policyDigest !== snapshot.sanitizerPolicyDigest ||
        prepared === null || prepared.approvedBody !== body ||
        prepared.approvedBodyDigest !== sha256(body) ||
        prepared.inputBodyDigest !== sha256(body) ||
        prepared.policyDigest !== snapshot.sanitizerPolicyDigest ||
        prepared.projectId !== projectId || prepared.sourceKind !== 'wiki' ||
        prepared.sourceRevisionOrContentSha256 !== proposal.proposalDigest ||
        prepared.untrustedData) {
      invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
    }
  }
}

function createLiveSnapshotVerifier(options: Readonly<{
  readonly hubRoot: string;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  readonly knowledgeRoot: string;
}>): HierarchicalWikiLiveSnapshotVerifierPort {
  return Object.freeze({
    async verify(authority: ApprovedWikiAuthorityV1, projectId: string) {
      try {
        const snapshot: CorpusSnapshotV1 = authority.liveSnapshot;
        const project = await showProject(options.knowledgeRoot, projectId);
        const binding = await resolveLocalProjectBinding(
          options.hubRoot,
          projectId,
          project.entry.sourceRepository,
        );
        const profile = await resolveRegisteredProfileBinding(options.knowledgeRoot, projectId, {
          registrations: options.jsonKnowledgeAdapters ?? [],
        });
        const loadedManifest = await readSourceCollectionManifest(binding.checkout, projectId, {
          sourceAdapterRegistry: profile.sourceAdapters,
        });
        const inventory = await selectDeclaredSourceFiles(binding.checkout, loadedManifest, {
          sourceAdapterRegistry: profile.sourceAdapters,
        });
        const [policy, collected] = await Promise.all([
          readSecurityPolicy(options.knowledgeRoot, projectId),
          createSourceCollectionAdapter({
            jsonKnowledgeAdapters: options.jsonKnowledgeAdapters ?? [],
          }).collect({
            checkout: binding.checkout,
            ingestedAt: FIXED_COLLECTION_TIMESTAMP,
            inventory,
            loadedManifest,
            sourceAdapterRegistry: profile.sourceAdapters,
          }),
        ]);
        if (loadedManifest.manifestDigest !== snapshot.sourceManifestDigest ||
            policy.digest !== snapshot.sanitizerPolicyDigest ||
            collected.notices.length > 0 || collected.entries.some((entry) =>
              entry.decision === 'blocked' || entry.decision === 'error' ||
              entry.decision === 'quarantine')) {
          invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
        }
        const security = createProjectSecurityService({ knowledgeRoot: options.knowledgeRoot });
        if (!await boundRawSourceInputsAreSafe(collected, {
          policyDigest: policy.digest,
          projectId,
          security,
          source: `buildlore://project/${projectId}/selected-json-inputs`,
          sourceKind: 'json',
          sourceRevision: loadedManifest.manifestDigest,
        })) invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
        const liveSources: Array<Readonly<{
          readonly sanitizedContentDigest: `sha256:${string}`;
          readonly sourceRef: string;
          readonly sourceRevision: `sha256:${string}`;
        }>> = [];
        for (const candidate of collected.candidates) {
          const result = await security.prepareSource({
            body: candidate.body,
            bodyDigest: sha256(candidate.body),
            projectId,
            source: candidate.sourceUri,
            sourceKind: candidate.sourceKind,
            sourceRevisionOrContentSha256: candidate.sourceRevision,
          });
          if (!result.ok) invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
          const prepared = consumePreparedSource(result.prepared);
          if (result.report.outputDigest === undefined || prepared === null ||
              prepared.approvedBodyDigest !== result.report.outputDigest ||
              prepared.inputBodyDigest !== sha256(candidate.body) ||
              prepared.policyDigest !== snapshot.sanitizerPolicyDigest ||
              prepared.projectId !== projectId ||
              prepared.source !== candidate.sourceUri ||
              prepared.sourceKind !== candidate.sourceKind ||
              prepared.sourceRevisionOrContentSha256 !== candidate.sourceRevision ||
              sha256(prepared.approvedBody) !== prepared.approvedBodyDigest ||
              result.report.policyDigest !== snapshot.sanitizerPolicyDigest) {
            invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
          }
          for (const rawInput of inspectRawSourceInputs(candidate)) {
            const rawDigest = sha256(rawInput.body);
            const rawResult = await security.prepareSource({
              body: rawInput.body,
              bodyDigest: rawDigest,
              projectId,
              source: candidate.sourceUri,
              sourceKind: candidate.sourceKind,
              sourceRevisionOrContentSha256: candidate.sourceRevision,
            });
            const rawPrepared = rawResult.ok ? consumePreparedSource(rawResult.prepared) : null;
            if (!rawResult.ok || rawPrepared === null ||
                rawPrepared.inputBodyDigest !== rawDigest ||
                rawPrepared.approvedBodyDigest !== rawResult.report.outputDigest ||
                rawPrepared.policyDigest !== snapshot.sanitizerPolicyDigest ||
                rawPrepared.projectId !== projectId || rawPrepared.source !== candidate.sourceUri ||
                rawPrepared.sourceKind !== candidate.sourceKind ||
                rawPrepared.sourceRevisionOrContentSha256 !== candidate.sourceRevision ||
                !rawSourceInputSanitizationIsSafe(
                  rawInput,
                  rawPrepared.approvedBody,
                  rawResult.report.summaries,
                )) invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
          }
          const canonical = createSourceDocument({
            body: prepared.approvedBody,
            ...(candidate.descriptor === undefined ? {} : { descriptor: candidate.descriptor }),
            ingestedAt: candidate.ingestedAt,
            ...(candidate.originMappings === undefined
              ? {}
              : { originMappings: candidate.originMappings }),
            ...(candidate.jsonOrigins === undefined
              ? {}
              : { jsonOrigins: candidate.jsonOrigins }),
            producer: candidate.producer,
            projectId,
            source: candidate.sourceUri,
            sourceKind: candidate.sourceKind,
            sourceRevision: candidate.sourceRevision,
            sourceType: 'file',
            title: candidate.title,
          });
          liveSources.push(Object.freeze({
            sanitizedContentDigest: canonical.buildlore.contentHash,
            sourceRef: candidate.sourceRef,
            sourceRevision: candidate.sourceRevision,
          }));
        }
        const expected = snapshot.sources.map((source) => Object.freeze({
          sanitizedContentDigest: source.sanitizedContentDigest,
          sourceRef: source.sourceRef,
          sourceRevision: source.sourceRevision,
        }));
        const compare = (left: { readonly sourceRef: string }, right: { readonly sourceRef: string }) =>
          left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0;
        if (JSON.stringify(liveSources.sort(compare)) !== JSON.stringify([...expected].sort(compare))) {
          invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
        }
        await replayProposalSecurity(authority, projectId, security);
      } catch (error) {
        if (error instanceof HierarchicalWikiActivationError) throw error;
        invalid('HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT');
      }
    },
  });
}

export function createHierarchicalWikiActivationService(options: Readonly<{
  readonly hubRoot: string;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  readonly knowledgeRoot: string;
  readonly liveSnapshotVerifier?: HierarchicalWikiLiveSnapshotVerifierPort;
  readonly markdownPublication?: HierarchicalMarkdownPublicationPort;
}>): HierarchicalWikiActivationPort {
  const markdownPublication = options.markdownPublication ??
    createHierarchicalMarkdownPublication({
      knowledgeRoot: options.knowledgeRoot,
      lease: createRepositoryWriterLease(),
    });
  const verifier = options.liveSnapshotVerifier ?? createLiveSnapshotVerifier(options);
  const service: HierarchicalWikiActivationPort = {
    async activate(input) {
      if (input.rematerialize === true) {
        if (input.confirmationDigest !== undefined || input.inputFile !== undefined) {
          invalid('HIERARCHICAL_WIKI_ACTIVATION_INVALID');
        }
        const status = await markdownPublication.status(input.projectId);
        if (status.state !== 'renderer-outdated') {
          invalid('HIERARCHICAL_WIKI_ACTIVATION_INVALID');
        }
        let current;
        try {
          current = await readApprovedWikiPublicationSnapshot(
            options.knowledgeRoot,
            input.projectId,
          );
        } catch {
          return invalid('HIERARCHICAL_WIKI_ACTIVATION_INVALID');
        }
        const published = await markdownPublication.publish({
          authority: current.authority,
          preserveAuthority: true,
          projectId: input.projectId,
        });
        const projection = published.projection;
        return Object.freeze({
          corpusDigest: projection.corpus.corpusDigest,
          egress: 'none' as const,
          generationDigest: projection.corpus.generationDigest,
          materialization: published.materialization,
          pageCount: projection.corpus.pages.length,
          projectId: input.projectId,
          projectionDigest: projection.projectionDigest,
          providerUsed: 'none' as const,
          schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
        });
      }
      if (input.rematerialize !== undefined) {
        invalid('HIERARCHICAL_WIKI_ACTIVATION_INVALID');
      }
      const path = resolve(
        options.hubRoot,
        input.inputFile ?? DEFAULT_HIERARCHICAL_WIKI_ACTIVATION_INPUT,
      );
      let authority: ApprovedWikiAuthorityV1;
      try {
        authority = parseActivation(parseJsonStrict(await readConfinedSessionUtf8(
          path,
          options.hubRoot,
          MAXIMUM_ACTIVATION_BYTES,
          input.projectId,
        )), input.projectId);
      } catch (error) {
        if (error instanceof HierarchicalWikiActivationError) throw error;
        invalid('HIERARCHICAL_WIKI_ACTIVATION_INVALID');
      }
      if (input.confirmationDigest !== authority.humanActivationApproval.approvalDigest) {
        invalid('HIERARCHICAL_WIKI_ACTIVATION_APPROVAL_MISMATCH');
      }
      verifyApprovedWikiAuthority(authority, input.projectId);
      await verifier.verify(authority, input.projectId);
      const published = await markdownPublication.publish({
        authority,
        projectId: input.projectId,
      });
      const projection = published.projection;
      return Object.freeze({
        corpusDigest: projection.corpus.corpusDigest,
        egress: 'none' as const,
        generationDigest: projection.corpus.generationDigest,
        materialization: published.materialization,
        pageCount: projection.corpus.pages.length,
        projectId: input.projectId,
        projectionDigest: projection.projectionDigest,
        providerUsed: 'none' as const,
        schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
      });
    },
  };
  return Object.freeze(service);
}
