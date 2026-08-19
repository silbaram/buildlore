import { HELP_TEXT } from './help.js';

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export function runCli(args: readonly string[], io: CliIo): number {
  if (args.length === 0 || args.every((argument) => argument === '--help' || argument === '-h')) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  io.stderr('Unsupported command. Run buildlore --help for usage.\n');
  return 2;
}
