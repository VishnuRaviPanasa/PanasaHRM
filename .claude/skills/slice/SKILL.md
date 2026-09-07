---
name: slice
description: Start a new work slice. Writes the slice card with acceptance criteria as test names and sets the change class.
disable-model-invocation: true
argument-hint: <one-line goal>
---

# /slice - start a slice

Goal: `$ARGUMENTS`

## Before writing anything

1. Read `.claude/state/SESSION_HANDOFF.md` and `.claude/state/OPEN_RISKS.md`.
2. **If a slice is already in flight, stop.** WIP is 1. Finish or explicitly abandon it first -
   two half-built slices cost more than one finished one, because each must be re-understood.
3. Check whether this goal is blocked by an open risk. If it is, say so and stop.

## Write `.claude/state/CURRENT_SLICE.md`

```markdown
# Current Slice

**Slice ID:** SL-NNN
**Goal:** <one sentence>
**Change class:** A | B | C   (derived from the paths this will touch)
**Started:** <date>

## Acceptance criteria

Written as **test names that must exist and pass** - not prose.

- [ ] `it("rejects overlapping employment periods when a second primary assignment is inserted")`
- [ ] `it("returns 404 when an unrelated employee requests a profile")`

## Files expected to change

## Next action

<the single next thing>
```

**Acceptance criteria must be test names.** Prose criteria are how a slice gets closed while
half-working: `/close-slice` runs exactly these names and refuses to close if any is missing or
failing. That is the mechanism that stops written state drifting from reality.

If the goal is class C, run **spec-adversary** against the requirement before writing any code,
and record what it raises here.
