/**
 * The vocabulary of an authorization decision.
 *
 * ADR-0005 keeps three concerns deliberately separate, and conflating any two of them is how HR
 * systems leak:
 *
 *   can / assertCan  - may they act at all?      prevents privilege escalation
 *   scope            - which rows?               prevents IDOR and over-broad lists
 *   fieldMask        - which fields?             prevents salary leaking through a legitimate list
 *
 * Nothing in this package compares a role outside a policy definition, and nothing outside this
 * package compares a role at all (Must-Know Rule 1).
 */

/** The roles `user_role` may grant. Mirrors ck_user_role_value in migration 0016. */
export type Role =
  | 'employee'
  | 'manager'
  | 'hr_admin'
  | 'hr_ops'
  | 'finance'
  | 'auditor';

export const ALL_ROLES: readonly Role[] = [
  'employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor',
] as const;

/**
 * Who is asking.
 *
 * `roles` are resolved AS OF NOW - never as of the record being viewed. ADR-0005 amendment (b):
 * the as-of date selects which DATA is displayed, never which PERMISSIONS apply. Conflating them
 * would let an expired role be re-acquired by choosing a historical as-of date, which is
 * privilege escalation with a date picker as its interface.
 *
 * Scope-graph EDGES are the opposite: they resolve as of the record's date, which is what makes
 * a rolled-off manager lose access automatically. The two rules are independent and both are
 * enforced here.
 */
export interface AuthContext {
  readonly userId: string;
  /** Null for a break-glass account, which has no employee behind it (ADR-0009). */
  readonly employeeId: string | null;
  readonly roles: readonly Role[];
  readonly isBreakGlass: boolean;
  /** Session surrogate (session.id) for audit correlation. Never the bearer token. */
  readonly sessionId?: string | undefined;
  readonly correlationId?: string | undefined;
}

/**
 * What is being acted on. `asOf` is the record's own effective date and is what the scope graphs
 * resolve against; omitting it means "now".
 */
export interface ResourceRef {
  readonly type: ResourceType;
  readonly id?: string | undefined;
  /** The employee a record is ABOUT, when that differs from `id`. */
  readonly subjectEmployeeId?: string | undefined;
  /** For work resources. */
  readonly projectId?: string | undefined;
  /** The record's effective date. Graph edges resolve as of this, not as of today. */
  readonly asOf?: string | undefined;
  /**
   * For documents: the data class of the DOCUMENT TYPE.
   *
   * Document content is unstructured, so a field mask cannot reach inside a PDF - an offer
   * letter's compensation figure is as invisible to the registry as its font. The type's
   * classification is therefore the whole basis of the access decision, and it has to travel
   * with the ref for the policy to see it.
   */
  readonly dataClass?: DataClass | undefined;
}

/**
 * The runtime list is the source of truth and `ResourceType` is DERIVED from it, so the two
 * cannot drift. `ALL_ROLES` below is declared the other way round - a separate array annotated
 * with the union - which catches an invalid entry but not a MISSING one. This shape catches
 * both, and a test that needs to sweep every resource type (matrix.test.mjs does, to prove the
 * field registry is default-deny at the TYPE level) needs the array to exist at runtime.
 */
export const ALL_RESOURCE_TYPES = [
  'employee',
  'employment',
  'leave_request',
  'leave_balance',
  'attendance_day',
  'attendance_punch',
  'work_log',
  'timesheet',
  'task',
  'project',
  'project_effort',
  'department',
  'designation',
  'team',
  'employee_document',
  'payslip',
  'org_config',
  'audit_event',
  'identity',
] as const;

export type ResourceType = (typeof ALL_RESOURCE_TYPES)[number];

/**
 * Which scope graph governs a resource type. ADR-0005: the two are ORTHOGONAL and neither
 * widens into the other.
 *
 * `organisation` is the third answer ADR-0005 amendment (a) adds, and it is not a third graph:
 * it means "not row-filtered by any graph, denied by default, reachable only by an explicit
 * administrative permission". Reading a policy row is a privilege, not a default.
 */
export type ScopeGraph = 'reporting' | 'project' | 'organisation' | 'self';

/**
 * A row filter, rendered into SQL and composed into the query.
 *
 * It is NOT a post-fetch filter. `rbac-rules.md` is explicit about why: removing rows in
 * JavaScript still leaks through counts, pagination totals and timing. The predicate must make
 * the query physically incapable of returning out-of-scope rows.
 */
export interface ScopePredicate {
  /** 'all' = unrestricted, 'none' = deny everything, 'restricted' = a real filter. */
  readonly kind: 'all' | 'none' | 'restricted';
  /**
   * Render for a given table alias, with placeholders numbered from `nextParamIndex`.
   * Returns SQL safe to interpolate: it contains only literals this package produced plus
   * numbered placeholders. Every caller-supplied value travels in `params`.
   */
  render(alias: string, nextParamIndex: number): { sql: string; params: unknown[] };
}

/** The outcome of a `can` evaluation, with a reason code for the audit trail. */
export interface Decision {
  readonly allowed: boolean;
  /** Machine-readable, safe to log. Never contains data values. */
  readonly reason: string;
  /** Obligations the caller must discharge if allowed (e.g. write a read-audit row). */
  readonly obligations: readonly Obligation[];
}

export type Obligation =
  | { readonly kind: 'audit_read'; readonly purpose: string }
  | { readonly kind: 'step_up'; readonly maxAge: string };

/**
 * Data classification, from `ai/context/security-guidelines.md`. Drives the field mask.
 * A field with NO classification is never serialized - that is the safe failure direction, and
 * it is what stopped `SELECT e.*` from being a disclosure again.
 */
export type DataClass = 'PUBLIC_INTERNAL' | 'PERSONAL' | 'SENSITIVE' | 'RESTRICTED';

/** Who may see a field, beyond the subject themselves. */
export interface FieldRule {
  readonly cls: DataClass;
  /** Roles that may see it for somebody else. Empty means subject-only. */
  readonly roles: readonly Role[];
  /** True when the subject may always see their own value. */
  readonly self: boolean;
  /** Never included in a list/collection response, regardless of role (rbac-rules). */
  readonly neverInList?: boolean;
}
