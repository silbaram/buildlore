export {
  createBuildLoreLifecycleProfile,
  MAX_LIFECYCLE_PROFILE_BYTES,
  parseLifecycleProfile,
  parseOutputLanguage,
  renderLifecycleProfile,
} from './codec.js';
export {
  deriveLifecyclePageId,
  evaluateLifecycleReview,
  isLifecycleTransitionAllowed,
  validateLifecycleFixture,
} from './decisions.js';
export { ProfileOperationError, type ProfileOperationErrorCode } from './errors.js';
export { createProjectLifecycleProfile } from './manager.js';
export { materializeLifecycleProfile } from './materializer.js';
export {
  createBuiltInProfileBinding,
  parseProfileBinding,
  PROFILE_BINDING_SCHEMA_VERSION,
  profileBindingForLegacyResolution,
  registerProfileBinding,
  type BuiltInProfileId,
  type ProfileAdapterBindingV1,
  type ProfileBindingV1,
  type RegisteredProfileBindingV1,
} from './bindings.js';
export {
  createProfileBindingPreflight,
  resolveRegisteredProfileBinding,
  type ProfileBindingPreflight,
  type ResolvedRegisteredProfileBindingV1,
} from './preflight.js';
export {
  BUILDLORE_PROFILE_ID,
  BUILDLORE_PROFILE_SCHEMA_VERSION,
  BUILDLORE_PROFILE_VERSION,
  PROFILE_APPLY_SCHEMA_VERSION,
  PROFILE_PLAN_SCHEMA_VERSION,
  type BuildLoreLifecycleProfileV1,
  type LifecycleEntityType,
  type LifecycleFixture,
  type LifecycleFixtureResult,
  type LifecycleReviewSignals,
  type MaterializedProfile,
  type OutputLanguage,
  type ProfileApplyResult,
  type ProfileBinding,
  type ProfileChangePlan,
  type ProfileEntityDecision,
  type ProfileEntityDirectory,
  type ProfileEntityType,
  type ProfileExclusions,
  type ProfileFreshnessPolicy,
  type ProfileHeldReason,
  type ProfileLifecycleDecision,
  type ProfilePlanDisposition,
  type ProfileRelationDecision,
  type ProfileRelationType,
  type ProfileReviewPolicy,
  type ProjectLifecycleProfilePort,
} from './types.js';
