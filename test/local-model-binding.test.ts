import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  bindLocalModel,
  createEmbeddingIdentityV2,
  ensureLocalModelsIgnored,
  inspectLocalModelBinding,
  MULTILINGUAL_E5_SMALL_PROFILE,
  verifyLocalModelBinding,
  type EmbeddingArtifactIdentityV2,
  type EmbeddingIdentityV2,
} from '../src/retrieval/embedding/index.js';
import {
  resolveVerifiedLocalModelBinding,
  verifyAuxiliaryArtifactContractsForTest,
  verifyLocalModelBindingForTest,
} from '../src/retrieval/embedding/model-binding.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const profileId = 'multilingual-e5-small';

async function fixture(): Promise<Readonly<{ hubRoot: string; root: string }>> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-model-binding-'));
  roots.push(root);
  const hubRoot = join(root, 'hub');
  await mkdir(hubRoot);
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: hubRoot });
  return { hubRoot, root };
}

function verifiedIdentity(): EmbeddingIdentityV2 {
  const dynamic = `sha256:${'1'.repeat(64)}` as const;
  const artifacts: EmbeddingArtifactIdentityV2[] = [
    { basename: 'config.json', bytes: 512, role: 'model-config', sha256: dynamic },
    {
      basename: 'onnx/model.onnx',
      bytes: 1024,
      role: 'model',
      sha256: 'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
    },
    {
      basename: 'tokenizer.json',
      bytes: 1024,
      role: 'tokenizer',
      sha256: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    },
    { basename: 'tokenizer_config.json', bytes: 256, role: 'tokenizer-config', sha256: dynamic },
  ];
  return createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, artifacts);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('local model binding', () => {
  it('accepts the pinned ONNX auxiliary contract and rejects architecture drift', () => {
    const tokenizer = {
      model_max_length: 512,
      tokenizer_class: 'XLMRobertaTokenizer',
    };
    const config = {
      hidden_size: 384,
      max_position_embeddings: 512,
      model_type: 'bert',
      tokenizer_class: 'XLMRobertaTokenizer',
    };

    expect(() => verifyAuxiliaryArtifactContractsForTest(config, tokenizer)).not.toThrow();
    expect(() => verifyAuxiliaryArtifactContractsForTest({
      ...config,
      model_type: 'xlm-roberta',
    }, tokenizer)).toThrowError(expect.objectContaining({
      code: 'LOCAL_EMBEDDING_INCOMPATIBLE',
      reasonCode: 'artifact-config-incompatible',
    }));
  });

  it('binds the default hub-local directory and emits path-free repeat-safe views', async () => {
    const { hubRoot } = await fixture();
    await ensureLocalModelsIgnored(hubRoot);
    const directory = join(hubRoot, '.buildlore/models', profileId);
    await mkdir(directory, { recursive: true });

    await expect(bindLocalModel(hubRoot, { profileId })).resolves.toEqual({
      outcome: 'created',
      profileId,
      state: 'unavailable',
    });
    const identity = verifiedIdentity();
    await expect(verifyLocalModelBindingForTest(hubRoot, profileId, {
      verifyArtifacts: () => Promise.resolve(identity),
    })).resolves.toMatchObject({ activeIdentity: identity, state: 'ready' });
    const before = await readFile(join(hubRoot, '.buildlore/model-bindings.json'), 'utf8');
    await expect(bindLocalModel(hubRoot, { profileId })).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    await expect(readFile(join(hubRoot, '.buildlore/model-bindings.json'), 'utf8'))
      .resolves.toBe(before);
    const view = await inspectLocalModelBinding(hubRoot, profileId);
    expect(view).toMatchObject({ activeIdentity: identity, reasonCode: null, state: 'ready' });
    expect(JSON.stringify(view)).not.toContain(hubRoot);

    const registry = JSON.parse(before) as unknown;
    expect(before).toBe(serializeCanonicalJson(registry));
    if (process.platform !== 'win32') {
      expect((await stat(join(hubRoot, '.buildlore'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(hubRoot, '.buildlore/model-bindings.json'))).mode & 0o777)
        .toBe(0o600);
    }
    const excludes = await readFile(join(hubRoot, '.git/info/exclude'), 'utf8');
    expect(excludes).toContain('/.buildlore/models/');
    expect(excludes).toContain('/.buildlore/model-bindings.json');
  });

  it('binds an external directory read-only and never serializes it in public data', async () => {
    const { hubRoot, root } = await fixture();
    const external = join(root, 'user-model');
    await mkdir(external);
    const result = await bindLocalModel(hubRoot, { directory: external, profileId });
    expect(JSON.stringify(result)).not.toContain(external);
    const view = await inspectLocalModelBinding(hubRoot, profileId);
    expect(view).toMatchObject({ reasonCode: 'binding-stale', state: 'unavailable' });
    expect(JSON.stringify(view)).not.toContain(external);
    expect(await readdir(external)).toEqual([]);
  });

  it('[HSW-SC-35] rebinds the same artifact identity in a second hub without copying it',
    async () => {
      const first = await fixture();
      const second = await fixture();
      const external = join(first.root, 'user-model-shared');
      await mkdir(external);
      const identity = verifiedIdentity();

      for (const hubRoot of [first.hubRoot, second.hubRoot]) {
        await bindLocalModel(hubRoot, { directory: external, profileId });
        await expect(verifyLocalModelBindingForTest(hubRoot, profileId, {
          verifyArtifacts: () => Promise.resolve(identity),
        })).resolves.toMatchObject({ activeIdentity: identity, state: 'ready' });
      }

      expect(await inspectLocalModelBinding(first.hubRoot, profileId)).toEqual(
        await inspectLocalModelBinding(second.hubRoot, profileId),
      );
      expect(await readdir(external)).toEqual([]);
      expect(JSON.stringify(await inspectLocalModelBinding(second.hubRoot, profileId)))
        .not.toContain(external);
    });

  it('rejects missing artifacts and unsafe directory links without leaking paths', async () => {
    const { hubRoot, root } = await fixture();
    const external = join(root, 'empty-model');
    await mkdir(external);
    await bindLocalModel(hubRoot, { directory: external, profileId });
    await expect(verifyLocalModelBinding(hubRoot, profileId)).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_UNAVAILABLE',
      reasonCode: 'artifact-missing',
    });
    try {
      await verifyLocalModelBinding(hubRoot, profileId);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(external);
    }

    const target = join(root, 'target');
    const linked = join(root, 'linked-model');
    await mkdir(target);
    await symlink(target, linked);
    await expect(bindLocalModel(hubRoot, { directory: linked, profileId })).rejects.toMatchObject({
      reasonCode: 'model-directory-unavailable',
    });
  });

  it('fails closed on a busy lock and preserves the prior canonical registry on write faults', async () => {
    const { hubRoot, root } = await fixture();
    const first = join(root, 'first-model');
    const second = join(root, 'second-model');
    await Promise.all([mkdir(first), mkdir(second)]);
    await bindLocalModel(hubRoot, { directory: first, profileId });
    const registryPath = join(hubRoot, '.buildlore/model-bindings.json');
    const before = await readFile(registryPath, 'utf8');

    let release: (() => void) | undefined;
    const held = bindLocalModel(hubRoot, { directory: second, profileId }, {
      afterLockOpen: () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
    await expect(bindLocalModel(hubRoot, { directory: second, profileId })).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_BUSY',
    });
    release();
    await held;

    await expect(bindLocalModel(hubRoot, { directory: first, profileId }, {
      beforeRename: () => Promise.reject(new Error('injected')),
    })).rejects.toMatchObject({ code: 'LOCAL_EMBEDDING_WRITE_FAILED' });
    expect(await readFile(registryPath, 'utf8')).not.toBe(before);
    expect(await inspectLocalModelBinding(hubRoot, profileId)).toMatchObject({ state: 'unavailable' });
  });

  it('keeps the resolved absolute path inside an opaque internal handle', async () => {
    const { hubRoot, root } = await fixture();
    const directory = join(root, 'verified-model');
    await mkdir(directory);
    await bindLocalModel(hubRoot, { directory, profileId });
    const identity = verifiedIdentity();
    await verifyLocalModelBindingForTest(hubRoot, profileId, {
      verifyArtifacts: () => Promise.resolve(identity),
    });
    await expect(resolveVerifiedLocalModelBinding(hubRoot, profileId)).rejects.toMatchObject({
      reasonCode: 'artifact-missing',
    });
  });
});
