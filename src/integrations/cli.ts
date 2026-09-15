import { fileURLToPath } from 'node:url';
import { configureClient, type ClientOptions } from './service.js';
import { ClientConfigError } from './files.js';
import type { CliIo } from '../cli/run-cli.js';

export async function runClientCommand(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const operation = args[0];
    if (operation !== 'configure' && operation !== 'remove') throw new ClientConfigError('CLI_ARGUMENT_INVALID');
    const values = new Map<string, string | boolean>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i];
      if (!key || values.has(key)) throw new ClientConfigError('CLI_ARGUMENT_INVALID');
      if (key === '--apply' || key === '--json') values.set(key, true);
      else if (key === '--client' || key === '--project-dir' || key === '--expect-plan') {
        const value = args[++i]; if (!value || value.startsWith('--')) throw new ClientConfigError('CLI_ARGUMENT_INVALID'); values.set(key, value);
      } else throw new ClientConfigError('CLI_ARGUMENT_INVALID');
    }
    const client = values.get('--client'), projectDir = values.get('--project-dir'), expectedPlan = values.get('--expect-plan');
    if ((client !== 'codex' && client !== 'claude-code') || typeof projectDir !== 'string' || expectedPlan !== undefined && typeof expectedPlan !== 'string') throw new ClientConfigError('CLI_ARGUMENT_INVALID');
    const options: ClientOptions = { client, projectDir, operation, nodePath: process.execPath, binPath: fileURLToPath(new URL('../cli/bin.js', import.meta.url)),
      apply: values.get('--apply') === true, ...(typeof expectedPlan === 'string' ? { expectedPlan } : {}) };
    const result = await configureClient(options);
    io.stdout(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    const code = error instanceof ClientConfigError ? error.code : 'CLIENT_CONFIG_INVALID';
    io.stdout(JSON.stringify({ ok: false, manualSnippet: error instanceof ClientConfigError ? error.snippet : null, errors: [{ code, message: 'Client settings were not completed. Keep the original file; inspect the configuration and preview again.' }] }) + '\n');
    return 3;
  }
}
