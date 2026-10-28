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
  serviceBaseUrl,
} from "./_lib/client.ts";

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const AnySchema = z.object({
  descriptor: z.string().optional(),
  displayName: z.string().optional(),
  principalName: z.string().optional(),
  mailAddress: z.string().optional(),
  origin: z.string().optional(),
  originId: z.string().optional(),
  subjectKind: z.string().optional(),
  domain: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  value: z.string().optional(),
  deleted: z.boolean().optional(),
}).passthrough();
const descriptor = (what: string) =>
  z.string().min(1).describe(`${what} descriptor (e.g. 'vssgp.Uy0x...').`);
const limitArg = z.number().int().positive().default(500);

// Graph lives on the vssps host, is org-level and preview at 7.2.
const opts = (c: any, extra: Record<string, unknown> = {}) => ({
  baseUrl: serviceBaseUrl(c.globals, "vssps"),
  project: null as null,
  preview: 1,
  ...extra,
});

export const behavior = {
  type: "@adamchubbuck/azure-devops/graph",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    users: spec("List of graph users", ListSchema),
    user: spec("A single graph user", AnySchema),
    groups: spec("List of graph groups", ListSchema),
    group: spec("A single graph group", AnySchema),
    memberships: spec("Graph memberships of a subject", ListSchema),
    descriptor: spec("Descriptor for a storage key", AnySchema),
    storagekey: spec("Storage key for a descriptor", AnySchema),
    subjects: spec("Subjects resolved by descriptor lookup", AnySchema),
    identities: spec("Identities matching a search", ListSchema),
  },
  methods: {
    listUsers: {
      description: "List users in the organization (Graph, preview).",
      arguments: z.object({
        subjectTypes: z.string().optional().describe(
          "Comma-separated, e.g. 'aad,msa,vsts'.",
        ),
        scopeDescriptor: z.string().optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          subjectTypes?: string;
          scopeDescriptor?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("graph/users", {
          ...opts(c),
          limit: args.limit,
          query: {
            subjectTypes: args.subjectTypes,
            scopeDescriptor: args.scopeDescriptor,
          },
        });
        return emit(ctx, "users", "users", list);
      },
    },
    getUser: {
      description: "Get one user by descriptor.",
      arguments: z.object({ userDescriptor: descriptor("User") }),
      execute: async (args: { userDescriptor: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `graph/users/${encodeURIComponent(args.userDescriptor)}`,
          opts(c),
        );
        return emit(
          ctx,
          "user",
          instanceName("user", args.userDescriptor),
          data,
        );
      },
    },
    listGroups: {
      description: "List groups in the organization or a scope.",
      arguments: z.object({
        scopeDescriptor: z.string().optional().describe(
          "Restrict to a project scope descriptor.",
        ),
        subjectTypes: z.string().optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          scopeDescriptor?: string;
          subjectTypes?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("graph/groups", {
          ...opts(c),
          limit: args.limit,
          query: {
            scopeDescriptor: args.scopeDescriptor,
            subjectTypes: args.subjectTypes,
          },
        });
        return emit(ctx, "groups", "groups", list);
      },
    },
    getGroup: {
      description: "Get one group by descriptor.",
      arguments: z.object({ groupDescriptor: descriptor("Group") }),
      execute: async (args: { groupDescriptor: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `graph/groups/${encodeURIComponent(args.groupDescriptor)}`,
          opts(c),
        );
        return emit(
          ctx,
          "group",
          instanceName("group", args.groupDescriptor),
          data,
        );
      },
    },
    createGroup: {
      description:
        "DESTRUCTIVE (changes access control): create a VSTS group, optionally scoped to a project. Requires confirm: true.",
      arguments: z.object({
        displayName: z.string().min(1),
        description: z.string().optional(),
        scopeDescriptor: z.string().optional().describe(
          "Project scope descriptor; omit for an organization-level group.",
        ),
        groupDescriptors: z.array(z.string()).default([]).describe(
          "Parent groups the new group should join.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          displayName: string;
          description?: string;
          scopeDescriptor?: string;
          groupDescriptors: string[];
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `create group '${args.displayName}'`);
        const c = clientFrom(ctx);
        const { data } = await c.post<any>(
          "graph/groups",
          { displayName: args.displayName, description: args.description },
          opts(c, {
            query: {
              scopeDescriptor: args.scopeDescriptor,
              groupDescriptors: args.groupDescriptors.join(","),
            },
          }),
        );
        return emit(
          ctx,
          "group",
          instanceName("group", data?.descriptor ?? args.displayName),
          data,
        );
      },
    },
    deleteGroup: {
      description:
        "DESTRUCTIVE: delete a VSTS group by descriptor. Requires confirm: true.",
      arguments: z.object({
        groupDescriptor: descriptor("Group"),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { groupDescriptor: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete group ${args.groupDescriptor}`);
        const c = clientFrom(ctx);
        await c.delete(
          `graph/groups/${encodeURIComponent(args.groupDescriptor)}`,
          opts(c),
        );
        return emit(
          ctx,
          "group",
          instanceName("group", args.groupDescriptor),
          { descriptor: args.groupDescriptor, deleted: true },
        );
      },
    },
    listMemberships: {
      description:
        "List memberships of a subject: containers it belongs to (up) or members it contains (down).",
      arguments: z.object({
        subjectDescriptor: descriptor("Subject"),
        direction: z.enum(["up", "down"]).default("up"),
        depth: z.number().int().min(1).optional(),
      }),
      execute: async (
        args: {
          subjectDescriptor: string;
          direction: "up" | "down";
          depth?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `graph/memberships/${encodeURIComponent(args.subjectDescriptor)}`,
          opts(c, {
            query: { direction: args.direction, depth: args.depth },
          }),
        );
        return emit(
          ctx,
          "memberships",
          instanceName("memberships", args.subjectDescriptor, args.direction),
          list,
        );
      },
    },
    addMembership: {
      description:
        "DESTRUCTIVE (grants access): add a subject to a container group. Requires confirm: true.",
      arguments: z.object({
        subjectDescriptor: descriptor("Subject (member)"),
        containerDescriptor: descriptor("Container (group)"),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          subjectDescriptor: string;
          containerDescriptor: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, "add membership");
        const c = clientFrom(ctx);
        const { data } = await c.put<any>(
          `graph/memberships/${encodeURIComponent(args.subjectDescriptor)}/${
            encodeURIComponent(args.containerDescriptor)
          }`,
          undefined,
          opts(c),
        );
        return emit(
          ctx,
          "memberships",
          instanceName(
            "membership",
            args.subjectDescriptor,
            "in",
            args.containerDescriptor,
          ),
          { count: 1, items: [data ?? {}] },
        );
      },
    },
    removeMembership: {
      description:
        "DESTRUCTIVE (revokes access): remove a subject from a container group. Requires confirm: true.",
      arguments: z.object({
        subjectDescriptor: descriptor("Subject (member)"),
        containerDescriptor: descriptor("Container (group)"),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          subjectDescriptor: string;
          containerDescriptor: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, "remove membership");
        const c = clientFrom(ctx);
        await c.delete(
          `graph/memberships/${encodeURIComponent(args.subjectDescriptor)}/${
            encodeURIComponent(args.containerDescriptor)
          }`,
          opts(c),
        );
        return emit(
          ctx,
          "memberships",
          instanceName(
            "membership",
            args.subjectDescriptor,
            "in",
            args.containerDescriptor,
          ),
          { count: 0, items: [] },
        );
      },
    },
    getDescriptor: {
      description: "Resolve a storage key (GUID) to its Graph descriptor.",
      arguments: z.object({
        storageKey: z.string().uuid().describe("Storage key GUID."),
      }),
      execute: async (args: { storageKey: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `graph/descriptors/${encodeURIComponent(args.storageKey)}`,
          opts(c),
        );
        return emit(
          ctx,
          "descriptor",
          instanceName("descriptor", args.storageKey),
          data,
        );
      },
    },
    listDescriptors: {
      description:
        "Resolve several storage keys to descriptors (one call per key, results merged).",
      arguments: z.object({
        storageKeys: z.array(z.string().uuid()).min(1),
      }),
      execute: async (args: { storageKeys: string[] }, ctx: any) => {
        const c = clientFrom(ctx);
        const items: Record<string, unknown>[] = [];
        for (const key of args.storageKeys) {
          const { data } = await c.get<any>(
            `graph/descriptors/${encodeURIComponent(key)}`,
            opts(c),
          );
          items.push({ storageKey: key, ...data });
        }
        return emit(ctx, "descriptor", "descriptors", {
          count: items.length,
          items,
        });
      },
    },
    getStorageKey: {
      description: "Resolve a Graph descriptor to its storage key (GUID).",
      arguments: z.object({ subjectDescriptor: descriptor("Subject") }),
      execute: async (args: { subjectDescriptor: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `graph/storagekeys/${encodeURIComponent(args.subjectDescriptor)}`,
          opts(c),
        );
        return emit(
          ctx,
          "storagekey",
          instanceName("storagekey", args.subjectDescriptor),
          data,
        );
      },
    },
    lookupSubjects: {
      description: "Look up multiple subjects by descriptor in one call.",
      arguments: z.object({
        descriptors: z.array(z.string()).min(1),
      }),
      execute: async (args: { descriptors: string[] }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.post<any>(
          "graph/subjectlookup",
          {
            lookupKeys: args.descriptors.map((descriptor) => ({ descriptor })),
          },
          opts(c),
        );
        return emit(ctx, "subjects", "subjects", data ?? {});
      },
    },
    searchIdentities: {
      description:
        "Search identities (users/groups) by display name, account name or mail address.",
      arguments: z.object({
        searchFilter: z.enum([
          "General",
          "AccountName",
          "DisplayName",
          "MailAddress",
          "Identifier",
        ]).default("General"),
        filterValue: z.string().min(1),
        queryMembership: z.enum(["None", "Direct", "Expanded"]).default("None"),
      }),
      execute: async (
        args: {
          searchFilter: string;
          filterValue: string;
          queryMembership: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get<{ value?: any[] }>("identities", {
          baseUrl: serviceBaseUrl(c.globals, "vssps"),
          project: null,
          query: {
            searchFilter: args.searchFilter,
            filterValue: args.filterValue,
            queryMembership: args.queryMembership,
          },
        });
        const items = data?.value ?? [];
        return emit(
          ctx,
          "identities",
          instanceName("identities", args.searchFilter, args.filterValue),
          { count: items.length, items },
        );
      },
    },
  },
};
