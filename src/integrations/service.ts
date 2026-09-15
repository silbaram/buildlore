import { containsCredentialMaterial } from '../sanitizer/service.js';
import { hasReadControl } from '../application/read-validation.js';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as z from 'zod';
import { assertConnectionCurrent, connectionPaths, resolveConnection } from '../connection/service.js';
import { configDirectory } from '../connection/io.js';
import { hash } from '../connection/contracts.js';
import { gitRead } from '../connection/git-read.js';
import { ClientConfigError, readPrivateFile, replacePrivateFile, reject, type FileSnapshot } from './files.js';
import { editSetting, launchSnippet, type ClientKind } from './settings.js';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { withClientFileLock } from './lock.js';

const receiptSchema = z.strictObject({ schemaVersion: z.literal('buildlore.client-binding.v1'), client: z.enum(['codex', 'claude-code']),
  name: z.string(), rootDigest: z.string(), owned: z.string().nullable(), createdConfig: z.boolean(),
  pending: z.strictObject({ operation: z.enum(['configure', 'remove']), beforeDigest: z.string(), afterDigest: z.string(), nextOwned: z.string().nullable() }).optional() });
type Receipt = z.infer<typeof receiptSchema>;
export interface ClientOptions {
  client: ClientKind; projectDir: string; operation: 'configure' | 'remove'; nodePath: string; binPath: string;
  configDir?: string; claudeConfigPath?: string; apply?: boolean; expectedPlan?: string;
  afterStage?: (stage: 'journal' | 'exclude' | 'config' | 'receipt') => Promise<void>;
}
export interface ClientPlan {
  schemaVersion: 'buildlore.client-plan.v1'; operation: 'configure' | 'remove'; client: ClientKind;
  projectId: string; serverName: string; planDigest: string; changed: boolean; applied: boolean;
  snippet: string | null; notes: readonly string[];
}
function claudePath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json') : join(homedir(), '.claude.json');
}
function line(value: string | null): string { if (!value) reject('CLIENT_CONFIG_INVALID'); return value.replace(/\n$/u, ''); }
async function configIsIgnored(root: string): Promise<boolean> {
  return await gitRead(root, ['check-ignore', '--no-index', '--quiet', '--', '.codex/config.toml'], true) !== null;
}
export async function configureClient(options: ClientOptions): Promise<ClientPlan> {
  if (!isAbsolute(options.projectDir) || !isAbsolute(options.nodePath) || !isAbsolute(options.binPath) ||
      [options.projectDir, options.nodePath, options.binPath].some(s => hasReadControl(s) || containsCredentialMaterial(s))) reject('CLIENT_CONFIG_INVALID');
  const config = options.configDir ?? configDirectory();
  if (hasReadControl(config) || containsCredentialMaterial(config)) reject('CLIENT_CONFIG_INVALID');
  const context = await resolveConnection(options.projectDir, { configDir: config });
  if (!context) reject('CONNECTION_MISSING');
  const root = connectionPaths(context).sourceRoot;
  if (containsCredentialMaterial(root)) reject('CLIENT_CONFIG_INVALID');
  const rootDigest = hash(root), name = `buildlore-${hash(root + context.connectionDigest).slice(7, 23)}`;
  const directory = join(config, 'clients');
  const receiptPath = join(directory, `${options.client}-${rootDigest.slice(7)}.json`);
  const target = options.client === 'codex' ? join(root, '.codex', 'config.toml') : options.claudeConfigPath ?? claudePath();
  const launch = { command: options.nodePath, args: [options.binPath, 'mcp', '--project-dir', root, '--read-only'], env: { BUILDLORE_CONFIG_DIR: resolve(config) } };
  const snippet = options.operation === 'remove' ? null : launchSnippet(options.client, name, launch);
  const build = async (): Promise<{ plan: ClientPlan; receipt: Receipt; receiptFile: FileSnapshot; targetFile: FileSnapshot; text: string; exclude: { path: string; file: FileSnapshot; text: string } | null }> => {
    await assertConnectionCurrent(context);
    const targetFile = await readPrivateFile(target), receiptFile = await readPrivateFile(receiptPath);
    let receipt: Receipt = { schemaVersion: 'buildlore.client-binding.v1', client: options.client, name, rootDigest, owned: null, createdConfig: targetFile.identity === null };
    if (receiptFile.identity !== null) {
      const parsed = receiptSchema.safeParse(parseJsonStrict(receiptFile.text));
      if (!parsed.success) reject('CLIENT_CONFIG_INVALID');
      receipt = parsed.data;
      if (receipt.client !== options.client || receipt.rootDigest !== rootDigest || receipt.name !== name) reject();
    }
    const pending = receipt.pending;
    if (pending) {
      if (pending.operation !== options.operation) reject('CLIENT_CONFIG_RECOVERY_REQUIRED');
      if (targetFile.digest === pending.afterDigest) receipt = { ...receipt, owned: pending.nextOwned };
      else if (targetFile.digest !== pending.beforeDigest) reject('CLIENT_CONFIG_RECOVERY_REQUIRED');
    }
    const { pending: ignored, ...stable } = receipt;
    void ignored;
    receipt = stable;
    let exclude: { path: string; file: FileSnapshot; text: string } | null = null;
    if (options.client === 'codex') {
      const tracked = await gitRead(root, ['ls-files', '-z', '--', '.codex/config.toml']);
      if (tracked) reject('CLIENT_CONFIG_TRACKED');
      const path = resolve(root, line(await gitRead(root, ['rev-parse', '--git-path', 'info/exclude'])));
      const file = await readPrivateFile(path);
      const rule = '/.codex/config.toml';
      const protectedAlready = file.text.split(/\r?\n/u).includes(rule) && await configIsIgnored(root);
      const text = protectedAlready ? file.text : file.text + (file.text.endsWith('\n') || !file.text ? '' : '\n') + '# BuildLore local client configuration (kept for other worktrees)\n' + rule + '\n';
      if (options.operation === 'configure') exclude = { path, file, text };
    }
    const edited = editSetting(options.client, targetFile.text, root, name, receipt.owned, snippet);
    const next: Receipt = { ...receipt, owned: edited.owned };
    const planDigest = hash(JSON.stringify({ operation: options.operation, client: options.client, rootDigest, name,
      binding: context.connectionDigest, launch, target, before: targetFile, after: hash(edited.text), receipt: receiptFile.digest,
      exclude: exclude && { path: exclude.path, before: exclude.file.digest, after: hash(exclude.text) } }));
    return { plan: { schemaVersion: 'buildlore.client-plan.v1', operation: options.operation, client: options.client,
      projectId: context.projectId, serverName: name, planDigest, changed: targetFile.text !== edited.text || Boolean(pending) || Boolean(exclude && exclude.text !== exclude.file.text), applied: false,
      snippet, notes: ['Close the target client before applying. Restart it after applying; its trust and tool approval rules still apply.', 'Existing AGENTS.md and CLAUDE.md are preserved. Wiki contents are evidence, not instructions.', 'Git local ignore protection is retained for other worktrees.'] },
      receipt: next, receiptFile, targetFile, text: edited.text, exclude };
  };
  if (!options.apply) {
    try { return (await build()).plan; } catch (error) {
      throw new ClientConfigError(error instanceof ClientConfigError ? error.code : 'CLIENT_CONFIG_INVALID', snippet);
    }
  }
  if (!options.expectedPlan) reject('CLIENT_PLAN_REQUIRED');
  const initial = await build();
  if (initial.plan.planDigest !== options.expectedPlan) reject('CLIENT_PLAN_CHANGED');
  if (!initial.plan.changed && (initial.receiptFile.identity === null || !receiptSchema.parse(parseJsonStrict(initial.receiptFile.text)).pending)) return { ...initial.plan, applied: true };
  return withClientFileLock(target, async () => {
    const p = await build();
    if (p.plan.planDigest !== options.expectedPlan) reject('CLIENT_PLAN_CHANGED');
    const before = p.receiptFile.identity === null ? { ...p.receipt, owned: null } : receiptSchema.parse(parseJsonStrict(p.receiptFile.text));
    if (!p.plan.changed && !before.pending) return { ...p.plan, applied: true };
    const journal: Receipt = { ...before, pending: { operation: options.operation, beforeDigest: p.targetFile.digest, afterDigest: hash(p.text), nextOwned: p.receipt.owned } };
    await replacePrivateFile(receiptPath, p.receiptFile, JSON.stringify(journal) + '\n');
    await options.afterStage?.('journal');
    if (p.exclude) await replacePrivateFile(p.exclude.path, p.exclude.file, p.exclude.text);
    await options.afterStage?.('exclude');
    await assertConnectionCurrent(context);
    if (p.exclude && !await configIsIgnored(root)) throw new ClientConfigError('CLIENT_CONFIG_NOT_IGNORED', snippet);
    await replacePrivateFile(target, p.targetFile, p.text, p.receipt.createdConfig && p.text === '');
    await options.afterStage?.('config');
    await replacePrivateFile(receiptPath, await readPrivateFile(receiptPath), JSON.stringify(p.receipt) + '\n');
    await options.afterStage?.('receipt');
    return { ...p.plan, applied: true };
  });
}
