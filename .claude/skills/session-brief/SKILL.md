---
name: session-brief
description: Orient at the start of a session on PanasaHRM. Shows live git state, migration status, open risks and the current slice. Use when starting work, resuming after a break, or when unsure what state the project is in.
---

# Session brief

Live state, injected below. **Trust this over anything you remember.**

## Git

!`git log --oneline -5 2>/dev/null || echo "(no commits)"`

!`git status --short 2>/dev/null | head -20 || true`

## Migrations

!`ls -1 infrastructure/db/migrations/*.sql 2>/dev/null | tail -5 || echo "(none yet - Phase 2)"`

## Agents and skills present

!`ls -1 .claude/agents/*.md 2>/dev/null | wc -l | tr -d ' ' | sed 's/$/ agents/' || true`

## Guard hooks - do they still pass?

!`node testing/hooks/guards.test.mjs 2>/dev/null | tail -2 || echo "(guard test did not run)"`

---

Now read, in this order:

1. `.claude/state/CURRENT_SLICE.md` - what is in flight
2. `.claude/state/SESSION_HANDOFF.md` - what the last session did and the exact next action
3. `.claude/state/OPEN_RISKS.md` - what is blocked and on whom

Then state, in two or three sentences: **where the project is, what the next action is, and
whether anything blocks it.** Do not start work until you have said that.
