import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HierarchicalWikiProposalV1 } from '../src/compiler/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import {
  MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS,
  createApprovedWikiProjectionStore,
  createLocalWikiOperator,
  APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
  type ApprovedWikiAuthorityV1,
  type ApprovedWikiProjectionStorePort,
  type ApprovedWikiRetrievalCorpusV1,
  type ApprovedWikiRetrievalProjectionV1,
  type ModelFreeWikiCurateInputV1,
} from '../src/retrieval/index.js';
import { createModelFreeWikiCurateResult } from '../src/retrieval/hierarchical.js';
import type {
  EmbeddingProviderPort,
  LocalModelBindingPort,
} from '../src/retrieval/embedding/index.js';
import { readSecurityPolicy } from '../src/sanitizer/index.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';

const PROJECT_ID = 'model-free-curate';
const roots: string[] = [];

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function noCallProvider(calls: string[]): EmbeddingProviderPort {
  const unexpected = (method: string): never => {
    calls.push(method);
    throw new Error('model-free curate must not call an embedding provider');
  };
  const unexpectedPromise = (method: string): Promise<never> => {
    calls.push(method);
    return Promise.reject(new Error('model-free curate must not call an embedding provider'));
  };
  return Object.freeze({
    activeIdentity: () => unexpected('activeIdentity'),
    countDocumentTokens: () => unexpectedPromise('countDocumentTokens'),
    embedDocuments: () => unexpectedPromise('embedDocuments'),
    embedQuery: () => unexpectedPromise('embedQuery'),
    inspectCapabilities: () => unexpected('inspectCapabilities'),
    readiness: () => unexpected('readiness'),
  });
}

function noCallLocalModels(calls: string[]): LocalModelBindingPort {
  const unexpected = (method: string): Promise<never> => {
    calls.push(method);
    return Promise.reject(new Error('model-free curate must not inspect a local model'));
  };
  return Object.freeze({
    bind: () => unexpected('bind'),
    inspect: () => unexpected('inspect'),
    verify: () => unexpected('verify'),
  });
}

interface CurateFixture {
  readonly authority: ApprovedWikiAuthorityV1;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly projection: ApprovedWikiRetrievalProjectionV1;
  readonly store: ApprovedWikiProjectionStorePort;
}

async function fixture(): Promise<CurateFixture> {
  const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-model-free-curate-'));
  roots.push(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: PROJECT_ID,
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
  });
  const policy = await readSecurityPolicy(knowledgeRoot, PROJECT_ID);
  const authority = createApprovedAuthorityFixture(PROJECT_ID, policy.digest);
  const store = createApprovedWikiProjectionStore(knowledgeRoot);
  const projection = await store.publish({ authority, projectId: PROJECT_ID });
  return Object.freeze({ authority, hubRoot, knowledgeRoot, projection, store });
}

function rehashProposal(
  proposal: HierarchicalWikiProposalV1,
  changes: Partial<Pick<HierarchicalWikiProposalV1, 'claims' | 'wikilinks'>>,
): HierarchicalWikiProposalV1 {
  const changed = Object.freeze({ ...proposal, ...changes });
  const { proposalDigest, ...basis } = changed;
  void proposalDigest;
  return Object.freeze({ ...basis, proposalDigest: hash(basis) });
}

function rehashCorpus(
  corpus: ApprovedWikiRetrievalCorpusV1,
  proposals: readonly HierarchicalWikiProposalV1[],
  duplicate = false,
): ApprovedWikiRetrievalCorpusV1 {
  const proposalById = new Map(proposals.map((proposal) => [proposal.pageId, proposal]));
  const canonicalContent = corpus.pages[0];
  if (canonicalContent === undefined) throw new Error('curate corpus page is unavailable');
  const pages = Object.freeze(corpus.pages.map((page, index) => Object.freeze({
    ...page,
    ...(duplicate && index === 1
      ? {
          sections: canonicalContent.sections,
          summary: canonicalContent.summary,
          title: canonicalContent.title,
        }
      : {}),
    proposalDigest: proposalById.get(page.pageId)?.proposalDigest ?? page.proposalDigest,
  })));
  const basis = Object.freeze({
    generationDigest: corpus.generationDigest,
    pages,
    projectId: corpus.projectId,
    schemaVersion: corpus.schemaVersion,
  });
  return Object.freeze({ ...basis, corpusDigest: hash(basis) });
}

function curateInput(
  item: CurateFixture,
  proposals: readonly HierarchicalWikiProposalV1[] = item.authority.finalization.proposals,
  duplicate = false,
): ModelFreeWikiCurateInputV1 {
  const corpus = rehashCorpus(item.projection.corpus, proposals, duplicate);
  const projectionBasis = Object.freeze({
    corpus,
    projectId: PROJECT_ID,
    sanitizerPolicyDigest: item.projection.sanitizerPolicyDigest,
    schemaVersion: APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
  });
  return Object.freeze({
    authorityCheck: item.authority.authorityCheck,
    corpus,
    projectionDigest: hash(projectionBasis),
    proposals,
    sanitizerPolicyDigest: item.projection.sanitizerPolicyDigest,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('model-free approved Wiki curate', () => {
  it('[HSW-F-14] returns deterministic path-free suggestions without provider access or mutation',
    async () => {
      const item = await fixture();
      const providerCalls: string[] = [];
      const modelCalls: string[] = [];
      let publishCalls = 0;
      const readOnlyStore = Object.freeze({
        publish: () => {
          publishCalls += 1;
          return Promise.reject(new Error('curate must not publish'));
        },
        read: (projectId: string) => item.store.read(projectId),
        readAuthority: (projectId: string) => item.store.readAuthority(projectId),
        status: (projectId: string) => item.store.status(projectId),
      }) satisfies ApprovedWikiProjectionStorePort;
      const wiki = createLocalWikiOperator({
        corpusStore: readOnlyStore,
        hubRoot: item.hubRoot,
        knowledgeRoot: item.knowledgeRoot,
        localModels: noCallLocalModels(modelCalls),
        provider: noCallProvider(providerCalls),
      });
      const [projectionBefore, authorityBefore] = await Promise.all([
        item.store.read(PROJECT_ID),
        item.store.readAuthority(PROJECT_ID),
      ]);

      const first = await wiki.curate({ projectId: PROJECT_ID });
      const repeated = await wiki.curate({ projectId: PROJECT_ID });

      expect(repeated).toEqual(first);
      expect(first).toMatchObject({
        authorityCheckDigest: item.authority.authorityCheck.checkDigest,
        corpusDigest: item.projection.corpus.corpusDigest,
        egress: 'none',
        generationDigest: item.projection.corpus.generationDigest,
        modelUsed: 'none',
        mutationApplied: false,
        projectId: PROJECT_ID,
        projectionDigest: item.projection.projectionDigest,
        providerUsed: 'none',
        readOnly: true,
        sanitizerPolicyDigest: item.projection.sanitizerPolicyDigest,
        schemaVersion: 'buildlore.model-free-wiki-curate-result.v1',
        suggestionCount: first.suggestions.length,
      });
      expect(first.suggestions.length).toBeGreaterThan(0);
      expect(first.suggestions.every((suggestion) =>
        suggestion.reasonCode === 'weakly-connected-page' &&
        suggestion.automaticMutation === false &&
        /^suggestion-[a-f0-9]{64}$/u.test(suggestion.suggestionId))).toBe(true);
      expect(first.suggestions.every((suggestion) => suggestion.evidenceLocators.every((locator) =>
        locator.pageId.startsWith('page-') && locator.sectionId !== null))).toBe(true);
      const serialized = JSON.stringify(first);
      for (const privateValue of item.authority.finalization.proposals.flatMap((proposal) => [
        proposal.title,
        proposal.summary,
        ...proposal.claims.map((claim) => claim.text),
      ])) expect(serialized).not.toContain(privateValue);
      for (const sourceRef of item.authority.finalization.evidencePacks.flatMap((pack) =>
        pack.units.map((unit) => unit.citation.sourceRef))) {
        expect(serialized).not.toContain(sourceRef);
      }
      expect(providerCalls).toEqual([]);
      expect(modelCalls).toEqual([]);
      expect(publishCalls).toBe(0);
      await expect(item.store.read(PROJECT_ID)).resolves.toEqual(projectionBefore);
      await expect(item.store.readAuthority(PROJECT_ID)).resolves.toEqual(authorityBefore);
    });

  it('detects each deterministic review reason without applying a suggested change', async () => {
    const item = await fixture();
    const firstPageId = item.projection.corpus.pages[0]?.pageId;
    if (firstPageId === undefined) throw new Error('curate fixture page is unavailable');
    const missingPageId = `page-${'0'.repeat(64)}`;
    const proposals = item.authority.finalization.proposals.map((proposal) =>
      proposal.pageId === firstPageId
        ? rehashProposal(proposal, {
            claims: Object.freeze([
              ...proposal.claims,
              Object.freeze({
                citationIds: Object.freeze([]),
                claimId: 'claim-review-required',
                evidenceUnitIds: Object.freeze([]),
                text: 'This text must never be present in the curate result.',
              }),
            ]),
            wikilinks: Object.freeze([...proposal.wikilinks, missingPageId].sort()),
          })
        : proposal);

    const result = createModelFreeWikiCurateResult(curateInput(item, proposals, true), PROJECT_ID);

    expect(new Set(result.suggestions.map((suggestion) => suggestion.reasonCode))).toEqual(new Set([
      'broken-link',
      'possible-duplicate',
      'unsupported-claim',
      'weakly-connected-page',
    ]));
    expect(JSON.stringify(result)).not.toContain('This text must never be present');
    expect(result.suggestions.every((suggestion) => suggestion.automaticMutation === false)).toBe(true);
  });

  it('truncates deterministically at the public suggestion bound', async () => {
    const item = await fixture();
    const first = item.authority.finalization.proposals[0];
    const second = item.authority.finalization.proposals[1];
    if (first === undefined || second === undefined) {
      throw new Error('curate fixture proposals are unavailable');
    }
    const unsupportedClaims = (prefix: string, count: number) => Object.freeze(
      Array.from({ length: count }, (_, index) => Object.freeze({
        citationIds: Object.freeze([]),
        claimId: `claim-${prefix}-${String(index).padStart(3, '0')}`,
        evidenceUnitIds: Object.freeze([]),
        text: 'Private claim body.',
      })),
    );
    const proposals = Object.freeze([
      rehashProposal(first, { claims: unsupportedClaims('first', 256) }),
      rehashProposal(second, { claims: unsupportedClaims('second', 8) }),
    ].sort((left, right) => left.pageId < right.pageId ? -1 : 1));
    const input = curateInput(item, proposals);

    const firstResult = createModelFreeWikiCurateResult(input, PROJECT_ID);
    const repeated = createModelFreeWikiCurateResult(input, PROJECT_ID);

    expect(repeated).toEqual(firstResult);
    expect(firstResult.suggestions).toHaveLength(MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS);
    expect(firstResult.suggestionCount).toBe(MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS);
    expect(firstResult.candidateCount).toBeGreaterThan(MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS);
    expect(firstResult.truncated).toBe(true);
  });

  it('fails closed for invalid, stale, and cross-project authority without leaking values',
    async () => {
      const item = await fixture();
      const wrongProjectId = 'model-free-curate-other';
      await addProject(item.knowledgeRoot, {
        displayName: wrongProjectId,
        projectId: wrongProjectId,
        sourceRepository: `https://example.test/${wrongProjectId}.git`,
      });
      const invalidStore = Object.freeze({
        ...item.store,
        read: () => Promise.resolve({
          ...item.projection,
          projectionDigest: `sha256:${'0'.repeat(64)}` as const,
        }),
      }) satisfies ApprovedWikiProjectionStorePort;
      const crossProjectStore = Object.freeze({
        ...item.store,
        read: () => Promise.resolve(item.projection),
      }) satisfies ApprovedWikiProjectionStorePort;
      const stalePrivateValue = 'API_KEY=stale-private-value-never-render';
      const staleAuthority: ApprovedWikiAuthorityV1 = Object.freeze({
        ...item.authority,
        authorityCheck: Object.freeze({
          ...item.authority.authorityCheck,
          changedSourceIds: Object.freeze([stalePrivateValue]),
          status: 'stale',
        }),
      });
      const staleStore = Object.freeze({
        ...item.store,
        readAuthority: () => Promise.resolve(staleAuthority),
      }) satisfies ApprovedWikiProjectionStorePort;

      await expect(createLocalWikiOperator({
        corpusStore: invalidStore,
        hubRoot: item.hubRoot,
        knowledgeRoot: item.knowledgeRoot,
      }).curate({ projectId: PROJECT_ID })).rejects.toMatchObject({
        code: 'LOCAL_WIKI_PROJECTION_INVALID',
      });
      await expect(createLocalWikiOperator({
        corpusStore: crossProjectStore,
        hubRoot: item.hubRoot,
        knowledgeRoot: item.knowledgeRoot,
      }).curate({ projectId: wrongProjectId })).rejects.toMatchObject({
        code: 'LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH',
      });
      const staleError = await createLocalWikiOperator({
        corpusStore: staleStore,
        hubRoot: item.hubRoot,
        knowledgeRoot: item.knowledgeRoot,
      }).curate({ projectId: PROJECT_ID }).then(() => null, (error: unknown) => error);
      expect(staleError).toMatchObject({ code: 'LOCAL_WIKI_PROJECTION_INVALID' });
      expect(JSON.stringify(staleError)).not.toContain(stalePrivateValue);
    });

  it('fails closed when projection or proposal bytes drift from their canonical digests',
    async () => {
      const item = await fixture();
      const input = curateInput(item);
      expect(() => createModelFreeWikiCurateResult({
        ...input,
        projectionDigest: `sha256:${'0'.repeat(64)}`,
      }, PROJECT_ID)).toThrowError('Hierarchical retrieval contract is invalid.');

      const proposal = input.proposals[0];
      if (proposal === undefined) throw new Error('curate proposal is unavailable');
      const proposals = Object.freeze([
        Object.freeze({ ...proposal, summary: 'digest drift must fail closed' }),
        ...input.proposals.slice(1),
      ]);
      expect(() => createModelFreeWikiCurateResult({ ...input, proposals }, PROJECT_ID))
        .toThrowError('Hierarchical retrieval contract is invalid.');
    });

  it('publishes a closed bounded JSON Schema contract for curate results', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/hierarchical-retrieval.schema.json', import.meta.url),
      'utf8',
    )) as {
      readonly oneOf: readonly { readonly $ref: string }[];
      readonly $defs: Readonly<Record<string, unknown>>;
    };

    expect(schema.oneOf).toContainEqual({ $ref: '#/$defs/curateResult' });
    expect(schema.$defs.curateResult).toMatchObject({
      additionalProperties: false,
      properties: {
        candidateCount: { maximum: 24_576 },
        egress: { const: 'none' },
        mutationApplied: { const: false },
        providerUsed: { const: 'none' },
        readOnly: { const: true },
        suggestionCount: { maximum: 256 },
        suggestions: { maxItems: 256 },
      },
      type: 'object',
      'x-buildlore-readOnly': true,
    });
    expect(schema.$defs.curateSuggestion).toMatchObject({ additionalProperties: false });
    expect(schema.$defs.curateEvidenceLocator).toMatchObject({ additionalProperties: false });
  });
});
