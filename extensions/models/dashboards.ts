// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4";
import {
  clientFrom,
  ConfirmArg,
  emit,
  GlobalArgsSchema,
  instanceName,
  ListSchema,
  ProjectArg,
  requireConfirm,
  resolveBaseUrl,
} from "./_lib/client.ts";

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const AnySchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  eTag: z.string().optional(),
  contributionId: z.string().optional(),
  refreshInterval: z.number().optional(),
  widgets: z.array(z.unknown()).optional(),
  position: z.unknown().optional(),
  size: z.unknown().optional(),
  deleted: z.boolean().optional(),
}).passthrough();
const teamArg = z.string().optional().describe(
  "Team name or ID. Defaults to the project's default team when omitted.",
);
const dashArg = z.string().min(1).describe("Dashboard ID (GUID).");
const widgetArg = z.string().min(1).describe("Widget ID (GUID).");
const PREVIEW = 3;

/** Dashboards are team scoped: {org}/{project}/{team}/_apis/dashboard/... */
const defaultTeams = new WeakMap<object, Map<string, string>>();

/** Resolves the project's default team ID once per execution context. */
async function defaultTeamId(c: any, ctx: any, project: string) {
  let cache = defaultTeams.get(ctx);
  if (!cache) defaultTeams.set(ctx, cache = new Map());
  const hit = cache.get(project);
  if (hit) return hit;
  const { data } = await c.get(`projects/${encodeURIComponent(project)}`, {
    project: null,
  });
  const id = data?.defaultTeam?.id;
  if (!id) {
    throw new Error(
      `Could not resolve the default team of project '${project}'; pass 'team'.`,
    );
  }
  cache.set(project, id);
  return id as string;
}

async function scope(c: any, ctx: any, project?: string, team?: string) {
  const p = c.requireProject(project);
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const t = team ?? await defaultTeamId(c, ctx, p);
  return {
    baseUrl: `${resolveBaseUrl(g)}/${encodeURIComponent(p)}/${
      encodeURIComponent(t)
    }`,
    project: null as null,
    preview: PREVIEW,
  };
}

const WidgetBody = z.object({
  name: z.string().min(1),
  contributionId: z.string().min(1).describe(
    "e.g. 'ms.vss-dashboards-web.Microsoft.VisualStudioOnline.Dashboards.MarkdownWidget'.",
  ),
  position: z.object({ row: z.number().int(), column: z.number().int() }),
  size: z.object({
    rowSpan: z.number().int().min(1),
    columnSpan: z.number().int().min(1),
  }),
  settings: z.string().optional().describe("Widget settings as a JSON string."),
  settingsVersion: z.object({
    major: z.number().int(),
    minor: z.number().int(),
    patch: z.number().int(),
  }).optional(),
}).passthrough();

/** Azure DevOps Dashboards model: team dashboards and their widgets. */
export const model = {
  type: "@adamchubbuck/azure-devops/dashboards",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    dashboards: spec("List of dashboards for a team", ListSchema),
    dashboard: spec("A single dashboard", AnySchema),
    widgets: spec("List of widgets on a dashboard", ListSchema),
    widget: spec("A single widget", AnySchema),
    widgettypes: spec("Available widget types", ListSchema),
  },
  methods: {
    listDashboards: {
      description: "List dashboards of a team.",
      arguments: z.object({ project: ProjectArg, team: teamArg }),
      execute: async (args: { project?: string; team?: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          "dashboard/dashboards",
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "dashboards",
          instanceName(
            "dashboards",
            args.project ?? ctx.globalArgs.project,
            args.team,
          ),
          list,
        );
      },
    },
    getDashboard: {
      description: "Get a dashboard with its widgets.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
      }),
      execute: async (
        args: { project?: string; team?: string; dashboardId: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `dashboard/dashboards/${args.dashboardId}`,
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "dashboard",
          instanceName("dashboard", args.dashboardId),
          data,
        );
      },
    },
    createDashboard: {
      description:
        "DESTRUCTIVE (creates content): create a dashboard for a team. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        name: z.string().min(1),
        description: z.string().optional(),
        refreshInterval: z.number().int().min(0).optional().describe(
          "Auto-refresh interval in minutes (0 = off).",
        ),
        widgets: z.array(WidgetBody).default([]),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          name: string;
          description?: string;
          refreshInterval?: number;
          widgets: unknown[];
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `create dashboard '${args.name}'`);
        const c = clientFrom(ctx);
        const { data } = await c.post<any>(
          "dashboard/dashboards",
          {
            name: args.name,
            description: args.description,
            refreshInterval: args.refreshInterval,
            widgets: args.widgets,
          },
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "dashboard",
          instanceName("dashboard", data?.id ?? args.name),
          data,
        );
      },
    },
    updateDashboard: {
      description:
        "DESTRUCTIVE (replaces content): replace a dashboard definition (name, description, widgets). Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
        name: z.string().min(1),
        description: z.string().optional(),
        refreshInterval: z.number().int().min(0).optional(),
        widgets: z.array(WidgetBody).default([]),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          dashboardId: string;
          name: string;
          description?: string;
          refreshInterval?: number;
          widgets: unknown[];
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `update dashboard ${args.dashboardId}`);
        const c = clientFrom(ctx);
        const { data } = await c.put<any>(
          `dashboard/dashboards/${args.dashboardId}`,
          {
            id: args.dashboardId,
            name: args.name,
            description: args.description,
            refreshInterval: args.refreshInterval,
            widgets: args.widgets,
          },
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "dashboard",
          instanceName("dashboard", args.dashboardId),
          data,
        );
      },
    },
    deleteDashboard: {
      description: "DESTRUCTIVE: delete a dashboard. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          dashboardId: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete dashboard ${args.dashboardId}`);
        const c = clientFrom(ctx);
        await c.delete(
          `dashboard/dashboards/${args.dashboardId}`,
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "dashboard",
          instanceName("dashboard", args.dashboardId),
          { id: args.dashboardId, deleted: true },
        );
      },
    },
    listWidgets: {
      description: "List widgets on a dashboard.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
      }),
      execute: async (
        args: { project?: string; team?: string; dashboardId: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `dashboard/dashboards/${args.dashboardId}/widgets`,
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "widgets",
          instanceName("widgets", args.dashboardId),
          list,
        );
      },
    },
    getWidget: {
      description: "Get one widget on a dashboard.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
        widgetId: widgetArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          dashboardId: string;
          widgetId: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `dashboard/dashboards/${args.dashboardId}/widgets/${args.widgetId}`,
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "widget",
          instanceName("widget", args.dashboardId, args.widgetId),
          data,
        );
      },
    },
    addWidget: {
      description:
        "DESTRUCTIVE (modifies dashboard): add a widget to a dashboard. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
        widget: WidgetBody,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          dashboardId: string;
          widget: Record<string, unknown>;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `add widget to dashboard ${args.dashboardId}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.post<any>(
          `dashboard/dashboards/${args.dashboardId}/widgets`,
          args.widget,
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "widget",
          instanceName(
            "widget",
            args.dashboardId,
            data?.id ?? args.widget.name as string,
          ),
          data,
        );
      },
    },
    updateWidget: {
      description:
        "DESTRUCTIVE (modifies dashboard): replace a widget definition. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
        widgetId: widgetArg,
        widget: WidgetBody,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          dashboardId: string;
          widgetId: string;
          widget: Record<string, unknown>;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `update widget ${args.widgetId}`);
        const c = clientFrom(ctx);
        const { data } = await c.put<any>(
          `dashboard/dashboards/${args.dashboardId}/widgets/${args.widgetId}`,
          { ...args.widget, id: args.widgetId },
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "widget",
          instanceName("widget", args.dashboardId, args.widgetId),
          data,
        );
      },
    },
    deleteWidget: {
      description:
        "DESTRUCTIVE: delete a widget from a dashboard. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        team: teamArg,
        dashboardId: dashArg,
        widgetId: widgetArg,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          team?: string;
          dashboardId: string;
          widgetId: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete widget ${args.widgetId}`);
        const c = clientFrom(ctx);
        await c.delete(
          `dashboard/dashboards/${args.dashboardId}/widgets/${args.widgetId}`,
          await scope(c, ctx, args.project, args.team),
        );
        return emit(
          ctx,
          "widget",
          instanceName("widget", args.dashboardId, args.widgetId),
          { id: args.widgetId, deleted: true },
        );
      },
    },
    listWidgetTypes: {
      description: "List widget types available in the project.",
      arguments: z.object({
        project: ProjectArg,
        scope: z.enum(["collection_User", "project_Team"]).default(
          "project_Team",
        ),
      }),
      execute: async (
        args: { project?: string; scope: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("dashboard/widgettypes", {
          project: c.requireProject(args.project),
          preview: PREVIEW,
          query: { "$scope": args.scope },
        });
        return emit(
          ctx,
          "widgettypes",
          instanceName("widgettypes", args.project ?? ctx.globalArgs.project),
          list,
        );
      },
    },
  },
};
