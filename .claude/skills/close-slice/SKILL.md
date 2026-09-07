---
name: close-slice
description: Close the current slice. Verifies every acceptance test exists and passes, archives the card, and refreshes session state.
disable-model-invocation: true
---

# /close-slice

## 1. Verify - this is the gate, not a formality

Read `.claude/state/CURRENT_SLICE.md` and for **each** acceptance criterion:

- Confirm the named test **exists**. A criterion naming a test that does not exist is a
  **CRITICAL** finding: the card is fiction, and archiving it would put fiction into the project
  history.
- Run it. Confirm it **passes**.

**If any criterion fails either check, stop. Do not close the slice.** Report which and why.

## 2. Review

Run `/review` for the slice's change class if it has not already passed on the current HEAD.
Zero CRITICAL and zero unwaived HIGH is required.

## 3. Archive

- Copy the card to `docs/slices/SL-NNN.md`, appending: what actually happened, anything that
  turned out differently from the plan, and any follow-up raised.
- Reset `.claude/state/CURRENT_SLICE.md` to the empty state.
- Update `.claude/state/SESSION_HANDOFF.md`: what was completed, what is in flight, **the exact
  next action**.
- Update `.claude/state/OPEN_RISKS.md` - close what is resolved, add what was discovered.
- Add a DEC entry for any decision made along the way, and an ADR for any architectural one.

## 4. Ask the once-per-slice question

> **Did anything in this slice contradict `CLAUDE.md`, or reveal a rule that is missing from it?**

Answer it explicitly. This is the deliberate replacement for a per-turn nag: once per slice is
often enough to keep the operating contract honest, and rare enough that it still gets read.
