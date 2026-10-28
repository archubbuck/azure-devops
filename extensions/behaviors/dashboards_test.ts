// deno-lint-ignore-file no-explicit-any
import { behavior } from "./dashboards.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

const D = "11111111-1111-1111-1111-111111111111";
const widget = {
  name: "Notes",
  contributionId:
    "ms.vss-dashboards-web.Microsoft.VisualStudioOnline.Dashboards.MarkdownWidget",
  position: { row: 1, column: 1 },
  size: { rowSpan: 1, columnSpan: 2 },
};

Deno.test("listDashboards is team scoped with preview.3", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ id: D }] });
  }, async () => {
    await behavior.methods.listDashboards.execute({ team: "my-team" }, ctx);
  });
  const u = new URL(url);
  eq(u.pathname, "/my-org/my-project/my-team/_apis/dashboard/dashboards");
  eq(u.searchParams.get("api-version"), "7.2-preview.3");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("omitted team resolves the default team once and caches it", async () => {
  const ctx = makeCtx();
  const urls: string[] = [];
  await withFetch((u) => {
    urls.push(u);
    return new URL(u).pathname.includes("/_apis/projects/")
      ? json({ id: "p", defaultTeam: { id: "team-guid-1" } })
      : json({ value: [] });
  }, async () => {
    await behavior.methods.listDashboards.execute({}, ctx);
    await behavior.methods.listWidgets.execute({ dashboardId: D }, ctx);
  });
  eq(new URL(urls[0]).pathname, "/my-org/_apis/projects/my-project");
  eq(
    new URL(urls[1]).pathname,
    "/my-org/my-project/team-guid-1/_apis/dashboard/dashboards",
  );
  eq(urls.filter((u) => u.includes("/_apis/projects/")).length, 1);
});

Deno.test("mutating dashboard methods refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    const m = behavior.methods;
    await expectRejects(() =>
      m.createDashboard.execute({ name: "d", widgets: [], confirm: false }, ctx)
    );
    await expectRejects(() =>
      m.updateDashboard.execute({
        dashboardId: D,
        name: "d",
        widgets: [],
        confirm: false,
      }, ctx)
    );
    await expectRejects(() =>
      m.deleteDashboard.execute({ dashboardId: D, confirm: false }, ctx)
    );
    await expectRejects(() =>
      m.addWidget.execute({ dashboardId: D, widget, confirm: false }, ctx)
    );
    await expectRejects(() =>
      m.updateWidget.execute({
        dashboardId: D,
        widgetId: "w",
        widget,
        confirm: false,
      }, ctx)
    );
    await expectRejects(() =>
      m.deleteWidget.execute(
        { dashboardId: D, widgetId: "w", confirm: false },
        ctx,
      )
    );
  });
  eq(calls, 0);
});

Deno.test("addWidget posts the widget body", async () => {
  const ctx = makeCtx();
  let body: any = {};
  let method = "";
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    method = init?.method ?? "";
    return json({ id: "w1", ...body });
  }, async () => {
    await behavior.methods.addWidget.execute(
      { team: "t", dashboardId: D, widget, confirm: true },
      ctx,
    );
  });
  eq(method, "POST");
  eq(body.name, "Notes");
  eq(ctx.written[0].name, `widget-${D}-w1`);
});

Deno.test("listWidgetTypes is project scoped", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ value: [{ id: "x" }] });
  }, async () => {
    await behavior.methods.listWidgetTypes.execute(
      { scope: "project_Team" },
      ctx,
    );
  });
  eq(new URL(url).pathname, "/my-org/my-project/_apis/dashboard/widgettypes");
});
