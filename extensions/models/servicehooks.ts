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
  id: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
  publisherId: z.string().optional(),
  eventType: z.string().optional(),
  consumerId: z.string().optional(),
  consumerActionId: z.string().optional(),
  subscriptionId: z.string().optional(),
  status: z.string().optional(),
  result: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  deleted: z.boolean().optional(),
}).passthrough();
const org = { project: null as null };
const subArg = z.string().min(1).describe("Subscription ID (GUID).");

const SubscriptionFields = {
  publisherId: z.string().min(1).describe("e.g. 'tfs'."),
  eventType: z.string().min(1).describe("e.g. 'build.complete'."),
  resourceVersion: z.string().default("1.0"),
  consumerId: z.string().min(1).describe("e.g. 'webHooks'."),
  consumerActionId: z.string().min(1).describe("e.g. 'httpRequest'."),
  publisherInputs: z.record(z.string(), z.string()).default({}).describe(
    "e.g. { projectId: '<guid>', buildStatus: 'Failed' }.",
  ),
  consumerInputs: z.record(z.string(), z.string()).default({}).describe(
    "Non-secret consumer settings, e.g. { url: 'https://example.com/hook' }.",
  ),
  secretConsumerInputs: z.record(
    z.string(),
    z.string().meta({ sensitive: true }),
  )
    .default({}).describe(
      "Secret consumer settings (e.g. basicAuthPassword, httpHeaders with tokens). Merged into consumerInputs; never logged or stored in output.",
    ),
  status: z.enum(["enabled", "onProbation", "disabledByUser"]).optional(),
};

type SubArgs = {
  publisherId: string;
  eventType: string;
  resourceVersion: string;
  consumerId: string;
  consumerActionId: string;
  publisherInputs: Record<string, string>;
  consumerInputs: Record<string, string>;
  secretConsumerInputs: Record<string, string>;
  status?: string;
};

const subBody = (a: SubArgs) => ({
  publisherId: a.publisherId,
  eventType: a.eventType,
  resourceVersion: a.resourceVersion,
  consumerId: a.consumerId,
  consumerActionId: a.consumerActionId,
  publisherInputs: a.publisherInputs,
  consumerInputs: { ...a.consumerInputs, ...a.secretConsumerInputs },
  status: a.status,
});

/** Strip any secret values that might be echoed back, defensively. */
function scrub(data: any, secrets: Record<string, string>): any {
  const values = Object.values(secrets).filter((v) => v);
  if (values.length === 0) return data;
  let text = JSON.stringify(data ?? null);
  for (const v of values) {
    text = text.split(JSON.stringify(v).slice(1, -1)).join("***");
  }
  return JSON.parse(text);
}

/** Run a call and make sure secret values never appear in a surfaced error. */
async function guarded<T>(
  secrets: Record<string, string>,
  fn: () => Promise<T>,
) {
  try {
    return await fn();
  } catch (e) {
    let msg = (e as Error).message;
    for (const v of Object.values(secrets)) {
      if (v) msg = msg.split(v).join("***");
    }
    throw new Error(msg);
  }
}

/** Azure DevOps Service Hooks model: subscriptions and notifications. */
export const model = {
  type: "@adamchubbuck/azure-devops/servicehooks",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    publishers: spec("List of service hook publishers", ListSchema),
    consumers: spec("List of service hook consumers", ListSchema),
    consumer: spec("A single consumer", AnySchema),
    actions: spec("Actions of a consumer", ListSchema),
    eventtypes: spec("Event types of a publisher", ListSchema),
    subscriptions: spec("List of subscriptions", ListSchema),
    subscription: spec("A single subscription", AnySchema),
    notifications: spec("List of subscription notifications", ListSchema),
    notification: spec("A single notification", AnySchema),
    result: spec("Result of a service hooks operation", AnySchema),
  },
  methods: {
    listPublishers: {
      description: "List service hook publishers (event sources).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: any) => {
        const c = clientFrom(ctx);
        return emit(
          ctx,
          "publishers",
          "publishers",
          await c.list("hooks/publishers", org),
        );
      },
    },
    listConsumers: {
      description: "List service hook consumers (targets).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: any) => {
        const c = clientFrom(ctx);
        return emit(
          ctx,
          "consumers",
          "consumers",
          await c.list("hooks/consumers", org),
        );
      },
    },
    getConsumer: {
      description: "Get one consumer and its input descriptors.",
      arguments: z.object({ consumerId: z.string().min(1) }),
      execute: async (args: { consumerId: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`hooks/consumers/${args.consumerId}`, org);
        return emit(
          ctx,
          "consumer",
          instanceName("consumer", args.consumerId),
          data,
        );
      },
    },
    listConsumerActions: {
      description: "List the actions of a consumer.",
      arguments: z.object({ consumerId: z.string().min(1) }),
      execute: async (args: { consumerId: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `hooks/consumers/${args.consumerId}/actions`,
          org,
        );
        return emit(
          ctx,
          "actions",
          instanceName("actions", args.consumerId),
          list,
        );
      },
    },
    listEventTypes: {
      description: "List the event types of a publisher.",
      arguments: z.object({
        publisherId: z.string().min(1).describe("e.g. 'tfs'."),
      }),
      execute: async (args: { publisherId: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `hooks/publishers/${args.publisherId}/eventtypes`,
          org,
        );
        return emit(
          ctx,
          "eventtypes",
          instanceName("eventtypes", args.publisherId),
          list,
        );
      },
    },
    listSubscriptions: {
      description: "List subscriptions, optionally filtered.",
      arguments: z.object({
        publisherId: z.string().optional(),
        eventType: z.string().optional(),
        consumerId: z.string().optional(),
        consumerActionId: z.string().optional(),
      }),
      execute: async (
        args: {
          publisherId?: string;
          eventType?: string;
          consumerId?: string;
          consumerActionId?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("hooks/subscriptions", {
          ...org,
          query: { ...args },
        });
        return emit(
          ctx,
          "subscriptions",
          instanceName(
            "subscriptions",
            args.publisherId,
            args.eventType,
            args.consumerId,
          ),
          list,
        );
      },
    },
    getSubscription: {
      description: "Get one subscription.",
      arguments: z.object({ subscriptionId: subArg }),
      execute: async (args: { subscriptionId: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `hooks/subscriptions/${args.subscriptionId}`,
          org,
        );
        return emit(
          ctx,
          "subscription",
          instanceName("subscription", args.subscriptionId),
          data,
        );
      },
    },
    createSubscription: {
      description:
        "DESTRUCTIVE (starts sending events to an external target): create a subscription. Secret consumer inputs go in secretConsumerInputs. Requires confirm: true.",
      arguments: z.object({ ...SubscriptionFields, confirm: ConfirmArg }),
      execute: async (args: SubArgs & { confirm: boolean }, ctx: any) => {
        requireConfirm(args.confirm, "create service hook subscription");
        const c = clientFrom(ctx);
        const data = await guarded(
          args.secretConsumerInputs,
          async () =>
            (await c.post<any>("hooks/subscriptions", subBody(args), org)).data,
        );
        return emit(
          ctx,
          "subscription",
          instanceName("subscription", data?.id),
          scrub(data, args.secretConsumerInputs),
        );
      },
    },
    replaceSubscription: {
      description:
        "DESTRUCTIVE: replace an existing subscription definition. Requires confirm: true.",
      arguments: z.object({
        subscriptionId: subArg,
        ...SubscriptionFields,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: SubArgs & { subscriptionId: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `replace subscription ${args.subscriptionId}`,
        );
        const c = clientFrom(ctx);
        const data = await guarded(
          args.secretConsumerInputs,
          async () =>
            (await c.put<any>(
              `hooks/subscriptions/${args.subscriptionId}`,
              { ...subBody(args), id: args.subscriptionId },
              org,
            )).data,
        );
        return emit(
          ctx,
          "subscription",
          instanceName("subscription", args.subscriptionId),
          scrub(data, args.secretConsumerInputs),
        );
      },
    },
    deleteSubscription: {
      description:
        "DESTRUCTIVE: delete a subscription. Requires confirm: true.",
      arguments: z.object({ subscriptionId: subArg, confirm: ConfirmArg }),
      execute: async (
        args: { subscriptionId: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `delete subscription ${args.subscriptionId}`,
        );
        const c = clientFrom(ctx);
        await c.delete(`hooks/subscriptions/${args.subscriptionId}`, org);
        return emit(
          ctx,
          "result",
          instanceName("deleted", args.subscriptionId),
          {
            subscriptionId: args.subscriptionId,
            deleted: true,
          },
        );
      },
    },
    testSubscription: {
      description:
        "DESTRUCTIVE (sends a test event to the external target): send a test notification for an existing subscription. Requires confirm: true.",
      arguments: z.object({ subscriptionId: subArg, confirm: ConfirmArg }),
      execute: async (
        args: { subscriptionId: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `test subscription ${args.subscriptionId}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.post<any>(
          "hooks/testnotifications",
          { subscriptionId: args.subscriptionId },
          { ...org, query: { useSubscriptionId: "true" } },
        );
        return emit(
          ctx,
          "notification",
          instanceName("test", args.subscriptionId),
          data ?? {},
        );
      },
    },
    listNotifications: {
      description: "List delivery notifications of a subscription.",
      arguments: z.object({
        subscriptionId: subArg,
        status: z.string().optional().describe(
          "e.g. 'failed', 'processing', 'queued', 'completed'.",
        ),
        result: z.string().optional().describe(
          "e.g. 'succeeded', 'failed', 'pending'.",
        ),
        maxResults: z.number().int().positive().optional(),
      }),
      execute: async (
        args: {
          subscriptionId: string;
          status?: string;
          result?: string;
          maxResults?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `hooks/subscriptions/${args.subscriptionId}/notifications`,
          {
            ...org,
            query: {
              status: args.status,
              result: args.result,
              maxResults: args.maxResults,
            },
          },
        );
        return emit(
          ctx,
          "notifications",
          instanceName("notifications", args.subscriptionId),
          list,
        );
      },
    },
    getNotification: {
      description: "Get one notification, including request/response details.",
      arguments: z.object({
        subscriptionId: subArg,
        notificationId: z.number().int().positive(),
      }),
      execute: async (
        args: { subscriptionId: string; notificationId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `hooks/subscriptions/${args.subscriptionId}/notifications/${args.notificationId}`,
          org,
        );
        return emit(
          ctx,
          "notification",
          instanceName(
            "notification",
            args.subscriptionId,
            args.notificationId,
          ),
          data,
        );
      },
    },
    queryNotifications: {
      description: "Query notifications across subscriptions by filter.",
      arguments: z.object({
        subscriptionIds: z.array(z.string()).default([]),
        status: z.string().optional(),
        result: z.string().optional(),
        publisherId: z.string().optional(),
        eventType: z.string().optional(),
        minCreatedDate: z.string().optional().describe("ISO 8601."),
        maxCreatedDate: z.string().optional().describe("ISO 8601."),
        maxResults: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          subscriptionIds: string[];
          status?: string;
          result?: string;
          publisherId?: string;
          eventType?: string;
          minCreatedDate?: string;
          maxCreatedDate?: string;
          maxResults: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post<{ results?: any[] }>(
          "hooks/notificationsquery",
          {
            subscriptionIds: args.subscriptionIds.length
              ? args.subscriptionIds
              : undefined,
            status: args.status,
            result: args.result,
            publisherId: args.publisherId,
            eventType: args.eventType,
            minCreatedDate: args.minCreatedDate,
            maxCreatedDate: args.maxCreatedDate,
            maxResults: args.maxResults,
            includeDetails: false,
          },
          org,
        );
        const items = data?.results ?? [];
        return emit(ctx, "notifications", "query", {
          count: items.length,
          items,
        });
      },
    },
  },
};
