#!/usr/bin/env node
/**
 * PostToolUse (Edit|Write): append the touched path to a session dirty-list.
 *
 * WHAT IT DOES  Records which files changed this session, so a later Stop hook can typecheck
 *               and lint ONLY those files instead of the whole workspace.
 * WHY           This tier fires hundreds of times a day. Anything perceptible here is what kills
 *               a hook system. Budget: under 50ms. It does one append and nothing else.
 * REMOVE        Delete the PostToolUse entry in .claude/settings.json. Incremental checks then
 *               have to fall back to checking everything, which is slower but still correct.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
const read = (s) => new Promise((r) => { let d=''; s.setEncoding('utf8'); s.on('data',c=>d+=c); s.on('end',()=>r(d)); });
try {
  const i = JSON.parse((await read(process.stdin)) || '{}');
  const p = i?.tool_input?.file_path ?? i?.tool_input?.path;
  if (p) {
    mkdirSync('.claude/state', { recursive: true });
    appendFileSync('.claude/state/dirty-files.txt', String(p).split(String.fromCharCode(92)).join(String.fromCharCode(47)) + '\n');
  }
} catch { /* never block on bookkeeping */ }
process.exit(0);
