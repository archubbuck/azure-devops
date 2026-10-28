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

const PipelineSchema = z.object({
  id: z.number(),
  name: z.string(),
  folder: z.string().optional(),
}).passthrough();
const RunSchema = z.object({
  id: z.number(),
  state: z.string().optional(),
  result: z.string().optional(),
}).passthrough();

const idArg = z.number().int().positive().describe("Pipeline ID.");
const runArg = z.number().int().positive().describe("Run ID.");

export const behavior = {
  type: "@adamchubbuck/azure-devops/pipelines",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pipeline: spec("A single pipeline", PipelineSchema),
    pipelines: spec("List of pipelines", ListSchema),
    run: spec("A single pipeline run", RunSchema),
    runs: spec("List of pipeline runs", ListSchema),
    logs: spec("Log index of a pipeline run", ListSchema),
  },
  methods: {
    listPipelines: {
      description: "List YAML and classic pipelines in a project.",
      arguments: z.object({
        project: ProjectArg,
        orderBy: z.string().optional().describe("e.g. 'name asc'."),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: { project?: string; orderBy?: string; limit: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("pipelines", {
          project: c.requireProject(args.project),
          preview: 1,
          limit: args.limit,
          query: { orderBy: args.orderBy, $top: Math.min(args.limit, 1000) },
        });
        return emit(
          ctx,
          "pipelines",
          instanceName("pipelines", args.project ?? ctx.globalArgs.project),
          list,
        );
      },
    },
    getPipeline: {
      description: "Get one pipeline by ID.",
      arguments: z.object({
        project: ProjectArg,
        pipelineId: idArg,
        pipelineVersion: z.number().int().positive().optional(),
      }),
      execute: async (
        args: {
          project?: string;
          pipelineId: number;
          pipelineVersion?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`pipelines/${args.pipelineId}`, {
          project: c.requireProject(args.project),
          preview: 1,
          query: { pipelineVersion: args.pipelineVersion },
        });
        return emit(
          ctx,
          "pipeline",
          instanceName("pipeline", args.pipelineId),
          data,
        );
      },
    },
    listRuns: {
      description: "List runs of a pipeline, newest first.",
      arguments: z.object({ project: ProjectArg, pipelineId: idArg }),
      execute: async (
        args: { project?: string; pipelineId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`pipelines/${args.pipelineId}/runs`, {
          project: c.requireProject(args.project),
          preview: 1,
        });
        return emit(ctx, "runs", instanceName("runs", args.pipelineId), list);
      },
    },
    getRun: {
      description: "Get one pipeline run with its state, result and resources.",
      arguments: z.object({
        project: ProjectArg,
        pipelineId: idArg,
        runId: runArg,
      }),
      execute: async (
        args: { project?: string; pipelineId: number; runId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `pipelines/${args.pipelineId}/runs/${args.runId}`,
          { project: c.requireProject(args.project), preview: 1 },
        );
        return emit(
          ctx,
          "run",
          instanceName("run", args.pipelineId, args.runId),
          data,
        );
      },
    },
    runPipeline: {
      description:
        "DESTRUCTIVE (starts work and may deploy): queue a new run of a pipeline. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        pipelineId: idArg,
        branch: z.string().optional().describe("e.g. 'main'."),
        templateParameters: z.record(z.string(), z.string()).default({}),
        variables: z.record(z.string(), z.string()).default({}),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          pipelineId: number;
          branch?: string;
          templateParameters: Record<string, string>;
          variables: Record<string, string>;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `run pipeline ${args.pipelineId}`);
        const c = clientFrom(ctx);
        const variables = Object.fromEntries(
          Object.entries(args.variables).map(([k, value]) => [k, { value }]),
        );
        const { data } = await c.post<{ id: number }>(
          `pipelines/${args.pipelineId}/runs`,
          {
            resources: args.branch
              ? {
                repositories: {
                  self: {
                    refName: args.branch.startsWith("refs/")
                      ? args.branch
                      : `refs/heads/${args.branch}`,
                  },
                },
              }
              : undefined,
            templateParameters: args.templateParameters,
            variables,
          },
          { project: c.requireProject(args.project), preview: 1 },
        );
        return emit(
          ctx,
          "run",
          instanceName("run", args.pipelineId, data.id),
          data,
        );
      },
    },
    listRunLogs: {
      description:
        "List log files of a pipeline run, with signed download URLs.",
      arguments: z.object({
        project: ProjectArg,
        pipelineId: idArg,
        runId: runArg,
      }),
      execute: async (
        args: { project?: string; pipelineId: number; runId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get<{ logs?: unknown[] }>(
          `pipelines/${args.pipelineId}/runs/${args.runId}/logs`,
          {
            project: c.requireProject(args.project),
            preview: 1,
            query: { $expand: "signedContent" },
          },
        );
        const items = (data?.logs ?? []) as Record<string, unknown>[];
        return emit(
          ctx,
          "logs",
          instanceName("logs", args.pipelineId, args.runId),
          {
            count: items.length,
            items,
          },
        );
      },
    },
  },
};
