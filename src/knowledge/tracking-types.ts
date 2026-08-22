export const KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION =
  'buildlore.knowledge-tracking-policy.v1' as const;
export const COMPILER_OUTPUT_INVENTORY_SCHEMA_VERSION =
  'buildlore.compiler-output-inventory.v1' as const;

export const LLM_WIKI_COMPILER_PACKAGE = 'llm-wiki-compiler' as const;
export const LLM_WIKI_COMPILER_VERSION = '1.1.0' as const;
export const LLM_WIKI_COMPILER_INTEGRITY =
  'sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==' as const;
export const LLM_WIKI_COMPILER_COMMIT =
  '6963a7f8374282de5d4084a324be69b50f62a32d' as const;

export type Sha256Digest = `sha256:${string}`;
export type TrackingClassification = 'always-ignore' | 'always-track' | 'policy-track';
export type TrackingDisposition = 'exclude' | 'include';
export type TrackingProducer = 'buildlore' | 'llm-wiki-compiler@1.1.0' | 'shared';
export type TrackingPortability = 'machine-local' | 'portable';
export type TrackingReproducibility =
  | 'authoritative'
  | 'derived'
  | 'ephemeral'
  | 'incremental'
  | 'regenerable';
export type TrackingSecretOrAuthorityRisk =
  | 'authority'
  | 'credential'
  | 'local-state'
  | 'none';
export type TrackingMergeRisk = 'low' | 'review-required' | 'unsafe';
export type TrackingRegenerationSafety =
  | 'from-tracked-state'
  | 'must-not-publish'
  | 'not-regenerable'
  | 'safe-to-regenerate';

export interface CompilerPackageIdentity {
  readonly exactVersion: string;
  readonly packageIntegrity: string;
  readonly upstreamPackage: string;
}

export interface TrackingEntry {
  readonly classification: TrackingClassification;
  readonly defaultDisposition: TrackingDisposition;
  readonly id: string;
  readonly mergeRisk: TrackingMergeRisk;
  readonly pattern: string;
  readonly portability: TrackingPortability;
  readonly producer: TrackingProducer;
  readonly rationale: string;
  readonly regenerationSafety: TrackingRegenerationSafety;
  readonly reproducibility: TrackingReproducibility;
  readonly secretOrAuthorityRisk: TrackingSecretOrAuthorityRisk;
}

export interface KnowledgeTrackingPolicyV1 {
  readonly entries: readonly TrackingEntry[];
  readonly exactVersion: typeof LLM_WIKI_COMPILER_VERSION;
  readonly inventoryDigest: Sha256Digest;
  readonly packageCommit: typeof LLM_WIKI_COMPILER_COMMIT;
  readonly packageIntegrity: typeof LLM_WIKI_COMPILER_INTEGRITY;
  readonly policyDigest: Sha256Digest;
  readonly schemaVersion: typeof KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION;
  readonly upstreamPackage: typeof LLM_WIKI_COMPILER_PACKAGE;
}

export interface CompilerInventoryEntry {
  readonly classification: TrackingClassification;
  readonly familyId: string;
  readonly operation: string;
  readonly policyEntryId: string;
  readonly projectRelativePath: string;
  readonly sourceEvidence: string;
}

export interface CompilerOutputInventoryV1 {
  readonly entries: readonly CompilerInventoryEntry[];
  readonly exactVersion: typeof LLM_WIKI_COMPILER_VERSION;
  readonly inventoryDigest: Sha256Digest;
  readonly packageCommit: typeof LLM_WIKI_COMPILER_COMMIT;
  readonly packageIntegrity: typeof LLM_WIKI_COMPILER_INTEGRITY;
  readonly schemaVersion: typeof COMPILER_OUTPUT_INVENTORY_SCHEMA_VERSION;
  readonly upstreamPackage: typeof LLM_WIKI_COMPILER_PACKAGE;
}

export type TrackingFailureCode =
  | 'TRACKING_INVENTORY_INVALID'
  | 'TRACKING_PACKAGE_INTEGRITY_MISMATCH'
  | 'TRACKING_PATH_AMBIGUOUS'
  | 'TRACKING_PATH_UNCLASSIFIED'
  | 'TRACKING_POLICY_INVALID';

export type TrackingClassificationResult =
  | {
      readonly classification: TrackingClassification;
      readonly disposition: TrackingDisposition;
      readonly entryId: string;
      readonly ok: true;
    }
  | {
      readonly code: Exclude<
        TrackingFailureCode,
        'TRACKING_INVENTORY_INVALID' | 'TRACKING_POLICY_INVALID'
      >;
      readonly ok: false;
    };

export interface TrackingSelectionOptions {
  readonly includePolicyTrack?: boolean;
}

export type SemanticCacheState =
  | 'compatible-candidate'
  | 'embedding-cache-missing'
  | 'identity-marker-missing';

export class TrackingContractError extends Error {
  readonly code: 'TRACKING_INVENTORY_INVALID' | 'TRACKING_POLICY_INVALID';

  constructor(code: 'TRACKING_INVENTORY_INVALID' | 'TRACKING_POLICY_INVALID') {
    super('Knowledge tracking contract is invalid.');
    this.name = 'TrackingContractError';
    this.code = code;
  }
}
