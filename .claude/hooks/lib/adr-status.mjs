/**
 * Single source of truth for reading an ADR's machine-readable status.
 *
 * WHY THIS FILE EXISTS
 *   guard-adr.mjs and guard-commit.mjs each carried their own copy of this logic, so the two
 *   "independent layers" protecting Must-Know Rule 7 were one layer implemented twice - and they
 *   shared two defects that made both fail OPEN:
 *
 *   C-1  The section regex ended with `(?=^##\s|\Z)`. In JavaScript `\Z` matches a LITERAL
 *        capital Z, not end-of-input. When `## Status` was the last section of a file the regex
 *        did not match at all, the status block came back empty, and an Accepted ADR was treated
 *        as not-Accepted. A capital Z anywhere in the block truncated it the same way.
 *
 *   C-2  The old parser scanned the WHOLE status block for the words "accepted" and "proposed"
 *        and treated a block containing both as the unfilled template. Real ADRs carry human
 *        prose in that block - acceptance preconditions, the "only a human may set this" note -
 *        so `Accepted 2026-09-08 (was Proposed 2026-09-01)` parsed as not-Accepted. That is the
 *        exact wording a human reaches for while accepting an ADR.
 *
 * THE FIX, IN ONE SENTENCE
 *   The machine-readable status is the FIRST non-empty line of the `## Status` section that is
 *   not a blockquote or comment. Everything else in that section is prose and is ignored.
 *
 *   Blockquotes (`>`) are how this repo writes acceptance preconditions and warnings, so they are
 *   explicitly not part of the value. That keeps the human note in ADR-0006 and the BLOCKED
 *   banner in ADR-0012 readable without either confusing the parser.
 *
 * FAIL CLOSED
 *   A status that cannot be parsed returns UNKNOWN, and UNKNOWN is treated as immutable. A
 *   malformed status must stop an edit and be corrected, never be silently read as "not
 *   Accepted" - that is precisely how C-1 and C-2 caused a total bypass.
 */

export const STATUS = {
  PROPOSED:   'proposed',
  ACCEPTED:   'accepted',
  SUPERSEDED: 'superseded',
  BLOCKED:    'blocked',      // Proposed, and explicitly held - still mutable
  TEMPLATE:   'template',     // 0000-template.md ships every option on one line
  UNKNOWN:    'unknown',      // unparseable -> treated as immutable
};

/**
 * @param {string} body full markdown of an ADR
 * @returns {{status: string, raw: string|null, reason: string|null}}
 */
export function parseAdrStatus(body) {
  // `$(?![\s\S])` is the correct "end of input" assertion in JavaScript. `\Z` is not.
  const section = String(body ?? '')
    .match(/^##[ \t]+Status[ \t]*\r?$([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/mi);

  if (!section) return { status: STATUS.UNKNOWN, raw: null, reason: 'no "## Status" section' };

  let raw = null;
  for (const line of section[1].split('\n')) {
    const t = line.replace(/\r$/, '').trim();
    if (!t) continue;
    if (t.startsWith('>')) continue;        // human prose: preconditions, warnings, notes
    if (t.startsWith('<!--')) continue;     // comment
    raw = t;
    break;
  }
  if (raw === null) {
    return { status: STATUS.UNKNOWN, raw: null, reason: '"## Status" section has no value line' };
  }

  // Strip markdown emphasis so **Accepted** and `Accepted` read the same.
  const norm = raw.replace(/[*_`]/g, '').trim();

  // The template ships alternatives separated by pipes.
  if (norm.split('|').length > 1) return { status: STATUS.TEMPLATE, raw, reason: null };

  if (/^superseded\b/i.test(norm))  return { status: STATUS.SUPERSEDED, raw, reason: null };
  if (/^accepted\b/i.test(norm))    return { status: STATUS.ACCEPTED, raw, reason: null };
  if (/^proposed\b/i.test(norm)) {
    return /\bblocked\b/i.test(norm)
      ? { status: STATUS.BLOCKED, raw, reason: null }
      : { status: STATUS.PROPOSED, raw, reason: null };
  }

  return {
    status: STATUS.UNKNOWN,
    raw,
    reason: `status line is not one of Proposed / Accepted / Superseded by ADR-NNNN: "${raw}"`,
  };
}

/** Immutable under Must-Know Rule 7. UNKNOWN is included deliberately - fail closed. */
export const isImmutableStatus = (s) => s === STATUS.ACCEPTED || s === STATUS.UNKNOWN;

/** The one permitted change to an Accepted ADR. */
export const isSupersedeTarget = (s) => s === STATUS.SUPERSEDED;
