import type { ConnectionErrorCode } from '../connection/contracts.js';

/** Static, path-free guidance shared by CLI errors and connection diagnostics. */
export function connectionRecovery(code: ConnectionErrorCode): Readonly<{ message: string; command: readonly string[] }> {
  switch (code) {
    case 'CONNECTION_MISSING': case 'CONNECTION_INCOMPLETE':
      return { message: 'Source connection is missing or incomplete. From the source checkout, run connect with the knowledge checkout and explicit project id. See buildlore --help for required inputs.', command: ['--help'] };
    case 'HUB_UNAVAILABLE': case 'READ_BOUNDARY_VIOLATION':
      return { message: 'The selected checkout is unavailable or unsafe. Check the checkout location; run workspace guide at the knowledge Git root and doctor from the source checkout.', command: ['workspace', 'guide'] };
    case 'APPROVAL_MISSING':
      return { message: 'No approved Wiki is available. From the knowledge checkout, follow workspace guide to author, review, explicitly approve and activate content.', command: ['workspace', 'guide'] };
    case 'KNOWLEDGE_INVALID':
      return { message: 'Approved Wiki validation failed. In the knowledge checkout, inspect workspace guide and restore a trusted Git revision. Do not overwrite or recreate approval records to bypass validation.', command: ['workspace', 'guide'] };
    case 'KNOWLEDGE_IDENTITY_MISMATCH': case 'SOURCE_IDENTITY_MISMATCH': case 'PROJECT_MISMATCH':
      return { message: 'The connection identity does not match the selected repository or project. Check project registration in the knowledge checkout before reconnecting from the source checkout.', command: ['project', 'list'] };
    case 'KNOWLEDGE_PIN_MISMATCH': case 'KNOWLEDGE_UNINITIALIZED':
      return { message: 'The legacy knowledge checkout or Git pin needs recovery. Inspect knowledge status in the hub before retrying from the source checkout.', command: ['knowledge', 'status'] };
    case 'GENERATION_CHANGED': case 'GENERATION_REQUIRED':
      return { message: 'A current approved generation is required. Refresh connection status in the source checkout and retry with its generation.', command: ['connection', 'status'] };
    default:
      return { message: 'Connection configuration could not be validated. Inspect connection status in the source checkout before repairing or reconnecting it.', command: ['connection', 'status'] };
  }
}
