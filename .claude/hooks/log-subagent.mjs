#!/usr/bin/env node
/**
 * SubagentStop: append one JSONL record per subagent run.
 *
 * WHAT IT DOES  Records agent name and timestamp to .claude/state/agent-runs.jsonl.
 * WHY           This is what makes the roster prunable. The plan caps the roster at 8 agents and
 *               requires deleting any agent with fewer than 3 runs in 30 days - unused agents are
 *               not free, they consume description budget and invite mis-routing. Without this
 *               log that rule is unenforceable guesswork.
 * REMOVE        Delete the SubagentStop entry in .claude/settings.json. You lose the usage
 *               evidence behind the roster review; everything else keeps working.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
const read = (s) => new Promise((r) => { let d=''; s.setEncoding('utf8'); s.on('data',c=>d+=c); s.on('end',()=>r(d)); });
try {
  const i = JSON.parse((await read(process.stdin)) || '{}');
  mkdirSync('.claude/state', { recursive: true });
  appendFileSync('.claude/state/agent-runs.jsonl', JSON.stringify({
    at: new Date().toISOString(),
    agent: i?.agent_type ?? i?.agent_id ?? 'unknown',
    session: i?.session_id ?? null,
  }) + '\n');
} catch { /* never block on bookkeeping */ }
process.exit(0);
