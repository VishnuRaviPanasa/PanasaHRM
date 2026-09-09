/**
 * HR master data for the work hierarchy: Project -> Sub-project -> Task -> Sub-task.
 *
 * WHY A SEPARATE CONTROLLER FROM `work.ts`. That file answers "what did people do" - attendance,
 * work logs, timesheets, team effort. This one answers "what is there to do work against". The
 * two have different readers, different authorization and different failure consequences: a bug
 * in a work log costs one person's day, a bug here changes what everybody on a project may log
 * against and can retire a branch out from under a live timesheet.
 *
 * LIFECYCLE, NOT DELETION. Nothing here hard-deletes. `project` retires through its existing
 * `status` column and the three new levels through `active` (0027) - and the foreign keys refuse
 * a DELETE of anything a work log references, so the choice is not merely a convention. A work
 * log filed in March keeps naming the sub-task it was filed against forever, because the label is
 * read by joining and the join does not care whether the master is retired. Retiring only affects
 * what may be chosen for NEW effort.
 *
 * TWO ACTIONS, DELIBERATELY UNEQUAL:
 *   * `work.project.manage`  - project and sub-project. Already existed, and already admits a
 *     project lead as well as HR. Left as it was rather than narrowed, because narrowing an
 *     existing grant would change behaviour nothing asked to change.
 *   * `work.task.manage`     - task and sub-task. New, HR-only. Retiring a task changes what
 *     every member of that project may log against, which is an HR master-data act.
 *
 * Both resolve through `AuthorizationService`; there is no role literal anywhere in this file
 * (Rule 1). Every write is wrapped so a database rail - the composite hierarchy keys, the
 * assignee-must-be-a-member trigger - surfaces as a 400 the caller can act on rather than a 500.
 */
import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post, Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthzDeniedError } from '@panasa/authz';
import { Authenticated } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/** The PostgreSQL error classes a caller can do something about. Anything else is a real fault. */
const CALLER_FIXABLE = new Set([
  '23503', // foreign_key_violation   - wrong parent, or a delete of something still referenced
  '23505', // unique_violation        - duplicate code
  '23514', // check_violation         - blank name, bad status
  '23001', // restrict_violation
  'P0001', // raise_exception         - our own triggers
]);

const text = (v: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (opts.required) throw new BadRequestException(`${field} is required`);
    return null;
  }
  if (s.length > (opts.max ?? 120)) {
    throw new BadRequestException(`${field} must be ${opts.max ?? 120} characters or fewer`);
  }
  return s;
};

const bool = (v: unknown, field: string): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new BadRequestException(`${field} must be true or false`);
};

@Controller('work-masters')
export class WorkMastersController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  /**
   * Authorise a master-data act.
   *
   * `project` and `task` are the two resource types the hierarchy answers to; a sub-project is
   * governed as part of its project and a sub-task as part of its task, which is why there are
   * four levels and two actions rather than four of each. Adding two more resource types would
   * have meant two more `EMPLOYEE_COLUMN` entries and twelve more matrix cells to say the same
   * thing twice.
   */
  private async assert(req: Request, level: 'project' | 'task'): Promise<void> {
    const ctx = authContext(req);
    const action = level === 'project' ? 'work.project.manage' : 'work.task.manage';
    try {
      await this.authz.assertCan(ctx, action, { type: level });
    } catch (e) {
      if (e instanceof AuthzDeniedError) {
        // A master-data collection, so refusing it discloses no individual record.
        throw new NotFoundException('Work master data is not available to you');
      }
      throw e;
    }
  }

  /** Run a write, translating the database's own rails into 400s. */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (CALLER_FIXABLE.has(e?.code)) {
        throw new BadRequestException(String(e?.message ?? 'That change was refused').split('\n')[0]);
      }
      throw e;
    }
  }

  // ================================================================ read

  /**
   * The whole hierarchy, INCLUDING retired records.
   *
   * This is the one endpoint that shows inactive rows, and it has to: the master-data screen is
   * where somebody goes to reactivate something, which is impossible if retired records are
   * invisible. `GET /projects` is the opposite - it returns only what is selectable for new
   * effort - and the two must not be conflated. `usage` is the count of work-log lines already
   * attributed to each node, so the screen can warn before retiring something in active use
   * rather than leaving somebody to discover it from a support ticket.
   */
  @Get('tree')
  @Authenticated()
  async tree(@Req() req: Request, @Query('q') q?: string) {
    await this.assert(req, 'project');
    const like = text(q, 'q', { required: false });

    const rows = await this.db.rows(
      `WITH usage AS (
         SELECT project_id, task_id, sub_task_id, count(*)::int AS n
           FROM work_log_entry GROUP BY 1, 2, 3
       )
       SELECT p.id  AS project_id,  p.code  AS project_code,  p.name  AS project_name,
              p.status AS project_status, p.client_name,
              sp.id AS sub_project_id, sp.code AS sub_project_code, sp.name AS sub_project_name,
              sp.active AS sub_project_active,
              t.id  AS task_id, t.code AS task_code, t.title AS task_title,
              t.status AS task_status, t.active AS task_active, t.sub_project_id AS task_parent,
              st.id AS sub_task_id, st.code AS sub_task_code, st.title AS sub_task_title,
              st.active AS sub_task_active,
              (SELECT coalesce(sum(n), 0) FROM usage u WHERE u.project_id = p.id)     AS project_usage,
              (SELECT coalesce(sum(n), 0) FROM usage u WHERE u.task_id = t.id)        AS task_usage,
              (SELECT coalesce(sum(n), 0) FROM usage u WHERE u.sub_task_id = st.id)   AS sub_task_usage
         FROM project p
         LEFT JOIN sub_project sp ON sp.project_id = p.id
         LEFT JOIN task        t  ON t.project_id  = p.id
                                 AND t.sub_project_id IS NOT DISTINCT FROM sp.id
         LEFT JOIN sub_task    st ON st.task_id    = t.id
        WHERE ($1::text IS NULL
               OR p.name ILIKE '%' || $1 || '%' OR p.code ILIKE '%' || $1 || '%'
               OR sp.name ILIKE '%' || $1 || '%' OR t.title ILIKE '%' || $1 || '%'
               OR t.code ILIKE '%' || $1 || '%' OR st.title ILIKE '%' || $1 || '%')
        ORDER BY p.code, sp.name NULLS FIRST, t.code NULLS LAST, st.code NULLS LAST`, [like]);

    /*
     * Assembled here rather than by nested json_agg in SQL.
     *
     * The join is a LEFT JOIN chain, so an empty branch arrives as a row of NULLs and a task
     * appears once per sub-task. Folding that in SQL needs three correlated aggregates and reads
     * far worse than the twenty lines below. Note `t.sub_project_id IS NOT DISTINCT FROM sp.id`
     * in the join: without it a task belonging directly to the project would be repeated under
     * every sub-project, which is the same mistake v_work_hierarchy's first draft made in the
     * other direction (check WH6).
     */
    const projects: any[] = [];
    const byId = new Map<string, any>();
    for (const r of rows as any[]) {
      let p = byId.get(r.project_id);
      if (!p) {
        p = {
          id: r.project_id, code: r.project_code, name: r.project_name,
          clientName: r.client_name, status: r.project_status,
          active: r.project_status === 'active', usage: Number(r.project_usage),
          subProjects: [], tasks: [],
        };
        byId.set(r.project_id, p);
        projects.push(p);
      }

      let holder = p;
      if (r.sub_project_id) {
        let sp = p.subProjects.find((x: any) => x.id === r.sub_project_id);
        if (!sp) {
          sp = {
            id: r.sub_project_id, code: r.sub_project_code, name: r.sub_project_name,
            active: r.sub_project_active, tasks: [],
          };
          p.subProjects.push(sp);
        }
        // A task hanging directly off the project must not be filed under a sub-project that
        // merely appeared on the same row of the join.
        if (r.task_parent === r.sub_project_id) holder = sp;
      }

      if (!r.task_id) continue;
      let t = holder.tasks.find((x: any) => x.id === r.task_id);
      if (!t) {
        t = {
          id: r.task_id, code: r.task_code, title: r.task_title, status: r.task_status,
          active: r.task_active, subProjectId: r.task_parent, usage: Number(r.task_usage),
          subTasks: [],
        };
        holder.tasks.push(t);
      }
      if (r.sub_task_id && !t.subTasks.some((x: any) => x.id === r.sub_task_id)) {
        t.subTasks.push({
          id: r.sub_task_id, code: r.sub_task_code, title: r.sub_task_title,
          active: r.sub_task_active, usage: Number(r.sub_task_usage),
        });
      }
    }

    return { projects, query: like };
  }

  // ================================================================ project

  @Post('projects')
  @Authenticated()
  async createProject(@Req() req: Request, @Body() body: {
    code?: string; name?: string; clientName?: string; managerId?: string; startedOn?: string;
  }) {
    await this.assert(req, 'project');
    const code = text(body?.code, 'code', { max: 24, required: true })!.toUpperCase();
    const name = text(body?.name, 'name', { required: true })!;
    return this.write(async () => ({
      project: await this.db.one(
        `INSERT INTO project (code, name, client_name, manager_id, started_on)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, name, client_name, status`,
        [code, name, text(body?.clientName, 'clientName'), body?.managerId || null,
          text(body?.startedOn, 'startedOn')]),
    }));
  }

  @Patch('projects/:id')
  @Authenticated()
  async updateProject(@Req() req: Request, @Param('id') id: string, @Body() body: {
    name?: string; clientName?: string; status?: string; active?: boolean;
  }) {
    await this.assert(req, 'project');
    /*
     * `active` is accepted as an ALIAS for the status column rather than as a second flag.
     *
     * 0027 deliberately did not add `active` to `project`, because `status` already answers "may
     * this be used" and two columns for one question is how a row ends up active and closed at
     * once. The screen still has one toggle per level, so it sends `active` for all four; here
     * that maps onto 'active'/'closed'. `on_hold` is reachable only by sending `status`
     * explicitly, so the toggle cannot silently destroy that state.
     */
    const status = body?.status !== undefined
      ? text(body.status, 'status', { max: 16, required: true })!
      : body?.active !== undefined
        ? (bool(body.active, 'active') ? 'active' : 'closed')
        : null;
    if (status && !['active', 'on_hold', 'closed'].includes(status)) {
      throw new BadRequestException('status must be active, on_hold or closed');
    }
    return this.write(async () => {
      const row = await this.db.one(
        `UPDATE project
            SET name        = coalesce($2, name),
                client_name = coalesce($3, client_name),
                status      = coalesce($4, status)
          WHERE id = $1
          RETURNING id, code, name, client_name, status`,
        [id, text(body?.name, 'name'), text(body?.clientName, 'clientName'), status]);
      if (!row) throw new NotFoundException('No such project');
      return { project: row };
    });
  }

  // ================================================================ sub-project

  @Post('sub-projects')
  @Authenticated()
  async createSubProject(@Req() req: Request, @Body() body: {
    projectId?: string; code?: string; name?: string;
  }) {
    await this.assert(req, 'project');
    if (!body?.projectId) throw new BadRequestException('projectId is required');
    const name = text(body?.name, 'name', { required: true })!;
    return this.write(async () => ({
      subProject: await this.db.one(
        `INSERT INTO sub_project (project_id, code, name)
         VALUES ($1, $2, $3) RETURNING id, project_id, code, name, active`,
        [body.projectId, text(body?.code, 'code', { max: 24 }), name]),
    }));
  }

  @Patch('sub-projects/:id')
  @Authenticated()
  async updateSubProject(@Req() req: Request, @Param('id') id: string, @Body() body: {
    name?: string; code?: string; active?: boolean;
  }) {
    await this.assert(req, 'project');
    return this.write(async () => {
      const row = await this.db.one(
        `UPDATE sub_project
            SET name   = coalesce($2, name),
                code   = coalesce($3, code),
                active = coalesce($4, active)
          WHERE id = $1
          RETURNING id, project_id, code, name, active`,
        [id, text(body?.name, 'name'), text(body?.code, 'code', { max: 24 }),
          body?.active === undefined ? null : bool(body.active, 'active')]);
      if (!row) throw new NotFoundException('No such sub-project');
      return { subProject: row };
    });
  }

  // ================================================================ task

  @Post('tasks')
  @Authenticated()
  async createTask(@Req() req: Request, @Body() body: {
    projectId?: string; subProjectId?: string | null; code?: string; title?: string;
    assigneeEmployeeId?: string | null; dueOn?: string;
  }) {
    await this.assert(req, 'task');
    if (!body?.projectId) throw new BadRequestException('projectId is required');
    const title = text(body?.title, 'title', { required: true })!;
    /*
     * `sub_project_id` is passed through unvalidated ON PURPOSE. `fk_task_sub_project` is a
     * COMPOSITE key on (sub_project_id, project_id), so a sub-project belonging to a different
     * project is refused by the database - and `write()` turns that into a 400. Re-checking it
     * here would add a second, weaker copy of a rule the schema already holds absolutely, and the
     * two copies would be free to disagree.
     */
    return this.write(async () => ({
      task: await this.db.one(
        `INSERT INTO task (project_id, sub_project_id, code, title, assignee_employee_id, due_on)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, project_id, sub_project_id, code, title, status, active`,
        [body.projectId, body?.subProjectId || null, text(body?.code, 'code', { max: 24 }),
          title, body?.assigneeEmployeeId || null, text(body?.dueOn, 'dueOn')]),
    }));
  }

  @Patch('tasks/:id')
  @Authenticated()
  async updateTask(@Req() req: Request, @Param('id') id: string, @Body() body: {
    title?: string; code?: string; status?: string; active?: boolean;
    subProjectId?: string | null;
  }) {
    await this.assert(req, 'task');
    const status = body?.status === undefined
      ? null
      : text(body.status, 'status', { max: 16, required: true })!;
    if (status && !['open', 'in_progress', 'done'].includes(status)) {
      throw new BadRequestException('status must be open, in_progress or done');
    }
    return this.write(async () => {
      const row = await this.db.one(
        `UPDATE task
            SET title  = coalesce($2, title),
                code   = coalesce($3, code),
                status = coalesce($4, status),
                active = coalesce($5, active),
                -- A re-parent has to be able to set NULL (move a task up to the project), so it
                -- is driven by an explicit flag rather than by coalesce, which cannot express it.
                sub_project_id = CASE WHEN $6 THEN $7::uuid ELSE sub_project_id END,
                closed_at = CASE WHEN coalesce($4, status) = 'done' AND closed_at IS NULL
                                 THEN now() ELSE closed_at END
          WHERE id = $1
          RETURNING id, project_id, sub_project_id, code, title, status, active`,
        [id, text(body?.title, 'title'), text(body?.code, 'code', { max: 24 }), status,
          body?.active === undefined ? null : bool(body.active, 'active'),
          Object.prototype.hasOwnProperty.call(body ?? {}, 'subProjectId'),
          body?.subProjectId || null]);
      if (!row) throw new NotFoundException('No such task');
      return { task: row };
    });
  }

  // ================================================================ sub-task

  @Post('sub-tasks')
  @Authenticated()
  async createSubTask(@Req() req: Request, @Body() body: {
    taskId?: string; code?: string; title?: string;
  }) {
    await this.assert(req, 'task');
    if (!body?.taskId) throw new BadRequestException('taskId is required');
    const title = text(body?.title, 'title', { required: true })!;
    return this.write(async () => ({
      subTask: await this.db.one(
        `INSERT INTO sub_task (task_id, code, title)
         VALUES ($1, $2, $3) RETURNING id, task_id, code, title, active`,
        [body.taskId, text(body?.code, 'code', { max: 24 }), title]),
    }));
  }

  @Patch('sub-tasks/:id')
  @Authenticated()
  async updateSubTask(@Req() req: Request, @Param('id') id: string, @Body() body: {
    title?: string; code?: string; active?: boolean;
  }) {
    await this.assert(req, 'task');
    return this.write(async () => {
      const row = await this.db.one(
        `UPDATE sub_task
            SET title  = coalesce($2, title),
                code   = coalesce($3, code),
                active = coalesce($4, active)
          WHERE id = $1
          RETURNING id, task_id, code, title, active`,
        [id, text(body?.title, 'title'), text(body?.code, 'code', { max: 24 }),
          body?.active === undefined ? null : bool(body.active, 'active')]);
      if (!row) throw new NotFoundException('No such sub-task');
      return { subTask: row };
    });
  }
}

@Module({ controllers: [WorkMastersController] })
export class WorkMastersModule {}
