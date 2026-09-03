import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  createHierarchicalWikiActivationService,
} from '../src/cli/index.js';
import { addProject } from '../src/knowledge/index.js';
import { createRepositoryWriterLease } from '../src/knowledge/repository-writer-lease.js';
import { readSecurityPolicy } from '../src/sanitizer/index.js';
import {
  createApprovedWikiProjectionStore,
  createLocalWikiOperator,
  LocalWikiRetrievalError,
  type ApprovedWikiAuthorityV1,
} from '../src/retrieval/index.js';
import {
  createEmbeddingIdentityV2,
  MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingIdentityV2,
  type EmbeddingProviderPort,
} from '../src/retrieval/embedding/index.js';
import { createFlatFileVectorIndex } from '../src/retrieval/vector-index/index.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const PROJECT_ID = 'local-wiki-operator';
const roots: string[] = [];
const execFileAsync = promisify(execFile);

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function identity(): EmbeddingIdentityV2 {
  return createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
    { basename: 'config.json', bytes: 655, role: 'model-config', sha256: digest('1') },
    {
      basename: 'onnx/model.onnx',
      bytes: 470_268_510,
      role: 'model',
      sha256: 'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
    },
    {
      basename: 'tokenizer.json',
      bytes: 17_082_730,
      role: 'tokenizer',
      sha256: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    },
    {
      basename: 'tokenizer_config.json',
      bytes: 443,
      role: 'tokenizer-config',
      sha256: digest('2'),
    },
  ]);
}

function vectorFor(text: string): Float32Array {
  const hash = createHash('sha256').update(text).digest();
  const vector = new Float32Array(384);
  for (const [index, byte] of hash.entries()) {
    const component = (byte + index) % vector.length;
    vector[component] = (vector[component] ?? 0) + (byte + 1) / 256;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

function provider(calls: string[]): EmbeddingProviderPort {
  const activeIdentity = identity();
  return Object.freeze({
    activeIdentity: () => activeIdentity,
    countDocumentTokens(texts: readonly string[]) {
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity: activeIdentity,
        maximumTokens: 512 as const,
        providerUsed: 'local-in-process' as const,
        tokenCounts: Object.freeze(texts.map((text) =>
          Math.max(1, Array.from(`passage: ${text}`).length))),
      }));
    },
    embedDocuments(texts: readonly string[]) {
      calls.push('documents');
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity: activeIdentity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze(texts.map(() => false)),
        vectors: Object.freeze(texts.map(vectorFor)),
      }));
    },
    embedQuery(text: string) {
      calls.push('query');
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity: activeIdentity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze([false]),
        vectors: Object.freeze([vectorFor(text)]),
      }));
    },
    inspectCapabilities: () => Object.freeze({
      adapterKind: 'transformers-js' as const,
      device: 'cpu' as const,
      egress: 'none' as const,
      maximumBatchSize: 32 as const,
      maximumQueryUtf8Bytes: 4096 as const,
      networkAllowed: false as const,
      providerUsed: 'local-in-process' as const,
    }),
    readiness: () => Object.freeze({ activeIdentity, state: 'ready' as const }),
  });
}

function approvedWiki(sanitizerPolicyDigest: `sha256:${string}`): ApprovedWikiAuthorityV1 {
  return createApprovedAuthorityFixture(PROJECT_ID, sanitizerPolicyDigest);
}

async function fixture() {
  const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-local-wiki-operator-'));
  roots.push(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: knowledgeRoot });
  await addProject(knowledgeRoot, {
    displayName: PROJECT_ID,
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
  });
  const policy = await readSecurityPolicy(knowledgeRoot, PROJECT_ID);
  return { hubRoot, knowledgeRoot, policy };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('local Wiki operator surface', () => {
  it('activates a quality-approved session bundle without a model or provider', async () => {
    const { hubRoot, knowledgeRoot, policy } = await fixture();
    const inputDirectory = join(hubRoot, '.buildlore');
    await mkdir(inputDirectory);
    const approved = approvedWiki(policy.digest);
    await writeFile(join(inputDirectory, 'approved-wiki.json'), `${JSON.stringify({
      schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      authority: approved,
    })}\n`, 'utf8');

    const activated = await createHierarchicalWikiActivationService({
      hubRoot,
      knowledgeRoot,
      liveSnapshotVerifier: { verify: () => Promise.resolve() },
    }).activate({
      confirmationDigest: approved.humanActivationApproval.approvalDigest,
      projectId: PROJECT_ID,
    });
    expect(activated).toMatchObject({
      egress: 'none',
      pageCount: 2,
      projectId: PROJECT_ID,
      providerUsed: 'none',
    });
    await expect(createApprovedWikiProjectionStore(knowledgeRoot).status(PROJECT_ID))
      .resolves.toMatchObject({ state: 'ready' });

    await writeFile(join(inputDirectory, 'approved-wiki.json'), `${JSON.stringify({
      schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      authority: { ...approved, ledger: null },
    })}\n`, 'utf8');
    let invalidBundleLiveVerificationCount = 0;
    await expect(createHierarchicalWikiActivationService({
      hubRoot,
      knowledgeRoot,
      liveSnapshotVerifier: {
        verify() {
          invalidBundleLiveVerificationCount += 1;
          return Promise.resolve();
        },
      },
    })
      .activate({
        confirmationDigest: approved.humanActivationApproval.approvalDigest,
        projectId: PROJECT_ID,
      })).rejects.toMatchObject({
        code: 'APPROVED_WIKI_PROJECTION_INVALID',
      });
    expect(invalidBundleLiveVerificationCount).toBe(0);
  });

  it('fails closed before persistence when the live source binding cannot prove the snapshot', async () => {
    const { hubRoot, knowledgeRoot, policy } = await fixture();
    const inputDirectory = join(hubRoot, '.buildlore');
    await mkdir(inputDirectory);
    await writeFile(join(inputDirectory, 'approved-wiki.json'), `${JSON.stringify({
      authority: approvedWiki(policy.digest),
      projectId: PROJECT_ID,
      schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
    })}\n`, 'utf8');

    await expect(createHierarchicalWikiActivationService({ hubRoot, knowledgeRoot })
      .activate({
        confirmationDigest: approvedWiki(policy.digest).humanActivationApproval.approvalDigest,
        projectId: PROJECT_ID,
      })).rejects.toMatchObject({
        code: 'HIERARCHICAL_WIKI_ACTIVATION_SOURCE_DRIFT',
      });
    await expect(createApprovedWikiProjectionStore(knowledgeRoot).status(PROJECT_ID))
      .resolves.toEqual({ projectId: PROJECT_ID, state: 'none' });
  });

  it('rejects a claim-text-only secret before live reads or persistence',
    async () => {
      const { hubRoot, knowledgeRoot, policy } = await fixture();
      const inputDirectory = join(hubRoot, '.buildlore');
      await mkdir(inputDirectory);
      const claimOnlySecret = 'API_KEY=claimonlysecret12345';
      const authority = JSON.parse(JSON.stringify(approvedWiki(policy.digest))) as
        ApprovedWikiAuthorityV1;
      const firstProposal = authority.finalization.proposals[0];
      const firstClaim = firstProposal?.claims[0];
      if (firstProposal === undefined || firstClaim === undefined) {
        throw new Error('hierarchical authority claim is unavailable');
      }
      (firstClaim as { text: string }).text = claimOnlySecret;
      await writeFile(join(inputDirectory, 'approved-wiki.json'), `${JSON.stringify({
        authority,
        projectId: PROJECT_ID,
        schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
      })}\n`, 'utf8');
      const service = createHierarchicalWikiActivationService({
        hubRoot,
        knowledgeRoot,
        liveSnapshotVerifier: {
          verify() {
            throw new Error('live verification must not run for an invalid claim');
          },
        },
      });

      const error = await service.activate({
        confirmationDigest: authority.humanActivationApproval.approvalDigest,
        projectId: PROJECT_ID,
      }).then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });
      expect(JSON.stringify(error)).not.toContain(claimOnlySecret);
      await expect(createApprovedWikiProjectionStore(knowledgeRoot).status(PROJECT_ID))
        .resolves.toEqual({ projectId: PROJECT_ID, state: 'none' });
    });

  it('rejects missing or mismatched approval confirmation before live verification or publish', async () => {
    const { hubRoot, knowledgeRoot, policy } = await fixture();
    const inputDirectory = join(hubRoot, '.buildlore');
    await mkdir(inputDirectory);
    const authority = approvedWiki(policy.digest);
    await writeFile(join(inputDirectory, 'approved-wiki.json'), `${JSON.stringify({
      authority,
      projectId: PROJECT_ID,
      schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
    })}\n`, 'utf8');
    const store = createApprovedWikiProjectionStore(knowledgeRoot);
    const previousProjection = await store.publish({ authority, projectId: PROJECT_ID });
    let liveVerificationCount = 0;
    const service = createHierarchicalWikiActivationService({
      hubRoot,
      knowledgeRoot,
      liveSnapshotVerifier: {
        verify() {
          liveVerificationCount += 1;
          return Promise.resolve();
        },
      },
    });

    await expect(service.activate({
      confirmationDigest: digest('f'),
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({
      code: 'HIERARCHICAL_WIKI_ACTIVATION_APPROVAL_MISMATCH',
    });
    await expect(service.activate({ projectId: PROJECT_ID })).rejects.toMatchObject({
      code: 'HIERARCHICAL_WIKI_ACTIVATION_APPROVAL_MISMATCH',
    });
    expect(liveVerificationCount).toBe(0);
    await expect(store.read(PROJECT_ID)).resolves.toEqual(previousProjection);
  });

  it('persists only a validated approved projection and detects tampering', async () => {
    const { knowledgeRoot, policy } = await fixture();
    const store = createApprovedWikiProjectionStore(knowledgeRoot);
    const authority = approvedWiki(policy.digest);
    await expect(store.publish({
      authority: { ...authority, unexpected: true } as unknown as ApprovedWikiAuthorityV1,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });
    await expect(store.status(PROJECT_ID)).resolves.toEqual({
      projectId: PROJECT_ID,
      state: 'none',
    });
    const projection = await store.publish({
      authority,
      projectId: PROJECT_ID,
    });

    await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);
    await expect(store.status(PROJECT_ID)).resolves.toMatchObject({
      pageCount: 2,
      projectId: PROJECT_ID,
      state: 'ready',
    });

    await expect(store.publish({ authority, projectId: PROJECT_ID })).rejects.toMatchObject({
      code: 'APPROVED_WIKI_PROJECTION_INVALID',
    });
    await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);

    await expect(store.publish({
      authority: {
        ...authority,
        humanActivationApproval: {
          ...authority.humanActivationApproval,
          approvalDigest: digest('0'),
        },
      },
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });
    await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);

    const path = join(
      knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.llmwiki',
      'buildlore-hierarchy',
      'approved-authority.json',
    );
    const tampered = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    tampered.authorityDigest = digest('0');
    await writeFile(path, `${JSON.stringify(tampered)}\n`, 'utf8');
    await expect(store.read(PROJECT_ID)).rejects.toMatchObject({
      code: 'APPROVED_WIKI_PROJECTION_INVALID',
    });
  });

  it('preserves the approved authority while another publisher owns the store lock', async () => {
    const { knowledgeRoot, policy } = await fixture();
    const store = createApprovedWikiProjectionStore(knowledgeRoot);
    const authority = approvedWiki(policy.digest);
    const projection = await store.publish({ authority, projectId: PROJECT_ID });
    const lockPath = join(
      knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.llmwiki',
      'buildlore-hierarchy',
      'approved-authority.json.lock',
    );
    await writeFile(lockPath, 'another publisher\n', 'utf8');
    try {
      await expect(store.publish({ authority, projectId: PROJECT_ID })).rejects.toMatchObject({
        code: 'APPROVED_WIKI_PROJECTION_WRITE_FAILED',
      });
    } finally {
      await rm(lockPath, { force: true });
    }
    await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);
  });

  it('snapshots caller authority before awaiting filesystem work', async () => {
    const { knowledgeRoot, policy } = await fixture();
    const store = createApprovedWikiProjectionStore(knowledgeRoot);
    const authority = approvedWiki(policy.digest);
    const mutable = JSON.parse(JSON.stringify(authority)) as ApprovedWikiAuthorityV1;
    const publication = store.publish({ authority: mutable, projectId: PROJECT_ID });
    (mutable.ledger as { ledgerDigest: `sha256:${string}` }).ledgerDigest = digest('0');

    const projection = await publication;
    await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);
    await expect(store.readAuthority(PROJECT_ID)).resolves.toEqual(authority);
  });

  it('rejects a swapped store directory without touching an external lock or prior authority',
    async () => {
      const { hubRoot, knowledgeRoot, policy } = await fixture();
      const authority = approvedWiki(policy.digest);
      const store = createApprovedWikiProjectionStore(knowledgeRoot);
      const projection = await store.publish({ authority, projectId: PROJECT_ID });
      const storeRoot = join(
        knowledgeRoot,
        'projects',
        PROJECT_ID,
        '.llmwiki',
        'buildlore-hierarchy',
      );
      const preservedStoreRoot = `${storeRoot}.preserved`;
      const externalRoot = join(hubRoot, 'external-lock-target');
      const externalLock = join(externalRoot, 'approved-authority.json.lock');
      await mkdir(externalRoot);
      let commitCalls = 0;
      const faulted = createApprovedWikiProjectionStore(knowledgeRoot, {
        async beforeLockOpen() {
          await rename(storeRoot, preservedStoreRoot);
          await symlink(externalRoot, storeRoot, 'dir');
        },
        beforeCommit() {
          commitCalls += 1;
        },
      });
      try {
        await expect(faulted.publish({ authority, projectId: PROJECT_ID }))
          .rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_WRITE_FAILED' });
        expect(commitCalls).toBe(0);
        await expect(readFile(externalLock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(storeRoot, { force: true });
        await rename(preservedStoreRoot, storeRoot);
      }
      await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);
    });

  it('reports a durable commit as successful when lock cleanup loses ownership', async () => {
    const { knowledgeRoot, policy } = await fixture();
    const authority = approvedWiki(policy.digest);
    const storeRoot = join(
      knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.llmwiki',
      'buildlore-hierarchy',
    );
    const lockPath = join(storeRoot, 'approved-authority.json.lock');
    const ownedLockPath = join(storeRoot, 'approved-authority.json.lock.committed');
    const replacementBody = 'replacement publisher lock\n';
    const store = createApprovedWikiProjectionStore(knowledgeRoot, {
      async beforeLockRelease() {
        await rename(lockPath, ownedLockPath);
        await writeFile(lockPath, replacementBody, 'utf8');
      },
    });

    const projection = await store.publish({ authority, projectId: PROJECT_ID });
    await expect(store.read(PROJECT_ID)).resolves.toEqual(projection);
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacementBody);
    await rm(lockPath, { force: true });
    await rm(ownedLockPath, { force: true });
  });

  it('serves graph fallback, explicit rebuild, semantic search, and offline regeneration', async () => {
    const { hubRoot, knowledgeRoot, policy } = await fixture();
    const store = createApprovedWikiProjectionStore(knowledgeRoot);
    const authority = approvedWiki(policy.digest);
    await store.publish({
      authority,
      projectId: PROJECT_ID,
    });
    const calls: string[] = [];
    const operator = createLocalWikiOperator({
      embeddingIdentity: identity(),
      hubRoot,
      knowledgeRoot,
      provider: provider(calls),
      repositoryLease: createRepositoryWriterLease(),
    });

    await expect(operator.indexStatus(PROJECT_ID)).resolves.toMatchObject({
      reasonCode: 'semantic-index-unavailable',
      recoveryAction: ['index', 'rebuild', '--project', PROJECT_ID],
      semanticUsable: false,
    });

    await expect(operator.search({
      mode: 'hybrid',
      projectId: PROJECT_ID,
      query: 'local search',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical-graph',
      fallback: { reasonCode: 'semantic-index-unavailable' },
      providerUsed: 'none',
    });
    expect(calls).toEqual([]);
    await expect(operator.search({
      mode: 'semantic',
      projectId: PROJECT_ID,
      query: 'local search',
    })).rejects.toBeInstanceOf(LocalWikiRetrievalError);

    const built = await operator.rebuildIndex({ projectId: PROJECT_ID });
    expect(built).toMatchObject({
      requestedMode: 'incremental',
      result: { ledger: { effectiveMode: 'full', egress: 'none' }, outcome: 'activated' },
    });
    expect(calls).toEqual(['documents']);
    await expect(operator.indexStatus(PROJECT_ID)).resolves.toMatchObject({
      reasonCode: null,
      recoveryAction: null,
      semanticUsable: true,
    });
    const before = await operator.search({
      mode: 'semantic',
      projectId: PROJECT_ID,
      query: 'An explicit index rebuild prepares local semantic search.',
    });
    expect(before).toMatchObject({
      effectiveMode: 'semantic',
      providerUsed: 'local-in-process',
    });
    expect(before.hits[0]).toMatchObject({
      locator: {
        pageId: authority.state.activePages[0]?.pageId,
        sectionId: authority.finalization.proposals[0]?.sections[0]?.sectionId,
      },
    });

    await rm(join(
      knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
    ), { force: true, recursive: true });
    const rebuilt = await operator.rebuildIndex({ full: true, projectId: PROJECT_ID });
    expect(rebuilt.result.ledger.effectiveMode).toBe('full');
    const after = await operator.search({
      mode: 'semantic',
      projectId: PROJECT_ID,
      query: 'An explicit index rebuild prepares local semantic search.',
    });
    expect(after.hits).toEqual(before.hits);
  });

  it('rejects final semantic selection when policy drifts during provider batching', async () => {
    const { hubRoot, knowledgeRoot, policy } = await fixture();
    const store = createApprovedWikiProjectionStore(knowledgeRoot);
    await store.publish({
      authority: approvedWiki(policy.digest),
      projectId: PROJECT_ID,
    });
    const calls: string[] = [];
    const base = provider(calls);
    let driftDuringEmbedding = false;
    const driftingProvider: EmbeddingProviderPort = Object.freeze({
      ...base,
      async embedDocuments(texts: readonly string[]) {
        const result = await base.embedDocuments(texts);
        if (driftDuringEmbedding) {
          await writeSecurityPolicy(knowledgeRoot, PROJECT_ID, {
            capabilities: ['compile'],
            classification: 'internal',
          });
        }
        return result;
      },
    });
    const vectorIndex = createFlatFileVectorIndex(knowledgeRoot);
    const operator = createLocalWikiOperator({
      embeddingIdentity: identity(),
      hubRoot,
      knowledgeRoot,
      provider: driftingProvider,
      repositoryLease: createRepositoryWriterLease(),
      vectorIndex,
    });
    const healthy = await operator.rebuildIndex({ full: true, projectId: PROJECT_ID });
    driftDuringEmbedding = true;
    await expect(operator.rebuildIndex({ full: true, projectId: PROJECT_ID }))
      .rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_INCOMPATIBLE',
        reasonCode: 'lineage-drift',
      });
    await expect(vectorIndex.openActive(PROJECT_ID)).resolves.toMatchObject({
      manifest: { manifestDigest: healthy.result.manifest.manifestDigest },
    });
  });
});
