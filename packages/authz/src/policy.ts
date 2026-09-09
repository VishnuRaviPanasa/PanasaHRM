import type { Action } from './actions';
import type { AuthContext, Decision, Obligation, ResourceRef, Role, ScopePredicate } from './types';

/**
 * The policy engine.
 *
 * Two properties are non-negotiable and both are structural rather than conventional:
 *
 *   1. DENY-OVERRIDES ARE EVALUATED FIRST and cannot be beaten by any allow rule. That is what
 *      makes "a manager who is also an HR admin still cannot see their own manager's record"
 *      TRUE rather than accidentally true - the second role would otherwise simply win.
 *
 *   2. AN ACTION WITH NO POLICY IS DENIED. Not "allowed because nobody said no", and not a
 *      thrown configuration error that a try/catch turns into an allow. `evaluate` returns a
 *      deny with reason `no_policy`.
 */

/**
 * Graph questions the engine cannot answer alone. Implemented by the application against
 * migration 0014's resolvers, so this package needs no database dependency and no knowledge of
 * how the graphs are stored (architecture-principles: dependencies point inward).
 */
export interface GraphPort {
  /** Depth 1 only. */
  isDirectReport(managerEmployeeId: string, employeeId: string, asOf: string): Promise<boolean>;
  /** Any depth beneath the manager. */
  isInSubtree(managerEmployeeId: string, employeeId: string, asOf: string): Promise<boolean>;
  /**
   * True when `employeeId` was a member of `projectId` ON `asOf`, optionally in one of `roles`.
   *
   * `asOf` became meaningful in migration 0019, which made `project_member` effective-dated.
   * Before that the project graph could not decay at all (OR-17) and this parameter was
   * documented as ignored.
   */
  isProjectMember(
    employeeId: string, projectId: string, roles?: readonly string[], asOf?: string,
  ): Promise<boolean>;
}

export type Guard = (
  ctx: AuthContext,
  ref: ResourceRef,
  graph: GraphPort,
) => boolean | Promise<boolean>;

export interface AllowRule {
  readonly role: Role;
  /** Omitted means the role alone suffices. */
  readonly when?: Guard | undefined;
  readonly obligations?: readonly Obligation[] | undefined;
}

export interface Policy {
  readonly action: Action;
  /** Evaluated first. Any true result denies, whatever the allow rules say. */
  readonly denyOverrides?: readonly Guard[] | undefined;
  readonly allow: readonly AllowRule[];
  /** The row filter for list queries. */
  readonly scope: (ctx: AuthContext, ref: ResourceRef) => ScopePredicate;
}

// ---------------------------------------------------------------------------
// Reusable guards
// ---------------------------------------------------------------------------

/** The record's own effective date, defaulting to today. Graph edges resolve against this. */
export function asOfDate(ref: ResourceRef): string {
  return ref.asOf ?? new Date().toISOString().slice(0, 10);
}

function subjectOf(ref: ResourceRef): string | undefined {
  return ref.subjectEmployeeId ?? (ref.type === 'employee' ? ref.id : undefined);
}

export const isSelf: Guard = (ctx, ref) => {
  const subject = subjectOf(ref);
  return !!ctx.employeeId && !!subject && ctx.employeeId === subject;
};

export const isDirectReport: Guard = async (ctx, ref, graph) => {
  const subject = subjectOf(ref);
  if (!ctx.employeeId || !subject || subject === ctx.employeeId) return false;
  return graph.isDirectReport(ctx.employeeId, subject, asOfDate(ref));
};

export const isInSubtree: Guard = async (ctx, ref, graph) => {
  const subject = subjectOf(ref);
  if (!ctx.employeeId || !subject || subject === ctx.employeeId) return false;
  return graph.isInSubtree(ctx.employeeId, subject, asOfDate(ref));
};

export const isProjectMember: Guard = async (ctx, ref, graph) => {
  if (!ctx.employeeId || !ref.projectId) return false;
  // As of the RECORD's date, not today: the same temporal rule the reporting graph follows.
  return graph.isProjectMember(ctx.employeeId, ref.projectId, undefined, asOfDate(ref));
};

export const isProjectLead: Guard = async (ctx, ref, graph) => {
  if (!ctx.employeeId || !ref.projectId) return false;
  return graph.isProjectMember(
    ctx.employeeId, ref.projectId, ['lead', 'project_manager'], asOfDate(ref));
};

export const always: Guard = () => true;

/**
 * The document class is not RESTRICTED.
 *
 * RESTRICTED document types are offer letters, contracts, appraisals and disciplinary records -
 * the ones stating compensation or judgement. `rbac-rules.md` puts RESTRICTED behind an explicit
 * grant and bars it from list endpoints; here it means hr_admin only, and NOT the subject.
 *
 * An absent `dataClass` is treated as RESTRICTED. A caller who forgot to pass it gets the
 * narrowest answer rather than the widest - the same failure direction as the field registry.
 */
export const isNotRestricted: Guard = (_ctx, ref) =>
  ref.dataClass !== undefined && ref.dataClass !== 'RESTRICTED';

/** Both: the actor is the subject AND the document is not RESTRICTED. */
export const isSelfAndNotRestricted: Guard = (ctx, ref, graph) =>
  Promise.resolve(isSelf(ctx, ref, graph)).then(
    (self) => self === true && isNotRestricted(ctx, ref, graph) === true);

/**
 * DENY-OVERRIDE: never your own manager's record, at any depth, whatever else you hold.
 *
 * Without this, an HR admin who is also somebody's report reads their own manager's file through
 * the hr_admin grant. It is a deny-override rather than an omission from the allow list because
 * allow lists are additive - a second role would otherwise re-open it.
 */
export const isAncestorOfActor: Guard = async (ctx, ref, graph) => {
  const subject = subjectOf(ref);
  if (!ctx.employeeId || !subject || subject === ctx.employeeId) return false;
  // Is the SUBJECT above the ACTOR? Then the actor is asking about their own chain of command.
  return graph.isInSubtree(subject, ctx.employeeId, asOfDate(ref));
};

/** A break-glass account is for restoring access, not for reading HR data. */
export const isBreakGlassActor: Guard = (ctx) => ctx.isBreakGlass;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const DENY = (reason: string): Decision => ({ allowed: false, reason, obligations: [] });

export async function evaluate(
  policy: Policy | undefined,
  ctx: AuthContext,
  ref: ResourceRef,
  graph: GraphPort,
): Promise<Decision> {
  // An unregistered action is denied. This is the fail-closed default that makes forgetting a
  // policy a visible 403 rather than an invisible allow.
  if (!policy) return DENY('no_policy');

  // 1. Deny-overrides, first and unconditionally.
  for (const guard of policy.denyOverrides ?? []) {
    if (await guard(ctx, ref, graph)) return DENY('deny_override');
  }

  // 2. Allow rules. The actor must hold the role AND satisfy its condition.
  for (const rule of policy.allow) {
    if (!ctx.roles.includes(rule.role)) continue;
    const ok = rule.when ? await rule.when(ctx, ref, graph) : true;
    if (ok) {
      return {
        allowed: true,
        reason: `allow:${rule.role}`,
        obligations: rule.obligations ?? [],
      };
    }
  }

  return DENY('no_matching_allow');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<Action, Policy>();

export function definePolicy(policy: Policy): Policy {
  if (REGISTRY.has(policy.action)) {
    throw new Error(`authz: duplicate policy for ${policy.action}`);
  }
  REGISTRY.set(policy.action, policy);
  return policy;
}

export function policyFor(action: Action): Policy | undefined {
  return REGISTRY.get(action);
}

export function registeredActions(): Action[] {
  return [...REGISTRY.keys()];
}
