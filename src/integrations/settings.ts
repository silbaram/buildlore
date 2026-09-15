import { parse as parseToml } from 'smol-toml';
import { modify, applyEdits } from 'jsonc-parser';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { containsCredentialMaterial } from '../sanitizer/service.js';
import { reject } from './files.js';

export type ClientKind = 'codex' | 'claude-code';
export interface Launch { command: string; args: string[]; env?: { BUILDLORE_CONFIG_DIR: string } }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject('CLIENT_CONFIG_INVALID');
  return value as Record<string, unknown>;
}
export function jsonDocument(text: string): Record<string, unknown> { return object(parseJsonStrict(text)); }
export function nested(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const o = object(current);
    if (!Object.hasOwn(o, key)) return undefined;
    current = o[key];
  }
  return current;
}
export function launchSnippet(client: ClientKind, name: string, launch: Launch): string {
  if (client === 'claude-code') return JSON.stringify({ type: 'stdio', ...launch });
  const env = launch.env ? `env = { BUILDLORE_CONFIG_DIR = ${JSON.stringify(launch.env.BUILDLORE_CONFIG_DIR)} }\n` : '';
  return `# BEGIN BuildLore ${name}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n${env}# END BuildLore ${name}\n`;
}
export function editSetting(client: ClientKind, text: string, root: string, name: string, previous: string | null, desired: string | null): { text: string; owned: string | null } {
  let ownedLaunch: Record<string, unknown> | undefined;
  if (previous !== null) {
    if (containsCredentialMaterial(previous)) reject();
    let launch: Record<string, unknown>;
    if (client === 'codex') {
      const block = previous.startsWith('\n') ? previous.slice(1) : previous;
      if (!block.startsWith(`# BEGIN BuildLore ${name}\n`) || !block.endsWith(`# END BuildLore ${name}\n`)) reject();
      const parsed = parseToml(block);
      if (Object.keys(parsed).join() !== 'mcp_servers') reject();
      const servers = object(parsed.mcp_servers);
      if (Object.keys(servers).join() !== name) reject();
      launch = object(servers[name]);
    } else launch = jsonDocument(previous);
    const keys = Object.keys(launch).sort().join();
    const expected = client === 'codex' ? ['args,command', 'args,command,env'] : ['args,command,type', 'args,command,env,type'];
    if (!expected.includes(keys)) reject();
    if (launch.env !== undefined) {
      const env = object(launch.env);
      if (Object.keys(env).join() !== 'BUILDLORE_CONFIG_DIR' || typeof env.BUILDLORE_CONFIG_DIR !== 'string' || !isAbsolute(env.BUILDLORE_CONFIG_DIR)) reject();
    }
    if (client === 'claude-code' && launch.type !== 'stdio') reject();
    if (typeof launch.command !== 'string' || !isAbsolute(launch.command) || !Array.isArray(launch.args) || launch.args.length !== 5 ||
      typeof launch.args[0] !== 'string' || !isAbsolute(launch.args[0]) || launch.args[1] !== 'mcp' || launch.args[2] !== '--project-dir' || launch.args[3] !== root || launch.args[4] !== '--read-only') reject();
    ownedLaunch = launch;
  }
  if (client === 'codex') {
    const parsed = parseToml(text);
    if (previous !== null) {
      // Matching bytes alone may locate a marker inside a user's multiline string.
      // The parsed server must still be exactly the entry proven by the receipt.
      if (!isDeepStrictEqual(nested(parsed, ['mcp_servers', name]), ownedLaunch)) reject();
      if (text.split(previous).length !== 2 || !text.includes(previous)) reject();
      const replacement = desired === null ? '' : (previous.startsWith('\n') ? '\n' : '') + desired;
      const next = text.replace(previous, replacement);
      const remaining = text.replace(previous, '');
      const rest = parseToml(remaining);
      if (nested(rest, ['mcp_servers', name]) !== undefined) reject();
      parseToml(next);
      return { text: next, owned: desired === null ? null : replacement };
    }
    if (nested(parsed, ['mcp_servers', name]) !== undefined || text.includes(`# BEGIN BuildLore ${name}`) || text.includes(`# END BuildLore ${name}`)) reject();
    if (desired === null) return { text, owned: null };
    const owned = (text && !text.endsWith('\n') ? '\n' : '') + desired;
    const next = text + owned; parseToml(next); return { text: next, owned };
  }
  const base = text || '{}';
  const parsed = jsonDocument(base), path = ['projects', root, 'mcpServers', name];
  const existing = nested(parsed, path);
  if (previous === null ? existing !== undefined : JSON.stringify(existing) !== previous) reject();
  if (desired === null && previous === null) return { text, owned: null };
  const desiredValue: unknown = desired === null ? undefined : parseJsonStrict(desired);
  // No formatting pass over the user's document: edits touch the selected node and separators only.
  const next = applyEdits(base, modify(base, path, desiredValue, {}));
  jsonDocument(next);
  return { text: next, owned: desired };
}
