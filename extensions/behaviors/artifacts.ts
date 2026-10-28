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

const Obj = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
}).passthrough();

const FeedArg = z.string().min(1).describe("Feed name or ID.");
const ScopeArg = z.string().optional().describe(
  "Project name or ID for a project-scoped feed. Omit for an organization-scoped feed (the global project is NOT used).",
);
const ProtocolArg = z.enum(["nuget", "npm", "maven", "pypi", "upack"])
  .describe("Package protocol.");
const buildIdArg = z.number().int().positive().describe("Build ID.");

// Azure Artifacts lives on the feeds host; feeds may be org- or project-scoped.
function feedsClient(ctx: any, project?: string) {
  const c = clientFrom(ctx);
  const baseUrl = serviceBaseUrl(
    GlobalArgsSchema.parse(ctx.globalArgs),
    "feeds",
  );
  return { c, baseUrl, project: project ?? null };
}

const feedPath = (feed: string) =>
  `packaging/feeds/${encodeURIComponent(feed)}`;

/** Protocol-specific path of a package version (used by delete and promote). */
function versionPath(
  feed: string,
  protocol: string,
  name: string,
  version: string,
): string {
  const f = feedPath(feed);
  const v = encodeURIComponent(version);
  switch (protocol) {
    case "npm": {
      // Scoped packages are addressed as {scope}/{name} without the '@'.
      const m = name.match(/^@?([^/]+)\/(.+)$/);
      const n = m
        ? `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`
        : encodeURIComponent(name);
      return `${f}/npm/${n}/versions/${v}`;
    }
    case "maven": {
      const [group, artifact] = name.split(":");
      if (!group || !artifact) {
        throw new Error("Maven package name must be 'groupId:artifactId'.");
      }
      return `${f}/maven/groups/${encodeURIComponent(group)}/artifacts/${
        encodeURIComponent(artifact)
      }/versions/${v}`;
    }
    default:
      return `${f}/${protocol}/packages/${
        encodeURIComponent(name)
      }/versions/${v}`;
  }
}

export const behavior = {
  type: "@adamchubbuck/azure-devops/artifacts",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    feed: spec("A single Azure Artifacts feed", Obj),
    feeds: spec("List of Azure Artifacts feeds", ListSchema),
    package: spec("A single package", Obj),
    packages: spec("List of packages in a feed", ListSchema),
    versions: spec("List of versions of a package", ListSchema),
    version: spec("A single package version", Obj),
    views: spec("List of feed views", ListSchema),
    permissions: spec("List of feed permissions", ListSchema),
    retention: spec("Feed retention policy", Obj),
    buildArtifacts: spec("List of build artifacts", ListSchema),
    buildArtifact: spec("A single build artifact", Obj),
  },
  methods: {
    listFeeds: {
      description: "List Azure Artifacts feeds visible to the caller.",
      arguments: z.object({
        project: ScopeArg,
        feedRole: z.enum([
          "none",
          "reader",
          "contributor",
          "collaborator",
          "administrator",
        ])
          .optional(),
        includeDeletedUpstreams: z.boolean().optional(),
      }),
      execute: async (
        args: {
          project?: string;
          feedRole?: string;
          includeDeletedUpstreams?: boolean;
        },
        ctx: any,
      ) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const list = await c.list("packaging/feeds", {
          baseUrl,
          project,
          preview: 1,
          query: {
            feedRole: args.feedRole,
            includeDeletedUpstreams: args.includeDeletedUpstreams,
          },
        });
        return emit(ctx, "feeds", instanceName("feeds", args.project), list);
      },
    },
    getFeed: {
      description: "Get one feed by name or ID.",
      arguments: z.object({ project: ScopeArg, feed: FeedArg }),
      execute: async (args: { project?: string; feed: string }, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const { data } = await c.get(feedPath(args.feed), {
          baseUrl,
          project,
          preview: 1,
        });
        return emit(ctx, "feed", instanceName("feed", args.feed), data);
      },
    },
    createFeed: {
      description:
        "DESTRUCTIVE (creates a shared resource): create a feed. Requires confirm: true.",
      arguments: z.object({
        project: ScopeArg,
        name: z.string().min(1),
        description: z.string().optional(),
        upstreamEnabled: z.boolean().default(false).describe(
          "Enable upstream sources (public registries).",
        ),
        hideDeletedPackageVersions: z.boolean().default(true),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          name: string;
          description?: string;
          upstreamEnabled: boolean;
          hideDeletedPackageVersions: boolean;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `create feed '${args.name}'`);
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const { data } = await c.post(
          "packaging/feeds",
          {
            name: args.name,
            description: args.description,
            upstreamEnabled: args.upstreamEnabled,
            hideDeletedPackageVersions: args.hideDeletedPackageVersions,
          },
          { baseUrl, project, preview: 1 },
        );
        return emit(ctx, "feed", instanceName("feed", args.name), data);
      },
    },
    deleteFeed: {
      description:
        "DESTRUCTIVE: delete a feed and all packages in it. Requires confirm: true.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { project?: string; feed: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete feed '${args.feed}'`);
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        await c.delete(feedPath(args.feed), { baseUrl, project, preview: 1 });
        return emit(ctx, "feed", instanceName("feed", args.feed), {
          id: args.feed,
          deleted: true,
        });
      },
    },
    listPackages: {
      description: "List packages in a feed with optional filters.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        protocolType: z.string().optional().describe(
          "e.g. 'NuGet', 'Npm', 'Maven', 'PyPI', 'UPack'.",
        ),
        packageNameQuery: z.string().optional().describe(
          "Substring of the package name.",
        ),
        includeAllVersions: z.boolean().optional(),
        includeDeleted: z.boolean().optional(),
        view: z.string().optional().describe(
          "Feed view name or ID, e.g. 'Release'.",
        ),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const feedRef = args.view ? `${args.feed}@${args.view}` : args.feed;
        const res = await c.get<{ value?: unknown[] }>(
          `${feedPath(feedRef)}/packages`,
          {
            baseUrl,
            project,
            preview: 1,
            query: {
              protocolType: args.protocolType,
              packageNameQuery: args.packageNameQuery,
              includeAllVersions: args.includeAllVersions,
              includeDeleted: args.includeDeleted,
              $top: args.limit,
            },
          },
        );
        const items = (res.data?.value ?? []).slice(0, args.limit) as Record<
          string,
          unknown
        >[];
        return emit(
          ctx,
          "packages",
          instanceName("packages", args.feed),
          { count: items.length, items },
        );
      },
    },
    getPackage: {
      description: "Get one package (by package ID) from a feed.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        packageId: z.string().min(1).describe(
          "Package ID (GUID) from listPackages.",
        ),
        includeAllVersions: z.boolean().optional(),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const { data } = await c.get(
          `${feedPath(args.feed)}/packages/${
            encodeURIComponent(args.packageId)
          }`,
          {
            baseUrl,
            project,
            preview: 1,
            query: { includeAllVersions: args.includeAllVersions },
          },
        );
        return emit(
          ctx,
          "package",
          instanceName("package", args.feed, args.packageId),
          data,
        );
      },
    },
    listPackageVersions: {
      description: "List versions of a package.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        packageId: z.string().min(1),
        includeUrls: z.boolean().optional(),
        isListed: z.boolean().optional(),
        isDeleted: z.boolean().optional(),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const list = await c.list(
          `${feedPath(args.feed)}/packages/${
            encodeURIComponent(args.packageId)
          }/versions`,
          {
            baseUrl,
            project,
            preview: 1,
            query: {
              includeUrls: args.includeUrls,
              isListed: args.isListed,
              isDeleted: args.isDeleted,
            },
          },
        );
        return emit(
          ctx,
          "versions",
          instanceName("versions", args.feed, args.packageId),
          list,
        );
      },
    },
    getPackageVersion: {
      description: "Get one version of a package (by version ID).",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        packageId: z.string().min(1),
        packageVersionId: z.string().min(1).describe(
          "Version ID (GUID) from listPackageVersions.",
        ),
        showDeleted: z.boolean().optional(),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const { data } = await c.get(
          `${feedPath(args.feed)}/packages/${
            encodeURIComponent(args.packageId)
          }/versions/${encodeURIComponent(args.packageVersionId)}`,
          {
            baseUrl,
            project,
            preview: 1,
            query: { showDeleted: args.showDeleted },
          },
        );
        return emit(
          ctx,
          "version",
          instanceName(
            "version",
            args.feed,
            args.packageId,
            args.packageVersionId,
          ),
          data,
        );
      },
    },
    deletePackageVersion: {
      description:
        "DESTRUCTIVE: move a package version to the feed recycle bin. Requires confirm: true.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        protocol: ProtocolArg,
        packageName: z.string().min(1).describe(
          "Package name; for maven use 'groupId:artifactId'; for npm scoped use '@scope/name'.",
        ),
        version: z.string().min(1),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          feed: string;
          protocol: string;
          packageName: string;
          version: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `delete ${args.packageName}@${args.version} from feed '${args.feed}'`,
        );
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        await c.delete(
          versionPath(args.feed, args.protocol, args.packageName, args.version),
          { baseUrl, project, preview: 1 },
        );
        return emit(
          ctx,
          "version",
          instanceName("version", args.feed, args.packageName, args.version),
          { name: args.packageName, version: args.version, deleted: true },
        );
      },
    },
    promotePackageVersion: {
      description:
        "DESTRUCTIVE (changes what consumers of a view receive): add or remove a package version in a feed view such as 'Release'. Requires confirm: true.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        protocol: ProtocolArg,
        packageName: z.string().min(1),
        version: z.string().min(1),
        view: z.string().min(1).describe("View name or ID, e.g. 'Release'."),
        op: z.enum(["add", "remove"]).default("add"),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          feed: string;
          protocol: string;
          packageName: string;
          version: string;
          view: string;
          op: "add" | "remove";
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `${args.op} ${args.packageName}@${args.version} ${
            args.op === "add" ? "to" : "from"
          } view '${args.view}'`,
        );
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const { data } = await c.patch(
          versionPath(args.feed, args.protocol, args.packageName, args.version),
          {
            views: {
              op: args.op,
              path: "/views/-",
              value: args.view,
            },
          },
          { baseUrl, project, preview: 1 },
        );
        return emit(
          ctx,
          "version",
          instanceName("version", args.feed, args.packageName, args.version),
          data ?? {
            name: args.packageName,
            version: args.version,
            view: args.view,
            op: args.op,
          },
        );
      },
    },
    listFeedViews: {
      description:
        "List the views of a feed (e.g. Local, Prerelease, Release).",
      arguments: z.object({ project: ScopeArg, feed: FeedArg }),
      execute: async (args: { project?: string; feed: string }, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const list = await c.list(`${feedPath(args.feed)}/views`, {
          baseUrl,
          project,
          preview: 1,
        });
        return emit(ctx, "views", instanceName("views", args.feed), list);
      },
    },
    listFeedPermissions: {
      description: "List the permissions (role assignments) of a feed.",
      arguments: z.object({
        project: ScopeArg,
        feed: FeedArg,
        includeIds: z.boolean().optional(),
        excludeInheritedPermissions: z.boolean().optional(),
        identityDescriptor: z.string().optional(),
      }),
      execute: async (args: Record<string, any>, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const list = await c.list(`${feedPath(args.feed)}/permissions`, {
          baseUrl,
          project,
          preview: 1,
          query: {
            includeIds: args.includeIds,
            excludeInheritedPermissions: args.excludeInheritedPermissions,
            identityDescriptor: args.identityDescriptor,
          },
        });
        return emit(
          ctx,
          "permissions",
          instanceName("permissions", args.feed),
          list,
        );
      },
    },
    getRetentionPolicy: {
      description: "Get the retention policy of a feed.",
      arguments: z.object({ project: ScopeArg, feed: FeedArg }),
      execute: async (args: { project?: string; feed: string }, ctx: any) => {
        const { c, baseUrl, project } = feedsClient(ctx, args.project);
        const { data } = await c.get(
          `${feedPath(args.feed)}/retentionpolicies`,
          { baseUrl, project, preview: 1 },
        );
        return emit(
          ctx,
          "retention",
          instanceName("retention", args.feed),
          data ?? {},
        );
      },
    },
    listBuildArtifacts: {
      description: "List the artifacts published by a build (normal host).",
      arguments: z.object({ project: ProjectArg, buildId: buildIdArg }),
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
          "buildArtifacts",
          instanceName("buildArtifacts", args.buildId),
          list,
        );
      },
    },
    getBuildArtifact: {
      description: "Get one named artifact of a build, with its download URL.",
      arguments: z.object({
        project: ProjectArg,
        buildId: buildIdArg,
        artifactName: z.string().min(1),
      }),
      execute: async (
        args: { project?: string; buildId: number; artifactName: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `build/builds/${args.buildId}/artifacts`,
          {
            project: c.requireProject(args.project),
            query: { artifactName: args.artifactName },
          },
        );
        return emit(
          ctx,
          "buildArtifact",
          instanceName("buildArtifact", args.buildId, args.artifactName),
          data,
        );
      },
    },
  },
};
