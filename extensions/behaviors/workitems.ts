// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4";
import {
  AdoClient,
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

const PATCH = "application/json-patch+json";
/** Azure DevOps caps ids per work item batch request at 200. */
const BATCH_LIMIT = 200;

const WorkItemSchema = z.object({
  id: z.number(),
  rev: z.number().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const LooseSchema = z.record(z.string(), z.unknown());
const WiqlSchema = z.object({
  count: z.number(),
  ids: z.array(z.number()),
  items: z.array(z.record(z.string(), z.unknown())),
  queryType: z.string().optional(),
  asOf: z.string().optional(),
});

const idArg = z.number().int().positive().describe("Work item ID.");
const fieldsArg = z.array(z.string()).optional().describe(
  "Field reference names to return, e.g. ['System.Title','System.State'].",
);
const expandArg = z.enum(["None", "Relations", "Fields", "Links", "All"])
  .optional().describe("$expand option.");
const patchOp = z.object({
  op: z.enum(["add", "replace", "remove", "test", "copy", "move"]),
  path: z.string().describe("e.g. '/fields/System.Title'."),
  value: z.unknown().optional(),
  from: z.string().optional(),
});
type PatchOp = z.infer<typeof patchOp>;

const fieldOps = (fields: Record<string, unknown>): PatchOp[] =>
  Object.entries(fields).map(([k, value]) => ({
    op: "add" as const,
    path: `/fields/${k}`,
    value,
  }));

async function fetchBatch(
  c: AdoClient,
  ids: number[],
  o: { project?: string; fields?: string[]; expand?: string; asOf?: string },
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const chunk = ids.slice(i, i + BATCH_LIMIT);
    const { data } = await c.get<{ value?: Record<string, unknown>[] }>(
      "wit/workitems",
      {
        project: o.project,
        query: {
          ids: chunk.join(","),
          fields: o.fields?.join(","),
          $expand: o.expand,
          asOf: o.asOf,
        },
      },
    );
    out.push(...(data?.value ?? []));
  }
  return out;
}

export const behavior = {
  type: "@adamchubbuck/azure-devops/workitems",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    workitem: spec("A single work item", WorkItemSchema),
    workitems: spec("List of work items", ListSchema),
    wiql: spec("WIQL query result (ids and optional work items)", WiqlSchema),
    query: spec("A saved query or query folder", LooseSchema),
    queries: spec("List of saved queries/folders", ListSchema),
    workitemtype: spec("A work item type definition", LooseSchema),
    workitemtypes: spec("List of work item types", ListSchema),
    fields: spec("List of work item fields", ListSchema),
    comments: spec("Comments of a work item", ListSchema),
    comment: spec("A work item comment", LooseSchema),
    revisions: spec("Revisions of a work item", ListSchema),
    updates: spec("Updates of a work item", ListSchema),
    classification: spec("Area/iteration classification tree", LooseSchema),
    tags: spec("List of work item tags", ListSchema),
  },
  methods: {
    getWorkItem: {
      description: "Get one work item by ID.",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        fields: fieldsArg,
        expand: expandArg,
        asOf: z.string().optional().describe("ISO date for a historic view."),
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          fields?: string[];
          expand?: string;
          asOf?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`wit/workitems/${args.id}`, {
          project: args.project,
          query: {
            fields: args.fields?.join(","),
            $expand: args.expand,
            asOf: args.asOf,
          },
        });
        return emit(ctx, "workitem", instanceName("workitem", args.id), data);
      },
    },
    getWorkItems: {
      description:
        "Get many work items by ID. IDs are fetched in chunks of 200 (the API limit).",
      arguments: z.object({
        project: ProjectArg,
        ids: z.array(z.number().int().positive()).min(1),
        fields: fieldsArg,
        expand: expandArg,
      }),
      execute: async (
        args: {
          project?: string;
          ids: number[];
          fields?: string[];
          expand?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const items = await fetchBatch(c, args.ids, args);
        return emit(
          ctx,
          "workitems",
          instanceName("workitems", args.ids[0], args.ids.length),
          { count: items.length, items },
        );
      },
    },
    createWorkItem: {
      description:
        "Create a work item of the given type (e.g. 'Bug', 'User Story') from a field record.",
      arguments: z.object({
        project: ProjectArg,
        type: z.string().min(1).describe("Work item type name."),
        fields: z.record(z.string(), z.unknown()).describe(
          "Field reference name -> value, e.g. {'System.Title': 'Fix it'}.",
        ),
        validateOnly: z.boolean().default(false),
        bypassRules: z.boolean().default(false),
        suppressNotifications: z.boolean().default(false),
      }),
      execute: async (
        args: {
          project?: string;
          type: string;
          fields: Record<string, unknown>;
          validateOnly: boolean;
          bypassRules: boolean;
          suppressNotifications: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post<{ id?: number }>(
          `wit/workitems/$${encodeURIComponent(args.type)}`,
          fieldOps(args.fields),
          {
            project: c.requireProject(args.project),
            contentType: PATCH,
            query: {
              validateOnly: args.validateOnly || undefined,
              bypassRules: args.bypassRules || undefined,
              suppressNotifications: args.suppressNotifications || undefined,
            },
          },
        );
        return emit(
          ctx,
          "workitem",
          instanceName("workitem", data?.id ?? "validated"),
          data,
        );
      },
    },
    updateWorkItem: {
      description:
        "Update a work item with JSON Patch operations (add/replace/remove/test).",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        operations: z.array(patchOp).min(1),
        validateOnly: z.boolean().default(false),
        bypassRules: z.boolean().default(false),
        suppressNotifications: z.boolean().default(false),
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          operations: PatchOp[];
          validateOnly: boolean;
          bypassRules: boolean;
          suppressNotifications: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.patch(
          `wit/workitems/${args.id}`,
          args.operations,
          {
            project: args.project,
            contentType: PATCH,
            query: {
              validateOnly: args.validateOnly || undefined,
              bypassRules: args.bypassRules || undefined,
              suppressNotifications: args.suppressNotifications || undefined,
            },
          },
        );
        return emit(ctx, "workitem", instanceName("workitem", args.id), data);
      },
    },
    deleteWorkItem: {
      description:
        "DESTRUCTIVE: delete a work item (recycle bin) or permanently destroy it with destroy: true. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        destroy: z.boolean().default(false).describe(
          "Permanently destroy instead of moving to the recycle bin.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          destroy: boolean;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `${args.destroy ? "destroy" : "delete"} work item ${args.id}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.delete(`wit/workitems/${args.id}`, {
          project: args.project,
          query: { destroy: args.destroy ? true : undefined },
        });
        return emit(
          ctx,
          "workitem",
          instanceName("workitem", args.id, "deleted"),
          { id: args.id, destroyed: args.destroy, ...(data as object ?? {}) },
        );
      },
    },
    runWiql: {
      description:
        "Run a WIQL query (read-only). Returns ids; set hydrate: true to also fetch the work items (in chunks of 200).",
      arguments: z.object({
        project: ProjectArg,
        query: z.string().min(1).describe("WIQL, e.g. 'SELECT [System.Id] ..."),
        top: z.number().int().positive().optional().describe(
          "Maximum rows (server default limit is 20000).",
        ),
        hydrate: z.boolean().default(false),
        fields: fieldsArg,
      }),
      execute: async (
        args: {
          project?: string;
          query: string;
          top?: number;
          hydrate: boolean;
          fields?: string[];
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const { data } = await c.post<any>(
          "wit/wiql",
          { query: args.query },
          { project, query: { $top: args.top } },
        );
        const ids: number[] = (data?.workItems ?? []).map((w: any) => w.id);
        const items = args.hydrate && ids.length
          ? await fetchBatch(c, ids, { project, fields: args.fields })
          : [];
        return emit(ctx, "wiql", instanceName("wiql", project, ids.length), {
          count: ids.length,
          ids,
          items,
          queryType: data?.queryType,
          asOf: data?.asOf,
        });
      },
    },
    getQuery: {
      description: "Get a saved query or folder by ID or path.",
      arguments: z.object({
        project: ProjectArg,
        queryIdOrPath: z.string().min(1).describe(
          "Query GUID or path, e.g. 'Shared Queries/My Query'.",
        ),
        depth: z.number().int().min(0).max(2).optional(),
        expand: z.enum(["None", "Wiql", "Clauses", "All", "Minimal"])
          .optional(),
      }),
      execute: async (
        args: {
          project?: string;
          queryIdOrPath: string;
          depth?: number;
          expand?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `wit/queries/${encodeURIComponent(args.queryIdOrPath)}`,
          {
            project: c.requireProject(args.project),
            query: { $depth: args.depth, $expand: args.expand },
          },
        );
        return emit(
          ctx,
          "query",
          instanceName("query", args.queryIdOrPath),
          data,
        );
      },
    },
    listQueries: {
      description: "List the saved query and folder tree (My/Shared Queries).",
      arguments: z.object({
        project: ProjectArg,
        depth: z.number().int().min(0).max(2).default(1),
        expand: z.enum(["None", "Wiql", "Clauses", "All", "Minimal"])
          .optional(),
        includeDeleted: z.boolean().default(false),
      }),
      execute: async (
        args: {
          project?: string;
          depth: number;
          expand?: string;
          includeDeleted: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const list = await c.list("wit/queries", {
          project,
          query: {
            $depth: args.depth,
            $expand: args.expand,
            $includeDeleted: args.includeDeleted || undefined,
          },
        });
        return emit(ctx, "queries", instanceName("queries", project), list);
      },
    },
    listWorkItemTypes: {
      description: "List work item types of a project.",
      arguments: z.object({ project: ProjectArg }),
      execute: async (args: { project?: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const list = await c.list("wit/workitemtypes", { project });
        return emit(
          ctx,
          "workitemtypes",
          instanceName("workitemtypes", project),
          list,
        );
      },
    },
    getWorkItemType: {
      description: "Get one work item type (states, fields, transitions).",
      arguments: z.object({
        project: ProjectArg,
        type: z.string().min(1).describe("e.g. 'Bug'."),
      }),
      execute: async (args: { project?: string; type: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `wit/workitemtypes/${encodeURIComponent(args.type)}`,
          { project: c.requireProject(args.project) },
        );
        return emit(
          ctx,
          "workitemtype",
          instanceName("workitemtype", args.type),
          data,
        );
      },
    },
    listFields: {
      description:
        "List work item fields (project-scoped when a project is set).",
      arguments: z.object({
        project: ProjectArg,
        expand: z.enum(["None", "ExtensionFields"]).optional(),
      }),
      execute: async (
        args: { project?: string; expand?: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("wit/fields", {
          project: args.project,
          query: { $expand: args.expand },
        });
        return emit(
          ctx,
          "fields",
          instanceName("fields", args.project ?? ctx.globalArgs.project),
          list,
        );
      },
    },
    listComments: {
      description: "List comments of a work item (7.2-preview.4).",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        top: z.number().int().positive().max(200).default(100),
        order: z.enum(["asc", "desc"]).optional(),
        includeDeleted: z.boolean().default(false),
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          top: number;
          order?: string;
          includeDeleted: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get<{ comments?: any[]; totalCount?: number }>(
          `wit/workItems/${args.id}/comments`,
          {
            project: c.requireProject(args.project),
            preview: 4,
            query: {
              $top: args.top,
              order: args.order,
              includeDeleted: args.includeDeleted || undefined,
            },
          },
        );
        const items = data?.comments ?? [];
        return emit(ctx, "comments", instanceName("comments", args.id), {
          count: items.length,
          items,
        });
      },
    },
    addComment: {
      description: "Add a comment to a work item (7.2-preview.4).",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        text: z.string().min(1).describe("Comment text (HTML allowed)."),
      }),
      execute: async (
        args: { project?: string; id: number; text: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post<{ id?: number }>(
          `wit/workItems/${args.id}/comments`,
          { text: args.text },
          { project: c.requireProject(args.project), preview: 4 },
        );
        return emit(
          ctx,
          "comment",
          instanceName("comment", args.id, data?.id),
          data,
        );
      },
    },
    listRevisions: {
      description: "List the revisions (full snapshots) of a work item.",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        top: z.number().int().positive().optional(),
        skip: z.number().int().min(0).optional(),
        expand: expandArg,
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          top?: number;
          skip?: number;
          expand?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`wit/workItems/${args.id}/revisions`, {
          project: args.project,
          query: { $top: args.top, $skip: args.skip, $expand: args.expand },
        });
        return emit(ctx, "revisions", instanceName("revisions", args.id), list);
      },
    },
    listUpdates: {
      description: "List the field-level updates (deltas) of a work item.",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        top: z.number().int().positive().optional(),
        skip: z.number().int().min(0).optional(),
      }),
      execute: async (
        args: { project?: string; id: number; top?: number; skip?: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`wit/workItems/${args.id}/updates`, {
          project: args.project,
          query: { $top: args.top, $skip: args.skip },
        });
        return emit(ctx, "updates", instanceName("updates", args.id), list);
      },
    },
    addLink: {
      description:
        "Add a relation to a work item, e.g. rel 'System.LinkTypes.Hierarchy-Reverse' (parent) with the target work item ID or a full URL.",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        rel: z.string().min(1).describe("Link type reference name."),
        targetId: z.number().int().positive().optional().describe(
          "Target work item ID (the URL is built for you).",
        ),
        url: z.string().optional().describe(
          "Explicit target URL (PRs, commits, hyperlinks). Overrides targetId.",
        ),
        comment: z.string().optional(),
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          rel: string;
          targetId?: number;
          url?: string;
          comment?: string;
        },
        ctx: any,
      ) => {
        if (!args.url && !args.targetId) {
          throw new Error("Provide either targetId or url.");
        }
        const c = clientFrom(ctx);
        const url = args.url ?? c.buildUrl(`wit/workItems/${args.targetId}`, {
          project: null,
        }).split("?")[0];
        const { data } = await c.patch(
          `wit/workitems/${args.id}`,
          [{
            op: "add",
            path: "/relations/-",
            value: {
              rel: args.rel,
              url,
              attributes: args.comment ? { comment: args.comment } : {},
            },
          }],
          { project: args.project, contentType: PATCH },
        );
        return emit(ctx, "workitem", instanceName("workitem", args.id), data);
      },
    },
    removeLink: {
      description:
        "DESTRUCTIVE: remove a relation from a work item, matched by its URL (or target work item ID) and optional rel. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        id: idArg,
        targetId: z.number().int().positive().optional(),
        url: z.string().optional(),
        rel: z.string().optional().describe(
          "Restrict the match to this link type.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          id: number;
          targetId?: number;
          url?: string;
          rel?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `remove a link from work item ${args.id}`);
        if (!args.url && !args.targetId) {
          throw new Error("Provide either targetId or url.");
        }
        const c = clientFrom(ctx);
        const { data: wi } = await c.get<any>(`wit/workitems/${args.id}`, {
          project: args.project,
          query: { $expand: "Relations" },
        });
        const relations: any[] = wi?.relations ?? [];
        const index = relations.findIndex((r) =>
          (args.url
            ? r.url === args.url
            : String(r.url).endsWith(`/workItems/${args.targetId}`)) &&
          (!args.rel || r.rel === args.rel)
        );
        if (index < 0) {
          throw new Error(
            `No matching relation found on work item ${args.id}.`,
          );
        }
        const { data } = await c.patch(
          `wit/workitems/${args.id}`,
          [
            { op: "test", path: "/rev", value: wi.rev },
            { op: "remove", path: `/relations/${index}` },
          ],
          { project: args.project, contentType: PATCH },
        );
        return emit(ctx, "workitem", instanceName("workitem", args.id), data);
      },
    },
    listAreas: {
      description: "Get the area path tree of a project.",
      arguments: z.object({
        project: ProjectArg,
        depth: z.number().int().min(0).max(10).default(3),
      }),
      execute: async (args: { project?: string; depth: number }, ctx: any) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const { data } = await c.get("wit/classificationnodes/Areas", {
          project,
          query: { $depth: args.depth },
        });
        return emit(
          ctx,
          "classification",
          instanceName("areas", project),
          data,
        );
      },
    },
    listIterations: {
      description: "Get the iteration path tree of a project.",
      arguments: z.object({
        project: ProjectArg,
        depth: z.number().int().min(0).max(10).default(3),
      }),
      execute: async (args: { project?: string; depth: number }, ctx: any) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const { data } = await c.get("wit/classificationnodes/Iterations", {
          project,
          query: { $depth: args.depth },
        });
        return emit(
          ctx,
          "classification",
          instanceName("iterations", project),
          data,
        );
      },
    },
    listTags: {
      description: "List work item tags used in a project.",
      arguments: z.object({ project: ProjectArg }),
      execute: async (args: { project?: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const list = await c.list("wit/tags", { project });
        return emit(ctx, "tags", instanceName("tags", project), list);
      },
    },
  },
};
