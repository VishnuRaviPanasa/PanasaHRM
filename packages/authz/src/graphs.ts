import type { ResourceType, ScopePredicate } from './types';

/**
 * The two scope graphs, rendered as SQL predicates.
 *
 * These resolve against migration 0014's functions rather than duplicating the traversal in
 * TypeScript. That matters for more than tidiness: `fn_reporting_subtree_asof` is depth-capped
 * and cycle-guarded, and a hand-rolled JS walk would have to re-earn both. It also keeps the
 * filter inside the query, which is the whole point - `rbac-rules.md` rejects fetch-then-filter
 * because removing rows in JavaScript still leaks through counts, pagination totals and timing.
 *
 * TEMPORAL RULE, and it differs per graph:
 *   * REPORTING edges resolve as of the RECORD'S date. That is what makes a rolled-off manager
 *     lose access automatically and a former manager still resolve for the period they actually
 *     managed (temporal-data-rules rule 4).
 *   * ROLE GRANTS resolve as of NOW, and are not part of this file at all - see AuthContext.
 *
 * OR-17 IS CLOSED. `project_member` became effective-dated in migration 0019, so the project
 * graph now decays like the reporting graph: closing a membership period ends access from that
 * day without deleting the row, so the effort already logged keeps its attribution and last
 * quarter's project report does not change.
 */

/** Which column on a resource's table identifies the employee the row is about. */
const EMPLOYEE_COLUMN: Record<ResourceType, string | null> = {
  employee: 'id',
  employment: 'employee_id',
  leave_request: 'employee_id',
  leave_balance: 'employee_id',
  attendance_day: 'employee_id',
  attendance_punch: 'employee_id',
  work_log: 'employee_id',
  timesheet: 'employee_id',
  // A task is about its ASSIGNEE, which is nullable - and that nullability is load-bearing, not
  // an inconvenience. An unassigned task has no subject, so `assignee_employee_id = <someone>`
  // is never true for it and the reporting graph excludes it by construction rather than by a
  // condition somebody has to remember. Unassigned work is reported through the project graph,
  // which is keyed on the project and can see it.
  task: 'assignee_employee_id',
  project_effort: 'employee_id',
  project: null,          // a project is not about one employee
  department: null,       // nor is a department or a team
  // A designation is a JOB TITLE in a catalogue, not a fact about a person. The employment row
  // that points at one is about somebody; the catalogue entry is not.
  designation: null,
  team: null,
  employee_document: 'employee_id',
  payslip: 'employee_id',
  // A salary annexure is about the person being hired. That is what makes the self-scope
  // meaningful here even though nobody is granted it: `onboarding.annexure.read` denies the
  // subject deliberately, and the column being right is what would make a future "let them see
  // their own offer" row work without a second scope implementation.
  salary_annexure: 'employee_id',
  org_config: null,
  audit_event: 'subject_employee_id',
  identity: 'employee_id',
};

export function employeeColumn(type: ResourceType): string | null {
  return EMPLOYEE_COLUMN[type];
}

export const ALLOW_ALL: ScopePredicate = {
  kind: 'all',
  render: () => ({ sql: 'true', params: [] }),
};

/**
 * Deny everything. Rendered as a literal `false` so a caller who forgets to branch on
 * `kind === 'none'` still gets an empty result set rather than an unfiltered one. Failing closed
 * has to survive the caller being careless.
 */
export const DENY_ALL: ScopePredicate = {
  kind: 'none',
  render: () => ({ sql: 'false', params: [] }),
};

/** Only the actor's own rows. */
export function selfOnly(type: ResourceType, employeeId: string | null): ScopePredicate {
  const col = EMPLOYEE_COLUMN[type];
  if (!col || !employeeId) return DENY_ALL;
  return {
    kind: 'restricted',
    render: (alias, n) => ({ sql: `${alias}.${col} = $${n}`, params: [employeeId] }),
  };
}

/**
 * The actor plus everybody beneath them in the reporting hierarchy, as of `asOf`.
 *
 * `depth` narrows it: 1 means direct reports only. `rbac-rules.md` deliberately distinguishes
 * the two - a manager sees attendance for the whole subtree but compensation only for direct
 * reports - so collapsing them would silently widen access by a whole reporting level.
 */
export function reportingScope(
  type: ResourceType,
  employeeId: string | null,
  asOf: string | null,
  opts: { includeSelf: boolean; maxDepth?: number | undefined },
): ScopePredicate {
  const col = EMPLOYEE_COLUMN[type];
  if (!col || !employeeId) return DENY_ALL;

  return {
    kind: 'restricted',
    render: (alias, n) => {
      // $n = actor employee id, $n+1 = as-of date. The date is a parameter, never inlined,
      // so a caller-supplied as-of cannot reach the SQL text.
      const depthClause = opts.maxDepth === undefined ? '' : ` WHERE s.depth <= $${n + 2}`;
      const subtree =
        `SELECT s.employee_id FROM fn_reporting_subtree_asof($${n}, $${n + 1}) s${depthClause}`;
      const sql = opts.includeSelf
        ? `(${alias}.${col} = $${n} OR ${alias}.${col} IN (${subtree}))`
        : `${alias}.${col} IN (${subtree})`;
      const params: unknown[] = [employeeId, asOf];
      if (opts.maxDepth !== undefined) params.push(opts.maxDepth);
      return { sql, params };
    },
  };
}

/**
 * Rows about work on a project the actor belongs to.
 *
 * This does NOT widen to anything else about those people. A project lead sees effort on their
 * project; they do not thereby see that contributor's leave, attendance or employee record.
 * Merging the graphs is how a project lead ends up reading somebody's disciplinary file.
 *
 * `asOf` is accepted and IGNORED - see the OR-17 note at the top of this file. When
 * `project_member` becomes effective-dated, the subquery gains `AND pm.valid_period @> $date`
 * and nothing else here changes.
 */
export function projectMembership(
  type: ResourceType,
  employeeId: string | null,
  opts: { roles?: readonly string[] | undefined; asOf?: string | null | undefined } = {},
): ScopePredicate {
  if (!employeeId) return DENY_ALL;

  const projectCol = type === 'project' ? 'id' : 'project_id';

  return {
    kind: 'restricted',
    render: (alias, n) => {
      // $n = actor, $n+1 = as-of date. The date is a parameter, never inlined, so a
      // caller-supplied as-of cannot reach the SQL text.
      let sql = `${alias}.${projectCol} IN (
        SELECT pm.project_id FROM project_member pm
         WHERE pm.employee_id = $${n}
           AND pm.valid_period @> COALESCE($${n + 1}::date, fn_business_date())`;
      const params: unknown[] = [employeeId, opts.asOf ?? null];
      if (opts.roles?.length) {
        sql += ` AND pm.role = ANY($${n + 2})`;
        params.push([...opts.roles]);
      }
      sql += ')';
      return { sql, params };
    },
  };
}

/** Either of two predicates. Used where a role legitimately spans both graphs. */
export function either(a: ScopePredicate, b: ScopePredicate): ScopePredicate {
  if (a.kind === 'all' || b.kind === 'all') return ALLOW_ALL;
  if (a.kind === 'none') return b;
  if (b.kind === 'none') return a;
  return {
    kind: 'restricted',
    render: (alias, n) => {
      const left = a.render(alias, n);
      const right = b.render(alias, n + left.params.length);
      return {
        sql: `(${left.sql} OR ${right.sql})`,
        params: [...left.params, ...right.params],
      };
    },
  };
}
