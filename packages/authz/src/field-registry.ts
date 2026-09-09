import type { AuthContext, DataClass, FieldRule, ResourceType, Role } from './types';

/**
 * The field registry, and it is DEFAULT-DENY.
 *
 * A field with no entry here is never serialized, for any role, in any response. That is not
 * strictness for its own sake - it is the specific control that stops the failure this codebase
 * already had:
 *
 *   `GET /employees/:id` was `SELECT e.*`. Migration 0014 added eleven personal columns to
 *   `employee` and every one of them immediately began serialising to any authenticated caller -
 *   date of birth, home address, emergency contact, exit reason. Nothing failed. No test broke.
 *   The disclosure arrived as a side effect of adding columns to a table.
 *
 * With a default-deny registry that is impossible: a new column is invisible until somebody
 * consciously classifies it. Being wrong then costs a missing field in a response, which is
 * loud, instead of a silent disclosure, which is not.
 *
 * Per-role DTOs were rejected by ADR-0005 for the same reason: they multiply combinatorially and
 * fail OPEN the moment one of them spreads the entity.
 */

const R = (
  cls: DataClass,
  roles: readonly Role[],
  self: boolean,
  neverInList = false,
): FieldRule => ({ cls, roles, self, neverInList });

/** Everyone authenticated may see it. */
const PUBLIC = (): FieldRule => R('PUBLIC_INTERNAL', ['employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor'], true);
/** The subject, plus HR. */
const HR_AND_SELF = (cls: DataClass, neverInList = false): FieldRule =>
  R(cls, ['hr_admin', 'hr_ops'], true, neverInList);
/** The subject only - nobody else, whatever they hold. */
const SELF_ONLY = (cls: DataClass): FieldRule => R(cls, [], true, true);

/*
 * Pay. RESTRICTED, and the role list is hr_admin + finance ONLY - not hr_ops, who hold every
 * other HR field here. See the payroll policy: the salary register is need-to-know and `finance`
 * exists because payroll is a separate function.
 *
 * `neverInList` is deliberately NOT set on the amounts. It exists to stop bulk exfiltration
 * through a list endpoint, and a payroll register is the textbook target - but HR legitimately
 * needs that register, and an employee's own list is useless without the net figure. The control
 * against bulk reads here is the scope predicate plus an audit row per access, not field masking,
 * which would only have moved the same data one request away.
 */
const PAY = (): FieldRule => R('RESTRICTED', ['hr_admin', 'finance'], true);

const REGISTRY: Partial<Record<ResourceType, Record<string, FieldRule>>> = {
  payslip: {
    id: PAY(),
    employee_id: PAY(),
    employee_number: PAY(),
    full_name: PAY(),
    // The period and the status are not amounts, but they are still pay data: "there is no
    // payslip for March" is information about somebody's employment and pay.
    period_start: PAY(),
    period_end: PAY(),
    pay_date: PAY(),
    status: PAY(),
    currency_code: PAY(),
    // Derived by fn_payslip_totals, in integer paise (Rule 4).
    gross_minor: PAY(),
    deductions_minor: PAY(),
    net_minor: PAY(),
    // What the PDF states. Kept distinct from net_minor on purpose - see migration 0024.
    declared_net_minor: PAY(),
    line_count: PAY(),
    reconciles: PAY(),
    has_document: PAY(),
    document_id: PAY(),
    note: PAY(),
    void_reason: PAY(),
    issued_at: PAY(),
    voided_at: PAY(),
    created_at: PAY(),
    source: PAY(),
  },

  employee: {
    // PUBLIC_INTERNAL - what a colleague needs to work with somebody.
    id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    work_email: PUBLIC(),
    department: PUBLIC(),
    designation: PUBLIC(),
    manager: PUBLIC(),
    work_location: PUBLIC(),
    employment_type: PUBLIC(),
    assignment_since: PUBLIC(),
    status: PUBLIC(),
    joined_on: PUBLIC(),
    confirmed_on: PUBLIC(),

    // PERSONAL - the subject and HR.
    personal_phone: HR_AND_SELF('PERSONAL', true),
    personal_email: HR_AND_SELF('PERSONAL', true),
    address_line1: HR_AND_SELF('PERSONAL', true),
    address_line2: HR_AND_SELF('PERSONAL', true),
    city: HR_AND_SELF('PERSONAL', true),
    state_region: HR_AND_SELF('PERSONAL', true),
    postal_code: HR_AND_SELF('PERSONAL', true),
    probation_end_on: HR_AND_SELF('PERSONAL'),
    resigned_on: HR_AND_SELF('PERSONAL'),
    notice_days: HR_AND_SELF('PERSONAL'),
    last_working_day: HR_AND_SELF('PERSONAL'),
    exited_on: HR_AND_SELF('PERSONAL'),
    exit_type: HR_AND_SELF('PERSONAL'),

    // SENSITIVE.
    date_of_birth: HR_AND_SELF('SENSITIVE', true),
    gender: HR_AND_SELF('SENSITIVE', true),

    // Third-party data: the contact never consented and has no relationship with us. Subject
    // only, and purpose-bound to an actual emergency (docs/privacy/data-inventory.md).
    emergency_contact_name: SELF_ONLY('PERSONAL'),
    emergency_contact_phone: SELF_ONLY('PERSONAL'),
    emergency_contact_relation: SELF_ONLY('PERSONAL'),

    // Health data with an unconfirmed purpose (OR-16). Subject only until HR confirms a use.
    blood_group: SELF_ONLY('SENSITIVE'),

    // RESTRICTED. Free text that may describe conduct, performance or health.
    exit_reason: R('RESTRICTED', ['hr_admin'], false, true),

    // NOTE: password_hash, token_hash and anything else credential-shaped appear NOWHERE in this
    // registry, so they can never be serialized by any role including the subject.
  },

  employee_document: {
    id: PUBLIC(),
    employee_id: PUBLIC(),
    document_type_code: PUBLIC(),
    document_type_name: PUBLIC(),
    data_class: PUBLIC(),
    title: PUBLIC(),
    issued_on: PUBLIC(),
    expires_on: PUBLIC(),
    issuing_authority: PUBLIC(),
    note: HR_AND_SELF('PERSONAL'),
    version_count: PUBLIC(),
    // Availability and the quarantine state of the LATEST version. These MUST be registered:
    // `maskRow` drops anything unregistered, so adding a column to the query without adding it
    // here makes it silently vanish from the response - which is the default-deny registry
    // working exactly as intended, and a trap for whoever adds the next field.
    available: PUBLIC(),
    current_version_no: PUBLIC(),
    latest_version_no: PUBLIC(),
    latest_scan_status: PUBLIC(),
    scan_status: PUBLIC(),
    size_bytes: PUBLIC(),
    content_type: PUBLIC(),
    original_name: HR_AND_SELF('PERSONAL'),
    uploaded_at: PUBLIC(),
    uploaded_by_name: PUBLIC(),
    withdrawn_at: PUBLIC(),
    withdrawn_reason: HR_AND_SELF('PERSONAL'),
    // NOT registered, therefore never serialized: bucket, object_key, sha256_hex. The storage
    // coordinates are an internal detail - handing them out invites a caller to try the object
    // store directly, and a presigned URL in a response body ends up in a log.
  },

  department: {
    id: PUBLIC(),
    code: PUBLIC(),
    name: PUBLIC(),
    description: PUBLIC(),
    parent_department_id: PUBLIC(),
    parent_code: PUBLIC(),
    head_employee_id: PUBLIC(),
    head_name: PUBLIC(),
    depth: PUBLIC(),
    headcount: PUBLIC(),
    valid_from: PUBLIC(),
    valid_to: PUBLIC(),
  },

  team: {
    id: PUBLIC(),
    code: PUBLIC(),
    name: PUBLIC(),
    description: PUBLIC(),
    department_id: PUBLIC(),
    department_code: PUBLIC(),
    lead_employee_id: PUBLIC(),
    lead_name: PUBLIC(),
    member_count: PUBLIC(),
    archived_at: PUBLIC(),
    valid_from: PUBLIC(),
    valid_to: PUBLIC(),
  },

  employment: {
    valid_from: PUBLIC(),
    valid_to: PUBLIC(),
    department: PUBLIC(),
    designation: PUBLIC(),
    manager: PUBLIC(),
    reason: HR_AND_SELF('PERSONAL'),
    employment_type: PUBLIC(),
    work_location: PUBLIC(),
  },
};

/**
 * The set of fields this actor may see on this resource.
 *
 * `inList` matters: `rbac-rules.md` requires that RESTRICTED fields never appear in a collection
 * response even for a role that could read them individually - a legitimate list request is how
 * bulk disclosure actually happens.
 */
export function fieldMask(
  ctx: AuthContext,
  type: ResourceType,
  opts: { isSubject: boolean; inList?: boolean },
): Set<string> {
  const table = REGISTRY[type];
  if (!table) return new Set();          // unregistered resource: nothing is visible

  const out = new Set<string>();
  for (const [field, rule] of Object.entries(table)) {
    if (opts.inList && rule.neverInList) continue;
    if (opts.isSubject && rule.self) { out.add(field); continue; }
    if (rule.roles.some((r) => ctx.roles.includes(r))) out.add(field);
  }
  return out;
}

/** Apply the mask to a row. Anything unregistered is dropped, not nulled. */
export function applyMask<T extends Record<string, unknown>>(
  row: T,
  allowed: Set<string>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) if (allowed.has(k)) out[k] = row[k];
  return out as Partial<T>;
}

/** Fields present on a row that the registry does not know about. Used by the drift test. */
export function unregisteredFields(type: ResourceType, row: Record<string, unknown>): string[] {
  const table = REGISTRY[type] ?? {};
  return Object.keys(row).filter((k) => !(k in table));
}

export function registeredFields(type: ResourceType): string[] {
  return Object.keys(REGISTRY[type] ?? {});
}
