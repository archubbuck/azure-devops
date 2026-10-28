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

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const AnySchema = z.object({
  namespaceId: z.string().optional(),
  name: z.string().optional(),
  displayName: z.string().optional(),
  dataspaceCategory: z.string().optional(),
  actions: z.array(z.unknown()).optional(),
  permissions: z.number().optional(),
  tokens: z.array(z.string()).optional(),
  results: z.array(z.unknown()).optional(),
  allGranted: z.boolean().optional(),
  removed: z.unknown().optional(),
  descriptors: z.array(z.string()).optional(),
}).passthrough();
const nsArg = z.string().min(1).describe(
  "Security namespace ID (GUID), see listSecurityNamespaces.",
);
// swamp-quality-ignore credentials-sensitive-field
const tokenArg = z.string().describe("Security token within the namespace.");

// Security APIs are organization-level.
const org = { project: null as null };

const AceSchema = z.object({
  descriptor: z.string().describe("Identity descriptor."),
  allow: z.number().int().describe("Allow permission bitmask."),
  deny: z.number().int().describe("Deny permission bitmask."),
  extendedInfo: z.record(z.string(), z.unknown()).optional(),
});

export const behavior = {
  type: "@adamchubbuck/azure-devops/security",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    namespaces: spec("List of security namespaces", ListSchema),
    namespace: spec("A single security namespace", AnySchema),
    acls: spec("Access control lists", ListSchema),
    aces: spec("Access control entries for a token", ListSchema),
    permissions: spec("Permission check results", AnySchema),
    result: spec("Result of a security change", AnySchema),
  },
  methods: {
    listSecurityNamespaces: {
      description: "List security namespaces, their actions and bit values.",
      arguments: z.object({
        localOnly: z.boolean().default(false),
      }),
      execute: async (args: { localOnly: boolean }, ctx: any) => {
        const c = clientFrom(ctx);
        const list = await c.list("securitynamespaces", {
          ...org,
          query: { localOnly: args.localOnly ? "true" : undefined },
        });
        return emit(ctx, "namespaces", "namespaces", list);
      },
    },
    getSecurityNamespace: {
      description: "Get one security namespace (including its actions).",
      arguments: z.object({ namespaceId: nsArg }),
      execute: async (args: { namespaceId: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get<any>(
          `securitynamespaces/${args.namespaceId}`,
          org,
        );
        const ns = Array.isArray(data?.value) ? data.value[0] : data;
        return emit(
          ctx,
          "namespace",
          instanceName("namespace", args.namespaceId),
          ns ?? {},
        );
      },
    },
    listAccessControlLists: {
      description: "List access control lists in a namespace.",
      arguments: z.object({
        namespaceId: nsArg,
        token: tokenArg.optional(),
        descriptors: z.string().optional().describe(
          "Comma-separated identity descriptors to filter by.",
        ),
        includeExtendedInfo: z.boolean().default(false),
        recurse: z.boolean().default(false),
      }),
      execute: async (
        args: {
          namespaceId: string;
          token?: string;
          descriptors?: string;
          includeExtendedInfo: boolean;
          recurse: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`accesscontrollists/${args.namespaceId}`, {
          ...org,
          query: {
            token: args.token,
            descriptors: args.descriptors,
            includeExtendedInfo: args.includeExtendedInfo ? "true" : undefined,
            recurse: args.recurse ? "true" : undefined,
          },
        });
        return emit(
          ctx,
          "acls",
          instanceName("acls", args.namespaceId, args.token),
          list,
        );
      },
    },
    queryAccessControlEntries: {
      description:
        "Query the access control entries (ACEs) on one token, flattened from its ACL.",
      arguments: z.object({
        namespaceId: nsArg,
        token: tokenArg,
        descriptors: z.string().optional(),
        includeExtendedInfo: z.boolean().default(false),
      }),
      execute: async (
        args: {
          namespaceId: string;
          token: string;
          descriptors?: string;
          includeExtendedInfo: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list<any>(
          `accesscontrollists/${args.namespaceId}`,
          {
            ...org,
            query: {
              token: args.token,
              descriptors: args.descriptors,
              includeExtendedInfo: args.includeExtendedInfo
                ? "true"
                : undefined,
            },
          },
        );
        const items = list.items.flatMap((acl) =>
          Object.entries(acl?.acesDictionary ?? {}).map((
            [descriptor, ace]: [string, any],
          ) => ({
            token: acl.token,
            ...ace,
            descriptor: ace?.descriptor ?? descriptor,
          }))
        );
        return emit(
          ctx,
          "aces",
          instanceName("aces", args.namespaceId, args.token),
          { count: items.length, items },
        );
      },
    },
    setAccessControlEntries: {
      description:
        "DESTRUCTIVE (changes permissions): add or replace ACEs on a token. Requires confirm: true.",
      arguments: z.object({
        namespaceId: nsArg,
        token: tokenArg,
        merge: z.boolean().default(true).describe(
          "Merge bits into existing ACEs (true) or replace them (false).",
        ),
        accessControlEntries: z.array(AceSchema).min(1),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          namespaceId: string;
          token: string;
          merge: boolean;
          accessControlEntries: z.infer<typeof AceSchema>[];
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `set access control entries on namespace ${args.namespaceId}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.post<any>(
          `accesscontrolentries/${args.namespaceId}`,
          {
            token: args.token,
            merge: args.merge,
            accessControlEntries: args.accessControlEntries,
          },
          org,
        );
        const items = data?.value ?? [];
        return emit(
          ctx,
          "aces",
          instanceName("aces", args.namespaceId, args.token),
          { count: items.length, items },
        );
      },
    },
    removeAccessControlEntries: {
      description:
        "DESTRUCTIVE (revokes permissions): remove the ACEs of given identities from a token. Requires confirm: true.",
      arguments: z.object({
        namespaceId: nsArg,
        token: tokenArg,
        descriptors: z.array(z.string()).min(1),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          namespaceId: string;
          token: string;
          descriptors: string[];
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `remove access control entries from namespace ${args.namespaceId}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.delete<any>(
          `accesscontrolentries/${args.namespaceId}`,
          {
            ...org,
            query: {
              token: args.token,
              descriptors: args.descriptors.join(","),
            },
          },
        );
        return emit(
          ctx,
          "result",
          instanceName("removed-aces", args.namespaceId, args.token),
          { removed: data ?? true, descriptors: args.descriptors },
        );
      },
    },
    hasPermissions: {
      description:
        "Check whether the caller (or given identity) has a permission bitmask on tokens in a namespace.",
      arguments: z.object({
        namespaceId: nsArg,
        permissions: z.number().int().min(0).describe(
          "Permission bitmask to check (use 0 to omit).",
        ),
        tokens: z.array(z.string()).default([]),
        alwaysAllowAdministrators: z.boolean().default(false),
        descriptor: z.string().optional().describe(
          "Check for this identity instead of the caller.",
        ),
      }),
      execute: async (
        args: {
          namespaceId: string;
          permissions: number;
          tokens: string[];
          alwaysAllowAdministrators: boolean;
          descriptor?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get<any>(
          `permissions/${args.namespaceId}/${args.permissions}`,
          {
            ...org,
            query: {
              tokens: args.tokens.join(","),
              alwaysAllowAdministrators: args.alwaysAllowAdministrators
                ? "true"
                : undefined,
              descriptors: args.descriptor,
            },
          },
        );
        const results = data?.value ?? [];
        return emit(
          ctx,
          "permissions",
          instanceName("permissions", args.namespaceId, args.permissions),
          {
            namespaceId: args.namespaceId,
            permissions: args.permissions,
            tokens: args.tokens,
            results,
            allGranted: results.length > 0 &&
              results.every((r: any) => r === true),
          },
        );
      },
    },
  },
};
