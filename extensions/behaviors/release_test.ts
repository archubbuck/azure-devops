// deno-lint-ignore-file no-explicit-any
import { behavior } from "./release.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listReleases uses the vsrm host and returns the continuation token", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ id: 1 }] }, {
      headers: { "x-ms-continuationtoken": "99" },
    });
  }, async () => {
    await behavior.methods.listReleases.execute(
      { definitionId: 4, top: 10, continuationToken: "120" },
      ctx,
    );
  });
  const u = new URL(url);
  eq(u.host, "vsrm.dev.azure.com");
  eq(u.pathname, "/my-org/my-project/_apis/release/releases");
  eq(u.searchParams.get("definitionId"), "4");
  eq(u.searchParams.get("continuationToken"), "120");
  eq(u.searchParams.get("api-version"), "7.2-preview.8");
  eq(ctx.written[0].data.nextPageToken, "99");
});

Deno.test("mutating methods refuse without confirm and make no request", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    const m = behavior.methods as any;
    const cases: [string, any][] = [
      ["createRelease", {
        definitionId: 1,
        artifacts: [],
        manualEnvironments: [],
        isDraft: false,
      }],
      ["startDeployment", { releaseId: 1, environmentId: 2, variables: {} }],
      ["updateReleaseEnvironment", {
        releaseId: 1,
        environmentId: 2,
        status: "canceled",
      }],
      ["updateApproval", { approvalId: 3, decision: "approved" }],
      ["abandonRelease", { releaseId: 1 }],
      ["deleteDefinition", { definitionId: 1, forceDelete: false }],
    ];
    for (const [name, args] of cases) {
      await expectRejects(() =>
        m[name].execute({ ...args, confirm: false }, ctx)
      );
    }
  });
  eq(calls, 0);
});

Deno.test("createRelease with confirm sends artifacts and manual stages", async () => {
  const ctx = makeCtx();
  let body: any = {};
  let method = "";
  await withFetch((_u, init) => {
    method = init?.method as string;
    body = JSON.parse(init?.body as string);
    return json({ id: 55, name: "Release-55" });
  }, async () => {
    await behavior.methods.createRelease.execute({
      definitionId: 4,
      description: "test",
      artifacts: [{ alias: "_app", versionId: "123" }],
      manualEnvironments: ["Prod"],
      isDraft: false,
      confirm: true,
    }, ctx);
  });
  eq(method, "POST");
  eq(body.definitionId, 4);
  eq(body.artifacts[0].instanceReference.id, "123");
  eq(body.manualEnvironments, ["Prod"]);
  eq(ctx.written[0].name, "release-55");
});

Deno.test("startDeployment patches the environment to inProgress", async () => {
  const ctx = makeCtx();
  let body: any = {};
  let url = "";
  await withFetch((u, init) => {
    url = u;
    body = JSON.parse(init?.body as string);
    return json({ id: 2 });
  }, async () => {
    await behavior.methods.startDeployment.execute(
      { releaseId: 9, environmentId: 2, variables: { v: "1" }, confirm: true },
      ctx,
    );
  });
  eq(new URL(url).host, "vsrm.dev.azure.com");
  eq(
    new URL(url).pathname.endsWith("/release/releases/9/environments/2"),
    true,
  );
  eq(body.status, "inProgress");
  eq(body.variables.v.value, "1");
});

Deno.test("updateApproval sends decision and comment", async () => {
  const ctx = makeCtx();
  let body: any = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ id: 3 });
  }, async () => {
    await behavior.methods.updateApproval.execute(
      { approvalId: 3, decision: "rejected", comment: "no", confirm: true },
      ctx,
    );
  });
  eq(body, { status: "rejected", comment: "no" });
});
