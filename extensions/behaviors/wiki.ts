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

const AnySchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  remoteUrl: z.string().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
  etag: z.string().optional(),
  isParentPage: z.boolean().optional(),
  order: z.number().optional(),
  gitItemPath: z.string().optional(),
  subPages: z.array(z.unknown()).optional(),
  viewStats: z.array(z.unknown()).optional(),
  deleted: z.boolean().optional(),
}).passthrough();
const wikiArg = z.string().min(1).describe("Wiki ID or name.");
const pathArg = z.string().min(1).describe("Page path, e.g. '/Home/Setup'.");
const pageIdArg = z.number().int().positive().describe("Page ID.");

export const behavior = {
  type: "@adamchubbuck/azure-devops/wiki",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    wikis: spec("List of wikis", ListSchema),
    wiki: spec("A single wiki", AnySchema),
    pages: spec("List of wiki pages", ListSchema),
    page: spec("A single wiki page", AnySchema),
    stats: spec("View statistics of a wiki page", AnySchema),
  },
  methods: {
    listWikis: {
      description: "List wikis in a project (or the whole organization).",
      arguments: z.object({ project: ProjectArg }),
      execute: async (args: { project?: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const project = args.project ?? ctx.globalArgs.project;
        const list = await c.list("wiki/wikis", { project });
        return emit(
          ctx,
          "wikis",
          instanceName("wikis", project ?? "org"),
          list,
        );
      },
    },
    getWiki: {
      description: "Get one wiki by ID or name.",
      arguments: z.object({ project: ProjectArg, wikiIdentifier: wikiArg }),
      execute: async (
        args: { project?: string; wikiIdentifier: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `wiki/wikis/${encodeURIComponent(args.wikiIdentifier)}`,
          { project: c.requireProject(args.project) },
        );
        return emit(
          ctx,
          "wiki",
          instanceName("wiki", args.wikiIdentifier),
          data,
        );
      },
    },
    createWiki: {
      description:
        "DESTRUCTIVE (creates a wiki): create a project wiki or publish a code wiki from a repository folder. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        name: z.string().min(1),
        type: z.enum(["projectWiki", "codeWiki"]).default("projectWiki"),
        projectId: z.string().optional().describe(
          "Project ID (GUID); required by the API for both wiki types.",
        ),
        repositoryId: z.string().optional().describe("Required for codeWiki."),
        mappedPath: z.string().default("/").describe(
          "Repo folder published as the wiki (codeWiki).",
        ),
        version: z.string().optional().describe(
          "Branch to publish (codeWiki), e.g. 'main'.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          name: string;
          type: "projectWiki" | "codeWiki";
          projectId?: string;
          repositoryId?: string;
          mappedPath: string;
          version?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `create wiki '${args.name}'`);
        if (args.type === "codeWiki" && (!args.repositoryId || !args.version)) {
          throw new Error(
            "codeWiki requires repositoryId and version (branch).",
          );
        }
        const c = clientFrom(ctx);
        const body: Record<string, unknown> = {
          name: args.name,
          type: args.type,
          projectId: args.projectId,
        };
        if (args.type === "codeWiki") {
          body.repositoryId = args.repositoryId;
          body.mappedPath = args.mappedPath;
          body.version = {
            version: args.version!.replace(/^refs\/heads\//, ""),
          };
        }
        const { data } = await c.post<any>("wiki/wikis", body, {
          project: c.requireProject(args.project),
        });
        return emit(
          ctx,
          "wiki",
          instanceName("wiki", data?.name ?? args.name),
          data,
        );
      },
    },
    deleteWiki: {
      description:
        "DESTRUCTIVE: delete a wiki (and its content for project wikis). Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { project?: string; wikiIdentifier: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete wiki ${args.wikiIdentifier}`);
        const c = clientFrom(ctx);
        const { data } = await c.delete<any>(
          `wiki/wikis/${encodeURIComponent(args.wikiIdentifier)}`,
          { project: c.requireProject(args.project) },
        );
        return emit(
          ctx,
          "wiki",
          instanceName("wiki", args.wikiIdentifier),
          data ?? { name: args.wikiIdentifier, deleted: true },
        );
      },
    },
    listPages: {
      description: "List pages of a wiki (batch API; page metadata only).",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        pageViewsForDays: z.number().int().min(1).max(30).optional(),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          project?: string;
          wikiIdentifier: string;
          pageViewsForDays?: number;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const items: Record<string, unknown>[] = [];
        let token: string | undefined;
        for (let i = 0; i < 100; i++) {
          const res = await c.post<{ value?: any[] }>(
            `wiki/wikis/${encodeURIComponent(args.wikiIdentifier)}/pagesbatch`,
            {
              top: Math.min(args.limit - items.length, 100),
              continuationToken: token,
              pageViewsForDays: args.pageViewsForDays,
            },
            { project },
          );
          items.push(...(res.data?.value ?? []));
          token = res.continuationToken;
          if (!token || items.length >= args.limit) break;
        }
        return emit(
          ctx,
          "pages",
          instanceName("pages", args.wikiIdentifier),
          {
            count: items.length,
            items: items.slice(0, args.limit),
            nextPageToken: token,
          },
        );
      },
    },
    getPage: {
      description: "Get a wiki page by path, optionally with its content.",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        path: pathArg,
        includeContent: z.boolean().default(false),
        recursionLevel: z.enum(["none", "oneLevel", "full"]).optional(),
      }),
      execute: async (
        args: {
          project?: string;
          wikiIdentifier: string;
          path: string;
          includeContent: boolean;
          recursionLevel?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data, etag } = await c.get<Record<string, unknown>>(
          `wiki/wikis/${encodeURIComponent(args.wikiIdentifier)}/pages`,
          {
            project: c.requireProject(args.project),
            query: {
              path: args.path,
              includeContent: args.includeContent ? "true" : undefined,
              recursionLevel: args.recursionLevel,
            },
          },
        );
        return emit(
          ctx,
          "page",
          instanceName("page", args.wikiIdentifier, args.path),
          { ...data, etag },
        );
      },
    },
    getPageById: {
      description: "Get a wiki page by numeric ID, optionally with content.",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        pageId: pageIdArg,
        includeContent: z.boolean().default(false),
      }),
      execute: async (
        args: {
          project?: string;
          wikiIdentifier: string;
          pageId: number;
          includeContent: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `wiki/wikis/${
            encodeURIComponent(args.wikiIdentifier)
          }/pages/${args.pageId}`,
          {
            project: c.requireProject(args.project),
            query: { includeContent: args.includeContent ? "true" : undefined },
          },
        );
        return emit(
          ctx,
          "page",
          instanceName("page", args.wikiIdentifier, args.pageId),
          data,
        );
      },
    },
    createOrUpdatePage: {
      description:
        "DESTRUCTIVE (writes content): create a page, or update an existing one by supplying its current ETag (sent as If-Match). Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        path: pathArg,
        content: z.string().describe("Markdown content of the page."),
        comment: z.string().optional().describe("Edit comment."),
        etag: z.string().optional().describe(
          "Current ETag of the page; required to update an existing page, omit to create.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          wikiIdentifier: string;
          path: string;
          content: string;
          comment?: string;
          etag?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `write wiki page ${args.path}`);
        const c = clientFrom(ctx);
        const { data } = await c.put<any>(
          `wiki/wikis/${encodeURIComponent(args.wikiIdentifier)}/pages`,
          { content: args.content },
          {
            project: c.requireProject(args.project),
            query: { path: args.path, comment: args.comment },
            headers: args.etag ? { "If-Match": args.etag } : undefined,
          },
        );
        return emit(
          ctx,
          "page",
          instanceName("page", args.wikiIdentifier, args.path),
          data,
        );
      },
    },
    deletePage: {
      description:
        "DESTRUCTIVE: delete a wiki page (and its subpages) by path. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        path: pathArg,
        comment: z.string().optional(),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          wikiIdentifier: string;
          path: string;
          comment?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete wiki page ${args.path}`);
        const c = clientFrom(ctx);
        const { data } = await c.delete<any>(
          `wiki/wikis/${encodeURIComponent(args.wikiIdentifier)}/pages`,
          {
            project: c.requireProject(args.project),
            query: { path: args.path, comment: args.comment },
          },
        );
        return emit(
          ctx,
          "page",
          instanceName("page", args.wikiIdentifier, args.path),
          data ?? { path: args.path, deleted: true },
        );
      },
    },
    getPageStats: {
      description: "Get view statistics of a wiki page.",
      arguments: z.object({
        project: ProjectArg,
        wikiIdentifier: wikiArg,
        pageId: pageIdArg,
        pageViewsForDays: z.number().int().min(1).max(30).default(30),
      }),
      execute: async (
        args: {
          project?: string;
          wikiIdentifier: string;
          pageId: number;
          pageViewsForDays: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `wiki/wikis/${
            encodeURIComponent(args.wikiIdentifier)
          }/pages/${args.pageId}/stats`,
          {
            project: c.requireProject(args.project),
            query: { pageViewsForDays: args.pageViewsForDays },
          },
        );
        return emit(
          ctx,
          "stats",
          instanceName("stats", args.wikiIdentifier, args.pageId),
          data,
        );
      },
    },
  },
};
