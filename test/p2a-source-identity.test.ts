import { describe, expect, it } from 'vitest';

import { validateP2aSourceIdentity } from '../src/projector/source-identity.js';

const repository = 'https://example.test/alpha.git';

function planningSource(path: string, kind = 'product-spec'): string {
  return [
    'buildlore+p2a:',
    encodeURIComponent(repository),
    'alpha',
    'v1-security',
    kind,
    encodeURIComponent(path),
  ].join('/');
}

function executionSource(taskId: string, contract: string): string {
  return [
    'buildlore+p2a:',
    encodeURIComponent(repository),
    'alpha',
    'v1-security',
    'execution-task',
    encodeURIComponent('iterations/v1-security/gate-c-task-graph/task-graph.json'),
    taskId,
    contract,
  ].join('/');
}

describe('P2A source identity binding', () => {
  it('accepts only the canonical planning artifact for the selected document kind', () => {
    const canonicalPath = 'iterations/v1-security/gate-b-spec/spec.json';
    const canonical = planningSource(canonicalPath);
    expect(validateP2aSourceIdentity({
      artifactPath: canonicalPath,
      documentKind: 'product-spec',
      projectId: 'alpha',
      repository,
      source: canonical,
      sourceKind: 'planning',
    })).not.toBeNull();
    expect(validateP2aSourceIdentity({
      artifactPath: canonicalPath,
      documentKind: 'product-spec',
      projectId: 'alpha',
      repository,
      source: planningSource('iterations/v1-security/gate-a-intake/intake.json'),
      sourceKind: 'planning',
    })).toBeNull();
  });

  it('binds execution identity to the canonical graph, task, and contract', () => {
    const graph = 'iterations/v1-security/gate-c-task-graph/task-graph.json';
    const contract = 'a'.repeat(64);
    const canonical = executionSource('task-001', contract);
    expect(validateP2aSourceIdentity({
      artifactPath: graph,
      iterationId: 'v1-security',
      projectId: 'alpha',
      repository,
      source: canonical,
      sourceKind: 'execution',
      taskContractSha256: contract,
      taskId: 'task-001',
    })).not.toBeNull();
    expect(validateP2aSourceIdentity({
      artifactPath: graph,
      iterationId: 'v1-security',
      projectId: 'alpha',
      repository,
      source: executionSource('task-001', 'b'.repeat(64)),
      sourceKind: 'execution',
      taskContractSha256: contract,
      taskId: 'task-001',
    })).toBeNull();
  });
});
