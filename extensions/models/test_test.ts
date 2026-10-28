// deno-lint-ignore-file no-explicit-any
import { model as behavior } from "./test.ts";
import { eq, json, makeCtx, withFetch } from "./_lib/test_util.ts";

Deno.test("listTestCases hits the suite TestCase path", async () => {
  const ctx = makeCtx();
  let path = "";
  await withFetch((u) => {
    path = new URL(u).pathname;
    return json({ value: [{ workItem: { id: 1 } }] });
  }, async () => {
    await behavior.methods.listTestCases.execute(
      { planId: 3, suiteId: 4, limit: 10 },
      ctx,
    );
  });
  eq(path, "/my-org/my-project/_apis/testplan/Plans/3/Suites/4/TestCase");
  eq(ctx.written[0].name, "testcases-3-4");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("getCodeCoverageSummary uses preview and buildId", async () => {
  const ctx = makeCtx();
  let u = "";
  await withFetch((url) => {
    u = url;
    return json({ coverageData: [] });
  }, async () => {
    await behavior.methods.getCodeCoverageSummary.execute({ buildId: 77 }, ctx);
  });
  const p = new URL(u);
  eq(p.pathname, "/my-org/my-project/_apis/test/codecoverage");
  eq(p.searchParams.get("buildId"), "77");
  eq(p.searchParams.get("api-version"), "7.2-preview.1");
});

Deno.test("createTestRun posts a body and names the resource by id", async () => {
  const ctx = makeCtx();
  let body: any;
  let method = "";
  await withFetch((_u, i) => {
    method = i!.method!;
    body = JSON.parse(i!.body as string);
    return json({ id: 55 });
  }, async () => {
    await behavior.methods.createTestRun.execute(
      { name: "nightly", planId: 9, automated: true, buildId: 12 },
      ctx,
    );
  });
  eq(method, "POST");
  eq(body.plan, { id: "9" });
  eq(body.build, { id: "12" });
  eq(ctx.written[0].name, "testrun-55");
});

Deno.test("updateTestResults PATCHes the results array", async () => {
  const ctx = makeCtx();
  let body: any;
  let method = "";
  await withFetch((_u, i) => {
    method = i!.method!;
    body = JSON.parse(i!.body as string);
    return json({ count: 1, value: [{ id: 100000 }] });
  }, async () => {
    await behavior.methods.updateTestResults.execute(
      { runId: 5, results: [{ id: 100000, outcome: "Passed" }] },
      ctx,
    );
  });
  eq(method, "PATCH");
  eq(body[0].outcome, "Passed");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("listTestResults passes outcomes filter", async () => {
  const ctx = makeCtx();
  let u = "";
  await withFetch((url) => {
    u = url;
    return json({ value: [] });
  }, async () => {
    await behavior.methods.listTestResults.execute(
      { runId: 5, outcomes: ["Failed", "Aborted"], limit: 10 },
      ctx,
    );
  });
  eq(new URL(u).searchParams.get("outcomes"), "Failed,Aborted");
  eq(new URL(u).pathname, "/my-org/my-project/_apis/test/runs/5/results");
});
