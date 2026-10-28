import { behavior } from "./build.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listBuilds filters by definition and branch", async () => {
  const ctx = makeCtx();
  let url = new URL("https://x");
  await withFetch((u) => {
    url = new URL(u);
    return json({ value: [{ id: 1 }] });
  }, async () => {
    await behavior.methods.listBuilds.execute(
      { definitionIds: [4, 5], branch: "main", limit: 10 },
      ctx,
    );
  });
  eq(url.searchParams.get("definitions"), "4,5");
  eq(url.searchParams.get("branchName"), "refs/heads/main");
});

Deno.test("queueBuild and cancelBuild refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    await expectRejects(() =>
      behavior.methods.queueBuild.execute(
        { definitionId: 1, parameters: {}, confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.cancelBuild.execute({ buildId: 1, confirm: false }, ctx)
    );
    await expectRejects(() =>
      behavior.methods.deleteDefinition.execute(
        { definitionId: 1, confirm: false },
        ctx,
      )
    );
  });
  eq(calls, 0);
});

Deno.test("queueBuild with confirm posts the definition and branch", async () => {
  const ctx = makeCtx();
  let body: Record<string, unknown> = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ id: 9 });
  }, async () => {
    await behavior.methods.queueBuild.execute(
      { definitionId: 3, branch: "main", parameters: {}, confirm: true },
      ctx,
    );
  });
  eq(body.sourceBranch, "refs/heads/main");
  eq(ctx.written[0].name, "build-9");
});

Deno.test("getLog writes a text file", async () => {
  const ctx = makeCtx();
  let text = "";
  ctx.createFileWriter = () => ({
    writeText: (t: string) => {
      text = t;
      return Promise.resolve({ name: "log" });
    },
  });
  await withFetch(() => new Response("line1\nline2"), async () => {
    await behavior.methods.getLog.execute({ buildId: 1, logId: 2 }, ctx);
  });
  eq(text, "line1\nline2");
});

Deno.test("requires a project", async () => {
  const ctx = makeCtx({ project: undefined });
  await expectRejects(() =>
    behavior.methods.listDefinitions.execute({ limit: 5 }, ctx)
  );
});
