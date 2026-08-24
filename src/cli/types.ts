export const CLI_ENVELOPE_SCHEMA_VERSION = 'buildlore.cli-envelope.v1' as const;

export type CliCommandId =
  | 'check'
  | 'compile'
  | 'context'
  | 'init'
  | 'knowledge.pin.commit'
  | 'knowledge.pin.plan'
  | 'project.add'
  | 'project.bind'
  | 'project.list'
  | 'project.show'
  | 'publish.commit'
  | 'publish.plan'
  | 'publish.push'
  | 'query'
  | 'search'
  | 'sync';

export type CliEnvelopeCommand = CliCommandId | 'unknown';
export type CliExitCode = 0 | 2 | 3 | 4 | 5 | 6;
export type CliOutputMode = 'human' | 'json';
export type CliOutputStream = 'stderr' | 'stdout';

export type CliOperation =
  | CliCommandId
  | 'knowledge.clone'
  | 'knowledge.init'
  | 'knowledge.status'
  | 'project.validate';

export interface CliDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly recoveryCommand?: readonly string[];
}

export interface CliEnvelopeV1 {
  readonly schemaVersion: typeof CLI_ENVELOPE_SCHEMA_VERSION;
  readonly command: CliEnvelopeCommand;
  readonly ok: boolean;
  readonly projectId: string | null;
  readonly workspacePath: string | null;
  readonly knowledgeRevision: string | null;
  readonly data: unknown;
  readonly partial: boolean;
  readonly warnings: readonly CliDiagnostic[];
  readonly errors: readonly CliDiagnostic[];
}

export interface ParsedCliCommand {
  readonly command: CliCommandId;
  readonly kind: 'command';
  readonly operation: CliOperation;
  readonly options: Readonly<Record<string, boolean | string>>;
  readonly outputMode: CliOutputMode;
  readonly projectId: string | null;
}

export interface ParsedCliHelp {
  readonly kind: 'help';
}

export type ParsedCliInvocation = ParsedCliCommand | ParsedCliHelp;

export interface CliPresentationContext {
  readonly command: CliEnvelopeCommand;
  readonly knowledgeRevision?: string | null;
  readonly partial?: boolean;
  readonly projectId?: string | null;
  readonly workspacePath?: string | null;
}

export interface CliSuccessResult extends CliPresentationContext {
  readonly data: unknown;
  readonly errors?: readonly never[];
  readonly exitCode: 0;
  readonly ok: true;
  readonly warnings?: readonly CliDiagnostic[];
}

export interface CliFailureResult extends CliPresentationContext {
  readonly data?: unknown;
  readonly errors: readonly CliDiagnostic[];
  readonly exitCode: Exclude<CliExitCode, 0>;
  readonly ok: false;
  readonly warnings?: readonly CliDiagnostic[];
}

export type CliResult = CliFailureResult | CliSuccessResult;

export interface RenderedCliResult {
  readonly exitCode: CliExitCode;
  readonly message: string;
  readonly stream: CliOutputStream;
}
