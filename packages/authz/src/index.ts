/**
 * @panasa/authz - the ONLY place permission logic may live (Must-Know Rule 1).
 *
 * Importing anything from here is how the rest of the application asks an authorization
 * question. A role comparison anywhere outside this package is a CRITICAL finding.
 */

// Import for the side effect of registering every policy. Without this the registry is empty
// and every action falls through to the `no_policy` deny - fail-closed, but uselessly so.
import './policies';

export * from './types';
export { ACTIONS, ALL_ACTIONS, actionMeta, malformedActionNames, type Action } from './actions';
export {
  ALLOW_ALL, DENY_ALL, either, employeeColumn, projectMembership, reportingScope, selfOnly,
} from './graphs';
export {
  always, asOfDate, definePolicy, evaluate, isAncestorOfActor, isBreakGlassActor,
  isDirectReport, isInSubtree, isNotRestricted, isProjectLead, isProjectMember, isSelf,
  isSelfAndNotRestricted, policyFor,
  registeredActions, type AllowRule, type GraphPort, type Guard, type Policy,
} from './policy';
export { actionsWithoutPolicy } from './policies';
export {
  applyMask, fieldMask, registeredFields, unregisteredFields,
} from './field-registry';
export {
  assertPolicyCoverage, AuthorizationService, AuthzDeniedError, type AuthzAuditSink,
} from './service';
export {
  ALLOWED_CONTENT_TYPES, EXTENSION_FOR, MAX_DECOMPRESSION_RATIO, MAX_UNCOMPRESSED_BYTES,
  MAX_UPLOAD_BYTES, objectKeyFor, sniffContentType, validateUpload,
  type AllowedContentType, type SniffedType, type UploadCandidate, type UploadRejection,
  type UploadVerdict,
} from './upload-validation';
