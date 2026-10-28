import { model as behavior } from "./core.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listProjects is org-level (no project in path)", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ id: "p", name: "my-project" }] });
  }, async () => {
    await behavior.methods.listProjects.execute(
      { stateFilter: "wellFormed" },
      ctx,
    );
  });
  eq(url.startsWith("https://dev.azure.com/my-org/_apis/projects?"), true);
  eq(ctx.written[0].data.count, 1);
});

Deno.test("listTeams without a project lists org-wide", async () => {
  const ctx = makeCtx({ project: undefined });
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [] });
  }, async () => {
    await behavior.methods.listTeams.execute({ mine: false }, ctx);
  });
  eq(url.includes("/_apis/teams?"), true);
});

Deno.test("deleteProject and deleteTeam refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    await expectRejects(() =>
      behavior.methods.deleteProject.execute(
        { projectId: "id", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.deleteTeam.execute(
        { project: "my-project", team: "my-team", confirm: false },
        ctx,
      )
    );
  });
  eq(calls, 0);
});

Deno.test("createProject posts the requested settings", async () => {
  const ctx = makeCtx();
  let body: Record<string, unknown> = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ id: "op", status: "queued" });
  }, async () => {
    await behavior.methods.createProject.execute({
      name: "my-project",
      visibility: "private",
      sourceControlType: "Git",
    }, ctx);
  });
  eq(body.name, "my-project");
  eq(ctx.written[0].data.status, "queued");
});
