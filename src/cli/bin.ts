#!/usr/bin/env node

import { runCli, type CliIo } from './run-cli.js';

const io: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

process.exitCode = await runCli(process.argv.slice(2), io);
