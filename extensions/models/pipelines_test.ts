// deno-lint-ignore-file no-explicit-any
import { model as behavior } from "./pipelines.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listPipelines uses the preview api-version fallback", async () => {
  const ctx = makeCtx();
  let version = "";
  await withFetch((u) => {
    version = new URL(u).searchParams.get("api-version")!;
    return json({ value: [{ id: 1, name: "my-pipeline" }] });
  }, async () => {
    await behavior.methods.listPipelines.execute({ limit: 5 }, ctx);
  });
  eq(version, "7.2-preview.1");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("runPipeline refuses without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    await expectRejects(() =>
      behavior.methods.runPipeline.execute({
        pipelineId: 1,
        templateParameters: {},
        variables: {},
        confirm: false,
      }, ctx)
    );
  });
  eq(calls, 0);
});

Deno.test("runPipeline with confirm sends branch and variables", async () => {
  const ctx = makeCtx();
  let body: Record<string, any> = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ id: 12 });
  }, async () => {
    await behavior.methods.runPipeline.execute({
      pipelineId: 7,
      branch: "main",
      templateParameters: {},
      variables: { env: "dev" },
      confirm: true,
    }, ctx);
  });
  eq(body.resources.repositories.self.refName, "refs/heads/main");
  eq(body.variables.env.value, "dev");
  eq(ctx.written[0].name, "run-7-12");
});

Deno.test("listRunLogs flattens the logs array", async () => {
  const ctx = makeCtx();
  await withFetch(() => json({ logs: [{ id: 1 }, { id: 2 }] }), async () => {
    await behavior.methods.listRunLogs.execute(
      { pipelineId: 7, runId: 12 },
      ctx,
    );
  });
  eq(ctx.written[0].data.count, 2);
});
