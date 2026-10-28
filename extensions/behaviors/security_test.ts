// deno-lint-ignore-file no-explicit-any
import { behavior } from "./security.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

const NS = "58450c49-b02d-465a-ab12-59ae512d6531";

Deno.test("listSecurityNamespaces is org-level", async () => {
  const ctx = makeCtx();
  let path = "";
  await withFetch((u) => {
    path = new URL(u).pathname;
    return json({ value: [{ namespaceId: NS }] });
  }, async () => {
    await behavior.methods.listSecurityNamespaces.execute(
      { localOnly: false },
      ctx,
    );
  });
  eq(path, "/my-org/_apis/securitynamespaces");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("set/remove ACEs refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    await expectRejects(() =>
      behavior.methods.setAccessControlEntries.execute({
        namespaceId: NS,
        token: "t",
        merge: true,
        accessControlEntries: [{ descriptor: "d", allow: 1, deny: 0 }],
        confirm: false,
      }, ctx)
    );
    await expectRejects(() =>
      behavior.methods.removeAccessControlEntries.execute(
        { namespaceId: NS, token: "t", descriptors: ["d"], confirm: false },
        ctx,
      )
    );
  });
  eq(calls, 0);
});

Deno.test("setAccessControlEntries posts token, merge and entries", async () => {
  const ctx = makeCtx();
  let body: any = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ count: 1, value: [{ descriptor: "d", allow: 1, deny: 0 }] });
  }, async () => {
    await behavior.methods.setAccessControlEntries.execute({
      namespaceId: NS,
      token: "repoV2/p/r",
      merge: false,
      accessControlEntries: [{ descriptor: "d", allow: 1, deny: 0 }],
      confirm: true,
    }, ctx);
  });
  eq(body.token, "repoV2/p/r");
  eq(body.merge, false);
  eq(ctx.written[0].data.count, 1);
});

Deno.test("queryAccessControlEntries flattens acesDictionary", async () => {
  const ctx = makeCtx();
  await withFetch(() =>
    json({
      value: [{ token: "t", acesDictionary: { d1: { allow: 2, deny: 0 } } }],
    }), async () => {
    await behavior.methods.queryAccessControlEntries.execute(
      { namespaceId: NS, token: "t", includeExtendedInfo: false },
      ctx,
    );
  });
  eq(ctx.written[0].data.items[0].descriptor, "d1");
});

Deno.test("hasPermissions builds path and summarizes", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [true, true] });
  }, async () => {
    await behavior.methods.hasPermissions.execute({
      namespaceId: NS,
      permissions: 4,
      tokens: ["a", "b"],
      alwaysAllowAdministrators: false,
    }, ctx);
  });
  eq(new URL(url).pathname, `/my-org/_apis/permissions/${NS}/4`);
  eq(new URL(url).searchParams.get("tokens"), "a,b");
  eq(ctx.written[0].data.allGranted, true);
});
