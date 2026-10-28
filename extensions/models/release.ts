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
  serviceBaseUrl,
} from "./_lib/client.ts";

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const DefinitionSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
}).passthrough();
const ReleaseSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  status: z.string().optional(),
}).passthrough();
const LogSchema = z.object({
  releaseId: z.number(),
  environmentId: z.number(),
  content: z.string(),
});

const defIdArg = z.number().int().positive().describe(
  "Release definition ID.",
);
const relIdArg = z.number().int().positive().describe("Release ID.");
const envIdArg = z.number().int().positive().describe(
  "Release environment (stage instance) ID.",
);

// Release Management lives on the vsrm host and is preview-only at 7.2.
function ctxClient(ctx: any, project?: string) {
  const c = clientFrom(ctx);
  const baseUrl = serviceBaseUrl(
    GlobalArgsSchema.parse(ctx.globalArgs),
    "vsrm",
  );
  return { c, baseUrl, project: c.requireProject(project) };
}

/** Azure DevOps Release model: classic releases, deployments and approvals. */
export const model = {
  type: "@adamchubbuck/azure-devops/release",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    definition: spec("A single release definition", DefinitionSchema),
    definitions: spec("List of release definitions", ListSchema),
    history: spec("Revision history of a release definition", ListSchema),
    release: spec("A single release", ReleaseSchema),
    releases: spec("A page of releases", ListSchema),
    approvals: spec("List of release approvals", ListSchema),
    approval: spec(
      "A single release approval",
      z.object({
        id: z.number().optional(),
        status: z.string().optional(),
        comments: z.string().optional(),
        approvalType: z.string().optional(),
        revision: z.number().optional(),
      }).passthrough(),
    ),
    deployments: spec("List of deployments", ListSchema),
    log: spec("Task log of a release environment", LogSchema),
  },
  methods: {
    listDefinitions: {
      description: "List classic release definitions in a project.",
      arguments: z.object({
        project: ProjectArg,
        searchText: z.string().optional(),
        path: z.string().optional().describe("Folder path, e.g. '\\\\'."),
        expand: z.string().optional().describe(
          "e.g. 'environments,artifacts,triggers'.",
        ),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          project?: string;
          searchText?: string;
          path?: string;
          expand?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const list = await c.list("release/definitions", {
          baseUrl,
          project,
          preview: 4,
          limit: args.limit,
          query: {
            searchText: args.searchText,
            path: args.path,
            $expand: args.expand,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "definitions",
          instanceName("definitions", project),
          list,
        );
      },
    },
    getDefinition: {
      description: "Get one release definition, including its stages.",
      arguments: z.object({ project: ProjectArg, definitionId: defIdArg }),
      execute: async (
        args: { project?: string; definitionId: number },
        ctx: any,
      ) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const { data } = await c.get(
          `release/definitions/${args.definitionId}`,
          { baseUrl, project, preview: 4 },
        );
        return emit(
          ctx,
          "definition",
          instanceName("definition", args.definitionId),
          data,
        );
      },
    },
    getReleaseDefinitionHistory: {
      description: "List the revision history of a release definition.",
      arguments: z.object({ project: ProjectArg, definitionId: defIdArg }),
      execute: async (
        args: { project?: string; definitionId: number },
        ctx: any,
      ) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const list = await c.list(
          `release/definitions/${args.definitionId}/revisions`,
          { baseUrl, project, preview: 2 },
        );
        return emit(
          ctx,
          "history",
          instanceName("history", args.definitionId),
          list,
        );
      },
    },
    listReleases: {
      description:
        "List one page of releases with filters. Pass the returned nextPageToken back as nextPageToken to fetch the next page.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: z.number().int().positive().optional(),
        definitionEnvironmentId: z.number().int().positive().optional(),
        statusFilter: z.enum(["draft", "active", "abandoned", "undefined"])
          .optional(),
        environmentStatusFilter: z.number().int().optional(),
        createdBy: z.string().optional(),
        minCreatedTime: z.string().optional().describe("ISO 8601 date-time."),
        maxCreatedTime: z.string().optional().describe("ISO 8601 date-time."),
        queryOrder: z.enum(["ascending", "descending"]).optional(),
        searchText: z.string().optional(),
        sourceBranchFilter: z.string().optional(),
        expand: z.string().optional().describe(
          "e.g. 'environments,artifacts'.",
        ),
        top: z.number().int().positive().max(1000).default(50),
        nextPageToken: z.string().optional().describe(
          "Cursor returned as nextPageToken by a previous call.",
        ),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const res = await c.get<{ value?: unknown[] }>("release/releases", {
          baseUrl,
          project,
          preview: 8,
          query: {
            definitionId: args.definitionId,
            definitionEnvironmentId: args.definitionEnvironmentId,
            statusFilter: args.statusFilter,
            environmentStatusFilter: args.environmentStatusFilter,
            createdBy: args.createdBy,
            minCreatedTime: args.minCreatedTime,
            maxCreatedTime: args.maxCreatedTime,
            queryOrder: args.queryOrder,
            searchText: args.searchText,
            sourceBranchFilter: args.sourceBranchFilter,
            $expand: args.expand,
            $top: args.top,
            continuationToken: args.nextPageToken,
          },
        });
        const items = (res.data?.value ?? []) as Record<string, unknown>[];
        return emit(
          ctx,
          "releases",
          instanceName("releases", project, args.definitionId),
          {
            count: items.length,
            items,
            nextPageToken: res.continuationToken,
          },
        );
      },
    },
    getRelease: {
      description: "Get one release with its environments and artifacts.",
      arguments: z.object({
        project: ProjectArg,
        releaseId: relIdArg,
        expand: z.string().optional().describe("e.g. 'tags'."),
      }),
      execute: async (
        args: { project?: string; releaseId: number; expand?: string },
        ctx: any,
      ) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const { data } = await c.get(`release/releases/${args.releaseId}`, {
          baseUrl,
          project,
          preview: 8,
          query: { $expand: args.expand },
        });
        return emit(
          ctx,
          "release",
          instanceName("release", args.releaseId),
          data,
        );
      },
    },
    createRelease: {
      description:
        "DESTRUCTIVE (may trigger automatic deployments): create a release from a definition. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: defIdArg,
        description: z.string().optional(),
        artifacts: z.array(z.object({
          alias: z.string().describe("Artifact source alias."),
          versionId: z.string().describe("Artifact version, e.g. a build ID."),
          versionName: z.string().optional(),
        })).default([]).describe("Artifact versions to pin."),
        manualEnvironments: z.array(z.string()).default([]).describe(
          "Stage names that must start manually instead of automatically.",
        ),
        isDraft: z.boolean().default(false),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          definitionId: number;
          description?: string;
          artifacts: {
            alias: string;
            versionId: string;
            versionName?: string;
          }[];
          manualEnvironments: string[];
          isDraft: boolean;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `create a release from definition ${args.definitionId}`,
        );
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const { data } = await c.post<{ id: number }>(
          "release/releases",
          {
            definitionId: args.definitionId,
            description: args.description,
            isDraft: args.isDraft,
            reason: "none",
            manualEnvironments: args.manualEnvironments.length
              ? args.manualEnvironments
              : null,
            artifacts: args.artifacts.map((a) => ({
              alias: a.alias,
              instanceReference: { id: a.versionId, name: a.versionName },
            })),
          },
          { baseUrl, project, preview: 8 },
        );
        return emit(ctx, "release", instanceName("release", data.id), data);
      },
    },
    updateReleaseEnvironment: {
      description:
        "DESTRUCTIVE (can start, cancel or reject a deployment): update the status of a release environment. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        releaseId: relIdArg,
        environmentId: envIdArg,
        status: z.enum([
          "inProgress",
          "canceled",
          "rejected",
          "scheduled",
          "queued",
        ]),
        comment: z.string().optional(),
        scheduledDeploymentTime: z.string().optional().describe(
          "ISO 8601 date-time; used with status 'scheduled'.",
        ),
        variables: z.record(z.string(), z.string()).default({}).describe(
          "Variable overrides for this deployment.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        requireConfirm(
          args.confirm,
          `set environment ${args.environmentId} of release ${args.releaseId} to ${args.status}`,
        );
        return await updateEnvironment(args, ctx);
      },
    },
    startDeployment: {
      description:
        "DESTRUCTIVE (deploys): start deployment of a release environment (status inProgress). Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        releaseId: relIdArg,
        environmentId: envIdArg,
        comment: z.string().optional(),
        variables: z.record(z.string(), z.string()).default({}),
        confirm: ConfirmArg,
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        requireConfirm(
          args.confirm,
          `deploy environment ${args.environmentId} of release ${args.releaseId}`,
        );
        return await updateEnvironment({ ...args, status: "inProgress" }, ctx);
      },
    },
    listApprovals: {
      description: "List release approvals, e.g. pending ones for a release.",
      arguments: z.object({
        project: ProjectArg,
        statusFilter: z.enum([
          "pending",
          "approved",
          "rejected",
          "reassigned",
          "canceled",
          "skipped",
          "undefined",
        ]).default("pending"),
        assignedToFilter: z.string().optional().describe(
          "Display name or unique name of the approver.",
        ),
        releaseIdsFilter: z.array(z.number().int()).default([]),
        typeFilter: z.enum(["preDeploy", "postDeploy", "undefined"]).optional(),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          project?: string;
          statusFilter: string;
          assignedToFilter?: string;
          releaseIdsFilter: number[];
          typeFilter?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const list = await c.list("release/approvals", {
          baseUrl,
          project,
          preview: 3,
          limit: args.limit,
          query: {
            statusFilter: args.statusFilter,
            assignedToFilter: args.assignedToFilter,
            releaseIdsFilter: args.releaseIdsFilter.join(","),
            typeFilter: args.typeFilter,
            top: Math.min(args.limit, 1000),
          },
        });
        return emit(ctx, "approvals", instanceName("approvals", project), list);
      },
    },
    updateApproval: {
      description:
        "DESTRUCTIVE (approving lets a deployment proceed): approve or reject a release approval with a comment. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        approvalId: z.number().int().positive(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().optional(),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          approvalId: number;
          decision: "approved" | "rejected";
          comment?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `${
            args.decision === "approved" ? "approve" : "reject"
          } approval ${args.approvalId}`,
        );
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const { data } = await c.patch(
          `release/approvals/${args.approvalId}`,
          { status: args.decision, comment: args.comment },
          { baseUrl, project, preview: 3 },
        );
        return emit(
          ctx,
          "approval",
          instanceName("approval", args.approvalId),
          data,
        );
      },
    },
    getReleaseLog: {
      description: "Get the log text of one task in a release environment.",
      arguments: z.object({
        project: ProjectArg,
        releaseId: relIdArg,
        environmentId: envIdArg,
        releasePhaseId: z.number().int().positive().describe(
          "Deploy phase ID (releaseDeployPhases[].id).",
        ),
        taskId: z.number().int().positive().describe(
          "Task ID (deploymentJobs[].tasks[].id).",
        ),
        startLine: z.number().int().min(0).optional(),
        endLine: z.number().int().min(0).optional(),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const { data } = await c.get<string>(
          `release/releases/${args.releaseId}/environments/${args.environmentId}/deployPhases/${args.releasePhaseId}/tasks/${args.taskId}/logs`,
          {
            baseUrl,
            project,
            preview: 2,
            text: true,
            query: {
              startLine: args.startLine,
              endLine: args.endLine,
            },
          },
        );
        return emit(
          ctx,
          "log",
          instanceName(
            "log",
            args.releaseId,
            args.environmentId,
            args.releasePhaseId,
            args.taskId,
          ),
          {
            releaseId: args.releaseId,
            environmentId: args.environmentId,
            content: data ?? "",
          },
        );
      },
    },
    listDeployments: {
      description: "List deployments, optionally for one definition or stage.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: z.number().int().positive().optional(),
        definitionEnvironmentId: z.number().int().positive().optional(),
        deploymentStatus: z.enum([
          "all",
          "failed",
          "notDeployed",
          "partiallySucceeded",
          "succeeded",
          "undefined",
        ]).optional(),
        operationStatus: z.string().optional().describe(
          "e.g. 'QueuedForAgent', 'Approved'.",
        ),
        minStartedTime: z.string().optional().describe("ISO 8601 date-time."),
        maxStartedTime: z.string().optional().describe("ISO 8601 date-time."),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const list = await c.list("release/deployments", {
          baseUrl,
          project,
          preview: 2,
          limit: args.limit,
          query: {
            definitionId: args.definitionId,
            definitionEnvironmentId: args.definitionEnvironmentId,
            deploymentStatus: args.deploymentStatus,
            operationStatus: args.operationStatus,
            minStartedTime: args.minStartedTime,
            maxStartedTime: args.maxStartedTime,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "deployments",
          instanceName("deployments", project, args.definitionId),
          list,
        );
      },
    },
    abandonRelease: {
      description:
        "DESTRUCTIVE: abandon a release so it can no longer be deployed. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        releaseId: relIdArg,
        comment: z.string().optional(),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          releaseId: number;
          comment?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `abandon release ${args.releaseId}`);
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        const { data } = await c.patch(
          `release/releases/${args.releaseId}`,
          { status: "abandoned", comment: args.comment },
          { baseUrl, project, preview: 8 },
        );
        return emit(
          ctx,
          "release",
          instanceName("release", args.releaseId),
          data,
        );
      },
    },
    deleteDefinition: {
      description:
        "DESTRUCTIVE: permanently delete a release definition. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        definitionId: defIdArg,
        comment: z.string().optional(),
        forceDelete: z.boolean().default(false).describe(
          "Also delete when releases still exist.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          definitionId: number;
          comment?: string;
          forceDelete: boolean;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `delete release definition ${args.definitionId}`,
        );
        const { c, baseUrl, project } = ctxClient(ctx, args.project);
        await c.delete(`release/definitions/${args.definitionId}`, {
          baseUrl,
          project,
          preview: 4,
          query: {
            comment: args.comment,
            forceDelete: args.forceDelete ? "true" : undefined,
          },
        });
        return emit(
          ctx,
          "definition",
          instanceName("definition", args.definitionId),
          { id: args.definitionId, deleted: true },
        );
      },
    },
  },
};

async function updateEnvironment(args: Record<string, any>, ctx: any) {
  const { c, baseUrl, project } = ctxClient(ctx, args.project);
  const variables = Object.fromEntries(
    Object.entries(args.variables ?? {}).map(([k, value]) => [k, { value }]),
  );
  const { data } = await c.patch(
    `release/releases/${args.releaseId}/environments/${args.environmentId}`,
    {
      status: args.status,
      comment: args.comment,
      scheduledDeploymentTime: args.scheduledDeploymentTime,
      variables,
    },
    { baseUrl, project, preview: 7 },
  );
  return emit(
    ctx,
    "release",
    instanceName("release", args.releaseId, "env", args.environmentId),
    data ?? { id: args.releaseId },
  );
}
