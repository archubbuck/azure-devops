// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4";
import {
  clientFrom,
  ConfirmArg,
  emit,
  GlobalArgsSchema,
  instanceName,
  ListSchema,
  requireConfirm,
} from "./_lib/client.ts";

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  state: z.string().optional(),
  visibility: z.string().optional(),
}).passthrough();

const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  projectId: z.string().optional(),
}).passthrough();

const ResultSchema = z.object({
  operation: z.string(),
  target: z.string(),
  status: z.string(),
  detail: z.unknown().optional(),
}).passthrough();

const proj = z.string().describe("Project name or ID (e.g. 'my-project').");

export const behavior = {
  type: "@adamchubbuck/azure-devops/core",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    project: {
      description: "A single project",
      schema: ProjectSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    projects: {
      description: "List of projects",
      schema: ListSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    team: {
      description: "A single team",
      schema: TeamSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    teams: {
      description: "List of teams or team members",
      schema: ListSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    result: {
      description: "Outcome of a write operation",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listProjects: {
      description:
        "List all projects in the organization, following continuation tokens.",
      arguments: z.object({
        stateFilter: z.enum(["all", "wellFormed", "createPending", "deleted"])
          .default("wellFormed").describe("Filter by project state."),
        limit: z.number().int().positive().optional().describe(
          "Stop after this many projects.",
        ),
      }),
      execute: async (
        args: { stateFilter: string; limit?: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("projects", {
          project: null,
          limit: args.limit,
          query: { stateFilter: args.stateFilter, $top: 100 },
        });
        return emit(ctx, "projects", "projects", list);
      },
    },
    getProject: {
      description:
        "Get one project by name or ID, optionally with capabilities.",
      arguments: z.object({
        project: proj,
        includeCapabilities: z.boolean().default(false),
      }),
      execute: async (
        args: { project: string; includeCapabilities: boolean },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `projects/${encodeURIComponent(args.project)}`,
          {
            project: null,
            query: {
              includeCapabilities: args.includeCapabilities || undefined,
            },
          },
        );
        return emit(
          ctx,
          "project",
          instanceName("project", args.project),
          data,
        );
      },
    },
    createProject: {
      description:
        "Queue creation of a new project. Project creation is asynchronous; the result holds the operation reference.",
      arguments: z.object({
        name: z.string().describe("New project name (e.g. 'my-project')."),
        description: z.string().optional(),
        visibility: z.enum(["private", "public"]).default("private"),
        sourceControlType: z.enum(["Git", "Tfvc"]).default("Git"),
        processTemplateId: z.string().optional().describe(
          "Process template ID. Defaults to the organization's default process.",
        ),
      }),
      execute: async (
        args: {
          name: string;
          description?: string;
          visibility: string;
          sourceControlType: string;
          processTemplateId?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const body = {
          name: args.name,
          description: args.description,
          visibility: args.visibility === "public" ? 1 : 0,
          capabilities: {
            versioncontrol: { sourceControlType: args.sourceControlType },
            processTemplate: args.processTemplateId
              ? { templateTypeId: args.processTemplateId }
              : undefined,
          },
        };
        const { data } = await c.post<Record<string, unknown>>(
          "projects",
          body,
          {
            project: null,
          },
        );
        return emit(ctx, "result", instanceName("create-project", args.name), {
          operation: "createProject",
          target: args.name,
          status: String(data?.status ?? "queued"),
          detail: data,
        });
      },
    },
    deleteProject: {
      description:
        "DESTRUCTIVE: delete a project and all of its data. Requires confirm: true.",
      arguments: z.object({
        projectId: z.string().describe("Project ID (GUID)."),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { projectId: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete project ${args.projectId}`);
        const c = clientFrom(ctx);
        const { data } = await c.delete<Record<string, unknown>>(
          `projects/${encodeURIComponent(args.projectId)}`,
          { project: null },
        );
        return emit(
          ctx,
          "result",
          instanceName("delete-project", args.projectId),
          {
            operation: "deleteProject",
            target: args.projectId,
            status: String(data?.status ?? "queued"),
            detail: data,
          },
        );
      },
    },
    listTeams: {
      description:
        "List teams. With a project, lists that project's teams; without, lists every team the caller can see in the organization.",
      arguments: z.object({
        project: z.string().optional().describe(
          "Project name or ID. Omit to list teams across the whole organization.",
        ),
        mine: z.boolean().default(false).describe(
          "Only teams the caller belongs to.",
        ),
        limit: z.number().int().positive().optional(),
      }),
      execute: async (
        args: { project?: string; mine: boolean; limit?: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const project = args.project ?? ctx.globalArgs.project;
        const path = project
          ? `projects/${encodeURIComponent(project)}/teams`
          : "teams";
        const list = await c.list(path, {
          project: null,
          preview: 3,
          limit: args.limit,
          query: { $mine: args.mine || undefined, $top: 100 },
        });
        return emit(ctx, "teams", instanceName("teams", project), list);
      },
    },
    getTeam: {
      description: "Get one team by name or ID within a project.",
      arguments: z.object({
        project: proj,
        team: z.string().describe("Team name or ID."),
        expandIdentity: z.boolean().default(false),
      }),
      execute: async (
        args: { project: string; team: string; expandIdentity: boolean },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `projects/${encodeURIComponent(args.project)}/teams/${
            encodeURIComponent(args.team)
          }`,
          {
            project: null,
            preview: 3,
            query: { $expandIdentity: args.expandIdentity || undefined },
          },
        );
        return emit(
          ctx,
          "team",
          instanceName("team", args.project, args.team),
          data,
        );
      },
    },
    listTeamMembers: {
      description: "List the members of a team.",
      arguments: z.object({
        project: proj,
        team: z.string().describe("Team name or ID."),
        limit: z.number().int().positive().optional(),
      }),
      execute: async (
        args: { project: string; team: string; limit?: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `projects/${encodeURIComponent(args.project)}/teams/${
            encodeURIComponent(args.team)
          }/members`,
          {
            project: null,
            preview: 3,
            limit: args.limit,
            query: { $top: 100 },
          },
        );
        return emit(
          ctx,
          "teams",
          instanceName("members", args.project, args.team),
          list,
        );
      },
    },
    createTeam: {
      description: "Create a team in a project.",
      arguments: z.object({
        project: proj,
        name: z.string().describe("Team name (e.g. 'my-team')."),
        description: z.string().optional(),
      }),
      execute: async (
        args: { project: string; name: string; description?: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post(
          `projects/${encodeURIComponent(args.project)}/teams`,
          { name: args.name, description: args.description },
          { project: null, preview: 3 },
        );
        return emit(
          ctx,
          "team",
          instanceName("team", args.project, args.name),
          data,
        );
      },
    },
    updateTeam: {
      description: "Rename a team or change its description.",
      arguments: z.object({
        project: proj,
        team: z.string().describe("Current team name or ID."),
        name: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async (
        args: {
          project: string;
          team: string;
          name?: string;
          description?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.patch(
          `projects/${encodeURIComponent(args.project)}/teams/${
            encodeURIComponent(args.team)
          }`,
          { name: args.name, description: args.description },
          { project: null, preview: 3 },
        );
        return emit(
          ctx,
          "team",
          instanceName("team", args.project, args.team),
          data,
        );
      },
    },
    deleteTeam: {
      description: "DESTRUCTIVE: delete a team. Requires confirm: true.",
      arguments: z.object({
        project: proj,
        team: z.string().describe("Team name or ID."),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { project: string; team: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete team ${args.team}`);
        const c = clientFrom(ctx);
        await c.delete(
          `projects/${encodeURIComponent(args.project)}/teams/${
            encodeURIComponent(args.team)
          }`,
          { project: null, preview: 3 },
        );
        return emit(
          ctx,
          "result",
          instanceName("delete-team", args.project, args.team),
          {
            operation: "deleteTeam",
            target: `${args.project}/${args.team}`,
            status: "deleted",
          },
        );
      },
    },
  },
};
