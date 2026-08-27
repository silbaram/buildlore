import { CompilerOperationError } from '../compiler/errors.js';
import { SessionCompileError } from '../compiler/session/errors.js';
import { ProjectCheckError } from '../compiler/check.js';
import { ProjectCorpusError } from '../compiler/corpus.js';
import { KnowledgeError, type KnowledgeErrorCode } from '../knowledge/errors.js';
import { ModeAInitializationError } from '../knowledge/initialization.js';
import { ParentKnowledgePinError } from '../knowledge/parent-pin-types.js';
import { PublicationError } from '../knowledge/publication-types.js';
import { ProfileOperationError } from '../profile/errors.js';
import {
  ProjectionError,
  SourceDocumentError,
  SourceSelectionError,
} from '../projector/errors.js';
import { ProjectSyncError } from '../projector/sync.js';
import { RetrievalOperationError } from '../retrieval/index.js';
import { SecurityOperationError } from '../sanitizer/errors.js';
import { CliUsageError } from './parser.js';
import type {
  CliEnvelopeCommand,
  CliFailureResult,
  CliPresentationContext,
} from './types.js';

export class CliOperationUnavailableError extends Error {
  constructor() {
    super('CLI operation is not available.');
    this.name = 'CliOperationUnavailableError';
  }
}

export class CliQualityGateError extends Error {
  constructor() {
    super('Quality gate did not pass.');
    this.name = 'CliQualityGateError';
  }
}

export class CliPublicationIdentityError extends Error {
  readonly code = 'PUBLISH_IDENTITY_UNAVAILABLE' as const;

  constructor() {
    super('Publication lineage identity is unavailable.');
    this.name = 'CliPublicationIdentityError';
  }
}

function publicationExitCode(code: PublicationError['code']): 3 | 6 {
  return code === 'PUBLISH_INELIGIBLE' || code === 'PUBLISH_PATH_DRIFT' ||
    code === 'PUBLISH_POLICY_BLOCKED'
    ? 3
    : 6;
}

function safeRecoveryCommand(
  recoveryCommand: readonly string[] | undefined,
): readonly string[] | undefined {
  if (
    recoveryCommand === undefined ||
    recoveryCommand.length === 0 ||
    recoveryCommand.some((part) => !/^(?:--)?[A-Za-z0-9._:-]+$/u.test(part))
  ) {
    return undefined;
  }
  return Object.freeze([...recoveryCommand]);
}

function knowledgeExitCode(code: KnowledgeErrorCode): 2 | 3 | 4 | 6 {
  switch (code) {
    case 'PROJECT_NOT_FOUND':
    case 'SOURCE_BINDING_REQUIRED':
    case 'WORKSPACE_NOT_EMPTY':
      return 2;
    case 'MANIFEST_INVALID':
    case 'PATH_OUTSIDE_KNOWLEDGE':
    case 'PROJECT_EXISTS':
    case 'SOURCE_BINDING_CONFLICT':
    case 'SOURCE_BINDING_INVALID':
      return 3;
    case 'COMPILER_STATUS_UNSAFE':
    case 'REGISTRY_BUSY':
    case 'REGISTRY_WRITE_FAILED':
    case 'SOURCE_BINDING_BUSY':
    case 'SOURCE_BINDING_WRITE_FAILED':
      return 4;
    case 'GIT_ACCESS_DENIED':
    case 'GIT_NOT_AVAILABLE':
    case 'KNOWLEDGE_NOT_CONFIGURED':
    case 'SUBMODULE_CONFLICT':
    case 'SUBMODULE_MISMATCH':
    case 'SUBMODULE_UNINITIALIZED':
      return 6;
  }
}

function safeKnowledgeMessage(code: KnowledgeErrorCode): string {
  if (code === 'WORKSPACE_NOT_EMPTY') {
    return 'A non-Git workspace must be empty before initialization.';
  }
  if (code === 'SOURCE_BINDING_REQUIRED') {
    return 'The selected project requires an explicit local source binding.';
  }
  if (code === 'SOURCE_BINDING_CONFLICT' || code === 'SOURCE_BINDING_INVALID') {
    return 'The local source binding is invalid or conflicts with existing state.';
  }
  if (code === 'SOURCE_BINDING_BUSY' || code === 'SOURCE_BINDING_WRITE_FAILED') {
    return 'The local source binding could not be updated safely.';
  }
  switch (knowledgeExitCode(code)) {
    case 2:
      return 'The selected project is not registered.';
    case 3:
      return 'Knowledge configuration or project boundaries are invalid.';
    case 4:
      return 'Knowledge state could not be updated safely.';
    case 6:
      return 'Git or knowledge submodule state requires recovery.';
  }
}

function baseFailure(
  context: CliPresentationContext,
  exitCode: 2 | 3 | 4 | 5 | 6,
  code: string,
  message: string,
  recoveryCommand?: readonly string[],
): CliFailureResult {
  return Object.freeze({
    ...context,
    errors: Object.freeze([
      Object.freeze({
        code,
        message,
        ...(recoveryCommand === undefined ? {} : { recoveryCommand }),
      }),
    ]),
    exitCode,
    ok: false,
  });
}

export function mapCliError(
  error: unknown,
  context: CliPresentationContext = { command: 'unknown' },
): CliFailureResult {
  if (error instanceof CliUsageError) {
    return baseFailure(
      context,
      2,
      error.code,
      'Command usage is invalid. Run buildlore --help for usage.',
    );
  }
  if (error instanceof ModeAInitializationError) {
    const failure = baseFailure(
      context,
      knowledgeExitCode(error.code),
      error.code,
      safeKnowledgeMessage(error.code),
      safeRecoveryCommand(error.recoveryCommand),
    );
    return Object.freeze({
      ...failure,
      data: Object.freeze({ completedStages: error.completedStages }),
      partial: true,
    });
  }
  if (error instanceof KnowledgeError) {
    return baseFailure(
      context,
      knowledgeExitCode(error.code),
      error.code,
      safeKnowledgeMessage(error.code),
      safeRecoveryCommand(error.recoveryCommand),
    );
  }
  if (error instanceof CliPublicationIdentityError) {
    return baseFailure(
      context,
      3,
      error.code,
      'Publication lineage identity is unavailable or unsafe.',
    );
  }
  if (error instanceof PublicationError) {
    return Object.freeze({
      ...baseFailure(
        context,
        publicationExitCode(error.code),
        error.code,
        publicationExitCode(error.code) === 3
          ? 'Publication input or policy was rejected safely.'
          : 'Git publication state requires recovery.',
      ),
      partial: error.partial,
    });
  }
  if (error instanceof ParentKnowledgePinError) {
    return Object.freeze({
      ...baseFailure(
        context,
        6,
        error.code,
        'Parent knowledge pin state requires recovery.',
      ),
      partial: error.partial,
    });
  }
  if (error instanceof CompilerOperationError) {
    if (error.code === 'COMPILER_EGRESS_DENIED') {
      return baseFailure(context, 3, error.code, 'Compiler egress was denied by policy.');
    }
    if (
      error.code === 'COMPILER_CONFIG_INVALID' ||
      error.code === 'COMPILER_PROVIDER_UNKNOWN' ||
      error.code === 'COMPILER_PROVIDER_UNAVAILABLE'
    ) {
      return baseFailure(context, 2, error.code, 'Compiler provider configuration is unavailable.');
    }
    return baseFailure(context, 4, error.code, 'Compiler execution failed safely.');
  }
  if (error instanceof SessionCompileError) {
    const admissionFailure = error.code === 'SESSION_ADMISSION_FAILED';
    const operationalFailure = error.code === 'SESSION_CANDIDATE_APPROVAL_FAILED' ||
      error.code === 'SESSION_CANDIDATE_BUSY' ||
      error.code === 'SESSION_CANDIDATE_RECOVERY_REQUIRED';
    return Object.freeze({
      ...baseFailure(
        context,
        admissionFailure || operationalFailure ? 4 : 3,
        error.code,
        admissionFailure
          ? 'Session output could not be staged safely.'
          : error.code === 'SESSION_PLAN_STALE'
            ? 'Session compile plan changed and must be regenerated.'
            : 'Session compile input or output was rejected safely.',
      ),
      data: Object.freeze({
        candidateRefs: error.candidateRefs,
        recoveryAction: error.recoveryAction,
        sideEffectsPossible: error.sideEffectsPossible,
      }),
      partial: error.sideEffectsPossible,
    });
  }
  if (error instanceof ProjectCheckError) {
    const failure = baseFailure(context, 4, error.code, 'Project quality check failed safely.');
    return Object.freeze({
      ...failure,
      data: Object.freeze({ completedComponents: error.completedComponents }),
      partial: error.partial,
    });
  }
  if (error instanceof ProjectCorpusError) {
    const validationFailure = error.code === 'CORPUS_CONTRACT_VIOLATION' ||
      error.code === 'CORPUS_SECURITY_DENIED';
    return baseFailure(
      context,
      validationFailure ? 3 : 4,
      error.code,
      validationFailure ? 'Project corpus was rejected safely.' : 'Project corpus read failed safely.',
    );
  }
  if (error instanceof RetrievalOperationError) {
    return baseFailure(
      context,
      error.code === 'RETRIEVAL_CONFIG_INVALID' ? 2 : 4,
      error.code,
      error.code === 'RETRIEVAL_CONFIG_INVALID'
        ? 'Retrieval input is invalid.'
        : 'Retrieval execution failed safely.',
    );
  }
  if (error instanceof ProjectSyncError) {
    const bindingFailure = error.code === 'SYNC_BINDING_FAILED';
    const validationFailure = error.code === 'SYNC_INPUT_DRIFT' ||
      error.code === 'SYNC_MANIFEST_FAILED' ||
      error.code === 'SYNC_PLAN_BLOCKED' ||
      error.code === 'SYNC_SANITIZATION_FAILED' ||
      error.code === 'SYNC_SELECTION_FAILED' ||
      error.code === 'SYNC_TARGET_COLLISION';
    const failure = baseFailure(
      context,
      bindingFailure ? 2 : validationFailure ? 3 : 4,
      error.code,
      bindingFailure
        ? 'Synchronization requires a valid explicit local source binding.'
        : validationFailure
          ? 'Synchronization input or plan was rejected safely.'
          : 'Synchronization failed safely.',
    );
    return Object.freeze({
      ...failure,
      data: Object.freeze({
        completedTargets: error.completedTargets,
        failedPhase: error.failedPhase,
        recoveryAction: error.recoveryAction,
        ...(error.sanitization === undefined ? {} : { sanitization: error.sanitization }),
      }),
      partial: error.partial,
    });
  }
  if (error instanceof SourceSelectionError) {
    return baseFailure(
      context,
      3,
      error.code,
      'Source collection manifest or selection was rejected safely.',
    );
  }
  if (error instanceof ProjectionError || error instanceof SourceDocumentError) {
    const validationFailure = error.code.includes('INVALID') ||
      error.code.includes('UNSAFE') ||
      error.code.includes('MISMATCH') ||
      error.code.includes('COLLISION') ||
      error.code.includes('SANITIZATION');
    return baseFailure(
      context,
      validationFailure ? 3 : 4,
      error.code,
      validationFailure
        ? 'Projection input or policy validation failed.'
        : 'Projection execution failed safely.',
    );
  }
  if (error instanceof SecurityOperationError) {
    const failure = baseFailure(context, 3, error.code, 'Security policy rejected the operation.');
    if (error.policyFailureKind === undefined) return failure;
    return Object.freeze({
      ...failure,
      data: Object.freeze({ policyFailureKind: error.policyFailureKind }),
    });
  }
  if (error instanceof ProfileOperationError) {
    const runtimeFailure = error.code === 'PROFILE_APPLY_FAILED' ||
      error.code === 'PROFILE_LANGUAGE_CONFLICT' ||
      error.code === 'PROFILE_UPSTREAM_INVALID';
    return baseFailure(
      context,
      runtimeFailure ? 4 : 3,
      error.code,
      runtimeFailure
        ? 'Lifecycle profile execution failed safely.'
        : 'Lifecycle profile validation failed.',
    );
  }
  if (error instanceof CliQualityGateError) {
    return baseFailure(context, 5, 'QUALITY_GATE_FAILED', 'Project quality checks did not pass.');
  }
  if (error instanceof CliOperationUnavailableError) {
    return baseFailure(
      context,
      4,
      'CLI_OPERATION_NOT_AVAILABLE',
      'This command is not available in the current BuildLore implementation.',
    );
  }
  return baseFailure(
    context,
    4,
    'INTERNAL_ERROR',
    'BuildLore could not complete the command.',
  );
}

export function unknownCommandContext(command: CliEnvelopeCommand = 'unknown'): CliPresentationContext {
  return { command };
}
