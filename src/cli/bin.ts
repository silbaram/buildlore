#!/usr/bin/env node

import { runCli, type CliIo } from './run-cli.js';

const io: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

if (process.argv[2] === 'mcp') {
  const { runMcp } = await import('../mcp/run.js');
  const code = await runMcp(process.argv.slice(3), process.stdin, process.stdout, message => io.stderr(message));
  process.exit(code);
} else if (process.argv[2] === 'client') {
  const { runClientCommand } = await import('../integrations/cli.js');
  process.exitCode = await runClientCommand(process.argv.slice(3), io);
} else {
  process.exitCode = await runCli(process.argv.slice(2), io);
}
