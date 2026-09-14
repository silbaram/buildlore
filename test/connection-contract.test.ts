import { describe, it, expect } from 'vitest';
import { decodeConfig, emptyRegistry, hash, parseConnection, parseRegistry } from '../src/connection/contracts.js';
import { configDirectory } from '../src/connection/io.js';
import { parseCliArguments } from '../src/cli/parser.js';
import { randomBytes } from 'node:crypto';

const connection = { schemaVersion: 'buildlore.connection.v1', knowledgeRepository: '../knowledge.git',
  knowledgeRepositoryDigest: hash('../knowledge.git'), projectId: 'parcel' };
describe('portable read connection contracts', () => {
  it('rejects suspected credentials used as project identifiers before output or persistence', () => {
    const projectId = `sk-${randomBytes(16).toString('hex')}`;
    expect(() => parseConnection({ ...connection, projectId })).toThrow();
    expect(() => parseCliArguments(['connection', 'status', '--project', projectId])).toThrow();
  });
  it('strictly bounds identity, versions, keys, UTF-8 and duplicate JSON keys', () => {
    expect(parseConnection(connection)).toEqual(connection);
    for (const value of [{ ...connection, token: 'untrusted' }, { ...connection, schemaVersion: 'future' },
      { ...connection, projectId: '../other' }, { ...connection, knowledgeRepositoryDigest: hash('other') },
      { ...connection, knowledgeRepository: 'https://user:password@example.invalid/repo.git' },
      { ...connection, knowledgeRepository: '../knowledge.git\n' }]) expect(() => parseConnection(value)).toThrow();
    for (const body of [Buffer.from('{"a":1,"a":2}'), Buffer.from([0xff]), Buffer.alloc(17)]) expect(() => decodeConfig(body, 16)).toThrow();
    expect(parseRegistry(emptyRegistry())).toEqual(emptyRegistry());
    expect(() => parseRegistry({ ...emptyRegistry(), unknown: true })).toThrow();
  });
  it('chooses only absolute PC-local config roots', () => {
    expect(configDirectory({ BUILDLORE_CONFIG_DIR: '/tmp/a', XDG_CONFIG_HOME: '/tmp/b' })).toBe('/tmp/a');
    expect(configDirectory({ XDG_CONFIG_HOME: '/tmp/b' })).toBe('/tmp/b/buildlore');
    expect(() => configDirectory({ BUILDLORE_CONFIG_DIR: './a' })).toThrow();
    expect(() => configDirectory({ XDG_CONFIG_HOME: './a' })).toThrow();
  });
  it('permits connected project omission only for the approved read allowlist', () => {
    expect(parseCliArguments(['wiki', 'list', '--expect-generation', hash('g')], { connected: true })).toMatchObject({ projectId: null });
    expect(parseCliArguments(['wiki', 'read', '--page', 'overview'], { connected: true })).toMatchObject({ projectId: null });
    for (const args of [['sync'], ['wiki', 'packet'], ['compile'], ['index', 'rebuild']]) expect(() => parseCliArguments(args, { connected: true })).toThrow();
    expect(() => parseCliArguments(['wiki', 'list', '--expect-generation', 'bad'], { connected: true })).toThrow();
    expect(parseCliArguments(['setup', '--hub', '/tmp/hub', '--knowledge-repo', '../knowledge.git'])).toMatchObject({ command: 'setup' });
  });
});
