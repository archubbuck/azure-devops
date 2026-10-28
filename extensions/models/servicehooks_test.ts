// deno-lint-ignore-file no-explicit-any
import { model as behavior } from "./servicehooks.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

const base = {
  publisherId: "tfs",
  eventType: "build.complete",
  resourceVersion: "1.0",
  consumerId: "webHooks",
  consumerActionId: "httpRequest",
  publisherInputs: { projectId: "p" },
  consumerInputs: { url: "https://example.com/hook" },
  secretConsumerInputs: { basicAuthPassword: "s3cr3t-pw" },
};

Deno.test("listSubscriptions is org-level and passes filters", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ id: "s1" }] });
  }, async () => {
    await behavior.methods.listSubscriptions.execute(
      { consumerId: "webHooks" },
      ctx,
    );
  });
  const u = new URL(url);
  eq(u.pathname, "/my-org/_apis/hooks/subscriptions");
  eq(u.searchParams.get("consumerId"), "webHooks");
});

Deno.test("subscription writes refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    const m = behavior.methods;
    await expectRejects(() =>
      m.createSubscription.execute({ ...base, confirm: false }, ctx)
    );
    await expectRejects(() =>
      m.replaceSubscription.execute({
        ...base,
        subscriptionId: "s",
        confirm: false,
      }, ctx)
    );
    await expectRejects(() =>
      m.deleteSubscription.execute({ subscriptionId: "s", confirm: false }, ctx)
    );
    await expectRejects(() =>
      m.testSubscription.execute({ subscriptionId: "s", confirm: false }, ctx)
    );
  });
  eq(calls, 0);
});

Deno.test("createSubscription merges secrets into the request but not the output", async () => {
  const ctx = makeCtx();
  let body: any = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    // simulate a server that wrongly echoes the secret
    return json({
      id: "s1",
      consumerInputs: { basicAuthPassword: "s3cr3t-pw" },
    });
  }, async () => {
    await behavior.methods.createSubscription.execute({
      ...base,
      confirm: true,
    }, ctx);
  });
  eq(body.consumerInputs.basicAuthPassword, "s3cr3t-pw");
  eq(body.consumerInputs.url, "https://example.com/hook");
  eq(JSON.stringify(ctx.written[0].data).includes("s3cr3t-pw"), false);
});

Deno.test("createSubscription errors never leak the secret", async () => {
  const ctx = makeCtx();
  await withFetch(
    () => json({ message: "bad input s3cr3t-pw" }, { status: 400 }),
    async () => {
      try {
        await behavior.methods.createSubscription.execute({
          ...base,
          confirm: true,
        }, ctx);
        throw new Error("should have failed");
      } catch (e) {
        eq((e as Error).message.includes("s3cr3t-pw"), false);
      }
    },
  );
});

Deno.test("queryNotifications posts filters and returns results", async () => {
  const ctx = makeCtx();
  let body: any = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ results: [{ id: 1 }, { id: 2 }] });
  }, async () => {
    await behavior.methods.queryNotifications.execute(
      { subscriptionIds: ["s1"], status: "failed", maxResults: 5 },
      ctx,
    );
  });
  eq(body.subscriptionIds, ["s1"]);
  eq(ctx.written[0].data.count, 2);
});
