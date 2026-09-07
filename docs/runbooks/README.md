# docs/runbooks/

Operational procedures, written to be followed at 2am by someone who did not write them.
Planned: `deploy.md`, `restore.md`, `incident.md`, `offboarding.md`, `partition-maintenance.md`,
plus `incidents/` for blameless post-mortems.

Every alert must link to a runbook. **An alert with no runbook gets deleted, not documented.**

Two are load-bearing given single-VM hosting:

- **`restore.md`** - the monthly restore drill. Deployment is blocked if the last successful
  restore is more than 30 days old. An untested backup is not a backup.
- **`partition-maintenance.md`** - `pg_partman` with `premake = 3`, and a check that the newest
  partition bound is more than 60 days out. A missing future partition means every attendance
  punch INSERT fails at 00:00 IST on the 1st.
