// deno-lint-ignore-file no-explicit-any
import { behavior } from "./workitems.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("createWorkItem sends a JSON Patch to wit/workitems/$Type", async () => {
  const ctx = makeCtx();
  let url = "";
  let init: RequestInit | undefined;
  await withFetch((u, i) => {
    url = u;
    init = i;
    return json({ id: 42 });
  }, async () => {
    await behavior.methods.createWorkItem.execute({
      type: "User Story",
      fields: { "System.Title": "Hello" },
      validateOnly: false,
      bypassRules: false,
      suppressNotifications: false,
    }, ctx);
  });
  const u = new URL(url);
  eq(u.pathname, "/my-org/my-project/_apis/wit/workitems/$User%20Story");
  eq(u.searchParams.get("api-version"), "7.2");
  eq((init!.headers as any)["Content-Type"], "application/json-patch+json");
  eq(JSON.parse(init!.body as string), [
    { op: "add", path: "/fields/System.Title", value: "Hello" },
  ]);
  eq(ctx.written[0].name, "workitem-42");
});

Deno.test("deleteWorkItem refuses without confirm and passes destroy", async () => {
  const ctx = makeCtx();
  let calls = 0;
  let url = "";
  await withFetch((u) => {
    calls++;
    url = u;
    return json({ id: 5 });
  }, async () => {
    await expectRejects(() =>
      behavior.methods.deleteWorkItem.execute(
        { id: 5, destroy: true, confirm: false },
        ctx,
      )
    );
    eq(calls, 0);
    await behavior.methods.deleteWorkItem.execute(
      { id: 5, destroy: true, confirm: true },
      ctx,
    );
  });
  eq(new URL(url).searchParams.get("destroy"), "true");
});

Deno.test("getWorkItems chunks ids into batches of 200", async () => {
  const ctx = makeCtx();
  const sizes: number[] = [];
  await withFetch((u) => {
    const ids = new URL(u).searchParams.get("ids")!.split(",");
    sizes.push(ids.length);
    return json({ value: ids.map((id) => ({ id: Number(id) })) });
  }, async () => {
    await behavior.methods.getWorkItems.execute({
      ids: Array.from({ length: 450 }, (_, i) => i + 1),
    }, ctx);
  });
  eq(sizes, [200, 200, 50]);
  eq(ctx.written[0].data.count, 450);
});

Deno.test("runWiql posts the query and hydrates items", async () => {
  const ctx = makeCtx();
  const seen: string[] = [];
  await withFetch((u, i) => {
    seen.push(`${i?.method} ${new URL(u).pathname}`);
    if (u.includes("/wit/wiql")) {
      eq(JSON.parse(i!.body as string), { query: "SELECT [System.Id]" });
      return json({ workItems: [{ id: 1 }, { id: 2 }] });
    }
    return json({ value: [{ id: 1 }, { id: 2 }] });
  }, async () => {
    await behavior.methods.runWiql.execute(
      { query: "SELECT [System.Id]", hydrate: true },
      ctx,
    );
  });
  eq(seen[0], "POST /my-org/my-project/_apis/wit/wiql");
  eq(ctx.written[0].data.ids, [1, 2]);
  eq(ctx.written[0].data.items.length, 2);
});

Deno.test("addComment uses 7.2-preview.4", async () => {
  const ctx = makeCtx();
  let version = "";
  await withFetch((u) => {
    version = new URL(u).searchParams.get("api-version")!;
    return json({ id: 9 });
  }, async () => {
    await behavior.methods.addComment.execute({ id: 3, text: "hi" }, ctx);
  });
  eq(version, "7.2-preview.4");
  eq(ctx.written[0].name, "comment-3-9");
});

Deno.test("removeLink refuses without confirm, then removes by index", async () => {
  const ctx = makeCtx();
  let patchBody: any[] = [];
  await withFetch((_u, i) => {
    if (i?.method === "PATCH") {
      patchBody = JSON.parse(i.body as string);
      return json({ id: 1 });
    }
    return json({
      id: 1,
      rev: 7,
      relations: [
        { rel: "AttachedFile", url: "https://x/attach/1" },
        {
          rel: "System.LinkTypes.Related",
          url: "https://x/_apis/wit/workItems/8",
        },
      ],
    });
  }, async () => {
    await expectRejects(() =>
      behavior.methods.removeLink.execute(
        { id: 1, targetId: 8, confirm: false },
        ctx,
      )
    );
    await behavior.methods.removeLink.execute(
      { id: 1, targetId: 8, confirm: true },
      ctx,
    );
  });
  eq(patchBody[1], { op: "remove", path: "/relations/1" });
});
