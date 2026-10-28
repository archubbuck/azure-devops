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
} from "./_lib/client.ts";

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const DefinitionSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string().optional(),
}).passthrough();
const BuildSchema = z.object({
  id: z.number(),
  buildNumber: z.string().optional(),
  status: z.string().optional(),
  result: z.string().optional(),
  sourceBranch: z.string().optional(),
}).passthrough();
const ResultSchema = z.object({
  operation: z.string(),
  target: z.string(),
  status: z.string(),
  detail: z.unknown().optional(),
}).passthrough();

const buildArg = z.number().int().positive().describe("Build ID.");
const limitArg = z.number().int().positive().default(100).describe(
  "Maximum items to return.",
);

/** Azure DevOps Build model: builds, build definitions, logs and artifacts. */
export const model = {
  type: "@adamchubbuck/azure-devops/build",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    definition: spec("A single build definition", DefinitionSchema),
    definitions: spec("List of build definitions", ListSchema),
    build: spec("A single build", BuildSchema),
    builds: spec("List of builds", ListSchema),
    logs: spec("Log index of a build", ListSchema),
    artifacts: spec("Artifacts of a build", ListSchema),
    result: spec("Outcome of a write operation", ResultSchema),
  },
  files: {
    log: {
      description: "Plain text build log",
      contentType: "text/plain",
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    listDefinitions: {
      description:
        "List build definitions, optionally filtered by name or folder path.",
      arguments: z.object({
        project: ProjectArg,
        name: z.string().optional().describe(
          "Name filter; '*' wildcards allowed.",
        ),
        path: z.string().optional().describe(
          "Folder path, e.g. '\\\\my-folder'.",
        ),
        limit: limitArg,
      }),
      execute: async (
        args: { project?: string; name?: string; path?: string; limit: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("build/definitions", {
          project: c.requireProject(args.project),
          limit: args.limit,
          query: {
            name: args.name,
            path: args.path,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "definitions",
          instanceName("definitions", args.project ?? ctx.globalArgs.project),
          list,
        );
      },
    },
    getDefinition: {
      description:
        "Get one build definition, including its process and triggers.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: z.number().int().positive(),
        revision: z.number().int().positive().optional(),
      }),
      execute: async (
        args: { project?: string; definitionId: number; revision?: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`build/definitions/${args.definitionId}`, {
          project: c.requireProject(args.project),
          query: { revision: args.revision },
        });
        return emit(
          ctx,
          "definition",
          instanceName("definition", args.definitionId),
          data,
        );
      },
    },
    deleteDefinition: {
      description:
        "DESTRUCTIVE: delete a build definition and its builds. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: z.number().int().positive(),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { project?: string; definitionId: number; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `delete build definition ${args.definitionId}`,
        );
        const c = clientFrom(ctx);
        await c.delete(`build/definitions/${args.definitionId}`, {
          project: c.requireProject(args.project),
        });
        return emit(
          ctx,
          "result",
          instanceName("delete-definition", args.definitionId),
          {
            operation: "deleteDefinition",
            target: String(args.definitionId),
            status: "deleted",
          },
        );
      },
    },
    listBuilds: {
      description:
        "List builds, filtered by definition, branch, status or result.",
      arguments: z.object({
        project: ProjectArg,
        definitionIds: z.array(z.number().int()).default([]),
        branch: z.string().optional().describe("e.g. 'main'."),
        statusFilter: z.enum([
          "all",
          "cancelling",
          "completed",
          "inProgress",
          "none",
          "notStarted",
          "postponed",
        ]).optional(),
        resultFilter: z.enum([
          "canceled",
          "failed",
          "none",
          "partiallySucceeded",
          "succeeded",
        ]).optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          definitionIds: number[];
          branch?: string;
          statusFilter?: string;
          resultFilter?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("build/builds", {
          project: c.requireProject(args.project),
          limit: args.limit,
          query: {
            definitions: args.definitionIds.join(",") || undefined,
            branchName: args.branch
              ? (args.branch.startsWith("refs/")
                ? args.branch
                : `refs/heads/${args.branch}`)
              : undefined,
            statusFilter: args.statusFilter,
            resultFilter: args.resultFilter,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "builds",
          instanceName("builds", args.project ?? ctx.globalArgs.project),
          list,
        );
      },
    },
    getBuild: {
      description: "Get one build by ID.",
      arguments: z.object({ project: ProjectArg, buildId: buildArg }),
      execute: async (
        args: { project?: string; buildId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`build/builds/${args.buildId}`, {
          project: c.requireProject(args.project),
        });
        return emit(ctx, "build", instanceName("build", args.buildId), data);
      },
    },
    queueBuild: {
      description:
        "DESTRUCTIVE (starts work and may deploy): queue a new build of a definition. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: z.number().int().positive(),
        branch: z.string().optional().describe(
          "e.g. 'main'. Defaults to the definition's default branch.",
        ),
        parameters: z.record(z.string(), z.string()).default({}).describe(
          "Queue-time variables.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          definitionId: number;
          branch?: string;
          parameters: Record<string, string>;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `queue a build of definition ${args.definitionId}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.post<{ id: number }>("build/builds", {
          definition: { id: args.definitionId },
          sourceBranch: args.branch
            ? (args.branch.startsWith("refs/")
              ? args.branch
              : `refs/heads/${args.branch}`)
            : undefined,
          parameters: Object.keys(args.parameters).length
            ? JSON.stringify(args.parameters)
            : undefined,
        }, { project: c.requireProject(args.project) });
        return emit(ctx, "build", instanceName("build", data.id), data);
      },
    },
    cancelBuild: {
      description:
        "DESTRUCTIVE: cancel a running build. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        buildId: buildArg,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { project?: string; buildId: number; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `cancel build ${args.buildId}`);
        const c = clientFrom(ctx);
        const { data } = await c.patch(`build/builds/${args.buildId}`, {
          status: "cancelling",
        }, { project: c.requireProject(args.project) });
        return emit(ctx, "build", instanceName("build", args.buildId), data);
      },
    },
    listLogs: {
      description: "List the log files of a build.",
      arguments: z.object({ project: ProjectArg, buildId: buildArg }),
      execute: async (
        args: { project?: string; buildId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`build/builds/${args.buildId}/logs`, {
          project: c.requireProject(args.project),
        });
        return emit(ctx, "logs", instanceName("logs", args.buildId), list);
      },
    },
    getLog: {
      description:
        "Download one build log as a text file (optionally a line range).",
      arguments: z.object({
        project: ProjectArg,
        buildId: buildArg,
        logId: z.number().int().positive(),
        startLine: z.number().int().min(0).optional(),
        endLine: z.number().int().min(0).optional(),
      }),
      execute: async (
        args: {
          project?: string;
          buildId: number;
          logId: number;
          startLine?: number;
          endLine?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get<string>(
          `build/builds/${args.buildId}/logs/${args.logId}`,
          {
            project: c.requireProject(args.project),
            text: true,
            query: { startLine: args.startLine, endLine: args.endLine },
          },
        );
        const writer = ctx.createFileWriter(
          "log",
          instanceName("log", args.buildId, args.logId),
        );
        const handle = await writer.writeText(data);
        return { dataHandles: [handle] };
      },
    },
    listArtifacts: {
      description: "List artifacts published by a build.",
      arguments: z.object({ project: ProjectArg, buildId: buildArg }),
      execute: async (
        args: { project?: string; buildId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`build/builds/${args.buildId}/artifacts`, {
          project: c.requireProject(args.project),
        });
        return emit(
          ctx,
          "artifacts",
          instanceName("artifacts", args.buildId),
          list,
        );
      },
    },
  },
};
