// deno-lint-ignore-file no-explicit-any
import { model as behavior } from "./artifacts.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listPackages uses the feeds host and org-scoped path", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ id: "a", name: "pkg" }] });
  }, async () => {
    await behavior.methods.listPackages.execute(
      {
        feed: "my-feed",
        protocolType: "NuGet",
        packageNameQuery: "pk",
        limit: 10,
      },
      ctx,
    );
  });
  const u = new URL(url);
  eq(u.host, "feeds.dev.azure.com");
  eq(u.pathname, "/my-org/_apis/packaging/feeds/my-feed/packages");
  eq(u.searchParams.get("protocolType"), "NuGet");
  eq(u.searchParams.get("packageNameQuery"), "pk");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("project-scoped feed includes the project in the path", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ id: "f", name: "my-feed" });
  }, async () => {
    await behavior.methods.getFeed.execute(
      { feed: "my-feed", project: "my-project" },
      ctx,
    );
  });
  eq(new URL(url).pathname, "/my-org/my-project/_apis/packaging/feeds/my-feed");
});

Deno.test("destructive methods refuse without confirm and make no request", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    const m = behavior.methods as any;
    const cases: [string, any][] = [
      ["createFeed", {
        name: "x",
        upstreamEnabled: false,
        hideDeletedPackageVersions: true,
      }],
      ["deleteFeed", { feed: "x" }],
      ["deletePackageVersion", {
        feed: "x",
        protocol: "nuget",
        packageName: "p",
        version: "1.0.0",
      }],
      ["promotePackageVersion", {
        feed: "x",
        protocol: "nuget",
        packageName: "p",
        version: "1.0.0",
        view: "Release",
        op: "add",
      }],
    ];
    for (const [name, args] of cases) {
      await expectRejects(() =>
        m[name].execute({ ...args, confirm: false }, ctx)
      );
    }
  });
  eq(calls, 0);
});

Deno.test("promotePackageVersion patches views on the protocol path", async () => {
  const ctx = makeCtx();
  let url = "";
  let method = "";
  let body: any = {};
  await withFetch((u, init) => {
    url = u;
    method = init?.method as string;
    body = JSON.parse(init?.body as string);
    return new Response(null, { status: 200 });
  }, async () => {
    await behavior.methods.promotePackageVersion.execute({
      feed: "my-feed",
      protocol: "npm",
      packageName: "@my-scope/pkg",
      version: "1.2.3",
      view: "Release",
      op: "add",
      confirm: true,
    }, ctx);
  });
  eq(method, "PATCH");
  eq(
    new URL(url).pathname,
    "/my-org/_apis/packaging/feeds/my-feed/npm/my-scope/pkg/versions/1.2.3",
  );
  eq(body.views, { op: "add", path: "/views/-", value: "Release" });
});

Deno.test("getBuildArtifact uses the normal host with artifactName", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ id: 1, name: "drop" });
  }, async () => {
    await behavior.methods.getBuildArtifact.execute(
      { buildId: 42, artifactName: "drop" },
      ctx,
    );
  });
  const u = new URL(url);
  eq(u.host, "dev.azure.com");
  eq(u.pathname, "/my-org/my-project/_apis/build/builds/42/artifacts");
  eq(u.searchParams.get("artifactName"), "drop");
});
