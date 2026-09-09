import { actionMeta, type Action } from './actions';
import { applyMask, fieldMask } from './field-registry';
import { evaluate, policyFor, registeredActions, type GraphPort } from './policy';
import { actionsWithoutPolicy } from './policies';
import type { AuthContext, Decision, ResourceRef, ResourceType, ScopePredicate } from './types';

/** The single deny-all predicate, so every fail-closed path returns the identical object. */
const DENY_ALL_PREDICATE: ScopePredicate = {
  kind: 'none',
  render: () => ({ sql: 'false', params: [] }),
};

/**
 * Errors carry the 404-vs-403 decision, because `rbac-rules.md` is specific about it and it is
 * easy to get backwards:
 *
 *   Return 404, NOT 403, for a record outside the caller's scope. A 403 confirms the record
 *   exists, which is itself a disclosure - it turns an authorization boundary into an
 *   enumeration oracle.
 *
 * 403 is only correct where the caller provably already knows the resource exists: acting on
 * their OWN record without the privilege, or a permission they hold for some rows but not this
 * operation at all.
 */
export class AuthzDeniedError extends Error {
  /** 404 hides existence; 403 admits it. */
  readonly httpStatus: 403 | 404;
  readonly reasonCode: string;

  constructor(reasonCode: string, httpStatus: 403 | 404, message: string) {
    super(message);
    this.name = 'AuthzDeniedError';
    this.reasonCode = reasonCode;
    this.httpStatus = httpStatus;
  }
}

export interface AuthzAuditSink {
  /**
   * Called for every DENY, and for allows carrying an `audit_read` obligation.
   * `rbac-rules.md`/security-guidelines: permission-deny bursts are an alerting signal, so a
   * denial that goes unrecorded is a missing detection, not just a missing log line.
   */
  record(entry: {
    action: Action;
    decision: 'allow' | 'deny';
    reasonCode: string;
    ctx: AuthContext;
    ref: ResourceRef;
  }): void | Promise<void>;
}

/**
 * The only place an authorization decision is made (Must-Know Rule 1).
 *
 * Nothing here reads a database directly - graph questions go through `GraphPort`, which the
 * application implements against migration 0014's resolvers. That keeps the package free of a
 * driver dependency and makes the whole policy set unit-testable with a fake graph.
 */
export class AuthorizationService {
  constructor(
    private readonly graph: GraphPort,
    private readonly audit?: AuthzAuditSink | undefined,
  ) {}

  /** May they act at all? */
  async can(ctx: AuthContext, action: Action, ref: ResourceRef): Promise<Decision> {
    const decision = await evaluate(policyFor(action), ctx, ref, this.graph);

    if (!decision.allowed) {
      await this.audit?.record({
        action, decision: 'deny', reasonCode: decision.reason, ctx, ref,
      });
    } else if (decision.obligations.some((o) => o.kind === 'audit_read')) {
      await this.audit?.record({
        action, decision: 'allow', reasonCode: decision.reason, ctx, ref,
      });
    }

    return decision;
  }

  /**
   * Throw unless permitted.
   *
   * `notFoundOnDeny` defaults to TRUE - hiding existence is the safe default, and a caller has
   * to opt into admitting it. It is set false only where the caller provably already knows the
   * resource exists, typically an action on their own record.
   */
  async assertCan(
    ctx: AuthContext,
    action: Action,
    ref: ResourceRef,
    opts: { notFoundOnDeny?: boolean } = {},
  ): Promise<Decision> {
    const decision = await this.can(ctx, action, ref);
    if (decision.allowed) return decision;

    const hide = opts.notFoundOnDeny ?? true;
    throw hide
      ? new AuthzDeniedError(decision.reason, 404, 'Not found')
      : new AuthzDeniedError(decision.reason, 403, 'You do not have permission to do that');
  }

  /**
   * Which rows? Returns a predicate to compose INTO the query.
   *
   * Never use this to filter after fetching. `rbac-rules.md`: a post-fetch filter still leaks
   * through counts, pagination totals and timing even though the rows are removed.
   */
  scope(ctx: AuthContext, action: Action, ref: ResourceRef): ScopePredicate {
    const policy = policyFor(action);

    // Fail closed. An unregistered action gets the deny-all predicate, not an unfiltered query.
    if (!policy) return DENY_ALL_PREDICATE;

    /*
     * `can` and `scope` are separate concerns but they must not CONTRADICT each other, and the
     * matrix suite caught them doing exactly that: `finance` has no allow rule for
     * `work.log.read`, so `can` denied it - yet `scope` handed back a self-only predicate,
     * because the row-filter helper grants "your own rows" to anybody. Not a disclosure on its
     * own (the rows are the caller's), but a caller who composed `scope` without also calling
     * `assertCan` would have served a role that holds no grant at all.
     *
     * So a role-set precondition: if the actor holds NO role this policy names, there is nothing
     * to scope. This is the "may they act at all" question applied to the collection case, and it
     * keeps the two answers aligned by construction rather than by the caller remembering.
     */
    const holdsAnyNamedRole = policy.allow.some((rule) => ctx.roles.includes(rule.role));
    if (!holdsAnyNamedRole) return DENY_ALL_PREDICATE;

    return policy.scope(ctx, ref);
  }

  /** Which fields? Default-deny: an unregistered column is never returned. */
  fields(
    ctx: AuthContext,
    type: ResourceType,
    opts: { isSubject: boolean; inList?: boolean },
  ): Set<string> {
    return fieldMask(ctx, type, opts);
  }

  /** Convenience: mask a row in one call. */
  maskRow<T extends Record<string, unknown>>(
    ctx: AuthContext,
    type: ResourceType,
    row: T,
    opts: { isSubject: boolean; inList?: boolean },
  ): Partial<T> {
    return applyMask(row, this.fields(ctx, type, opts));
  }

  /** Masks a collection, with `neverInList` fields removed. */
  maskList<T extends Record<string, unknown>>(
    ctx: AuthContext,
    type: ResourceType,
    rows: readonly T[],
    subjectOf: (row: T) => string | null,
  ): Partial<T>[] {
    return rows.map((row) =>
      applyMask(row, this.fields(ctx, type, {
        isSubject: !!ctx.employeeId && subjectOf(row) === ctx.employeeId,
        inList: true,
      })),
    );
  }
}

/**
 * Boot assertion. ADR-0005 requires the application to REFUSE TO START if coverage is
 * incomplete, rather than discovering it as a runtime deny.
 *
 * `routeActions` is every action the route table annotates. Two directions are checked, and both
 * matter: an action with no policy would be silently denied at runtime, and a policy for an
 * action no route uses is dead rules nobody maintains.
 */
export function assertPolicyCoverage(routeActions: readonly Action[]): void {
  const problems: string[] = [];

  const missing = actionsWithoutPolicy(registeredActions());
  if (missing.length) {
    problems.push(`actions in the catalogue with NO policy: ${missing.join(', ')}`);
  }

  const unknown = routeActions.filter((a) => !policyFor(a));
  if (unknown.length) {
    problems.push(`routes annotated with an action that has no policy: ${unknown.join(', ')}`);
  }

  for (const action of routeActions) {
    const meta = actionMeta(action);
    if (!meta) problems.push(`route action not in the catalogue: ${action}`);
  }

  if (problems.length) {
    throw new Error(
      `authz coverage assertion failed - refusing to start:\n  - ${problems.join('\n  - ')}`,
    );
  }
}
