// deno-lint-ignore-file no-explicit-any
import { behavior } from "./graph.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listUsers targets the vssps host with preview version", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ displayName: "A" }] });
  }, async () => {
    await behavior.methods.listUsers.execute({ limit: 10 }, ctx);
  });
  const u = new URL(url);
  eq(u.host, "vssps.dev.azure.com");
  eq(u.pathname, "/my-org/_apis/graph/users");
  eq(u.searchParams.get("api-version"), "7.2-preview.1");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("createGroup and deleteGroup refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    await expectRejects(() =>
      behavior.methods.createGroup.execute(
        { displayName: "g", groupDescriptors: [], confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.deleteGroup.execute(
        { groupDescriptor: "vssgp.x", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.addMembership.execute(
        { subjectDescriptor: "a", containerDescriptor: "b", confirm: false },
        ctx,
      )
    );
  });
  eq(calls, 0);
});

Deno.test("addMembership PUTs subject/container", async () => {
  const ctx = makeCtx();
  let method = "";
  let path = "";
  await withFetch((u, init) => {
    method = init?.method ?? "";
    path = new URL(u).pathname;
    return json({ containerDescriptor: "b" });
  }, async () => {
    await behavior.methods.addMembership.execute(
      {
        subjectDescriptor: "aad.1",
        containerDescriptor: "vssgp.2",
        confirm: true,
      },
      ctx,
    );
  });
  eq(method, "PUT");
  eq(path, "/my-org/_apis/graph/memberships/aad.1/vssgp.2");
});

Deno.test("lookupSubjects posts lookupKeys", async () => {
  const ctx = makeCtx();
  let body: any = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ "aad.1": { displayName: "A" } });
  }, async () => {
    await behavior.methods.lookupSubjects.execute(
      { descriptors: ["aad.1"] },
      ctx,
    );
  });
  eq(body.lookupKeys, [{ descriptor: "aad.1" }]);
});
