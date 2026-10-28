import {
  AdoClient,
  AdoError,
  GlobalArgsSchema,
  instanceName,
  requireConfirm,
  serviceBaseUrl,
} from "./client.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const mkClient = (over: Record<string, unknown> = {}) =>
  new AdoClient(GlobalArgsSchema.parse({
    organization: "my-org",
    project: "my-project",
    token: "test-token",
    retryBaseMs: 0,
    ...over,
  }));

async function withFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((u: string, i?: RequestInit) =>
      Promise.resolve(impl(String(u), i))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}
const json = (b: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(b), init);

Deno.test("buildUrl: services org, project and api-version", () => {
  const url = mkClient().buildUrl("git/repositories");
  eq(
    url,
    "https://dev.azure.com/my-org/my-project/_apis/git/repositories?api-version=7.2",
  );
});

Deno.test("buildUrl: legacy and on-prem base URLs, preview, project null", () => {
  const legacy = mkClient({
    organization: undefined,
    baseUrl: "https://my-org.visualstudio.com/",
  });
  eq(
    legacy.buildUrl("projects", { project: null }),
    "https://my-org.visualstudio.com/_apis/projects?api-version=7.2",
  );
  const onprem = mkClient({
    baseUrl: "https://ado.example.com/tfs/DefaultCollection",
    apiVersion: "6.0",
  });
  eq(
    onprem.buildUrl("pipelines", { preview: 1 }),
    "https://ado.example.com/tfs/DefaultCollection/my-project/_apis/pipelines?api-version=6.0-preview.1",
  );
});

Deno.test("auth: PAT uses Basic, bearer uses Bearer", async () => {
  const seen: string[] = [];
  await withFetch((_u, init) => {
    seen.push((init?.headers as Record<string, string>).Authorization);
    return json({});
  }, async () => {
    await mkClient().get("x");
    await mkClient({ authType: "bearer" }).get("x");
  });
  eq(seen[0], `Basic ${btoa(":test-token")}`);
  eq(seen[1], "Bearer test-token");
});

Deno.test("list follows continuation tokens", async () => {
  let calls = 0;
  await withFetch((u) => {
    calls++;
    const token = new URL(u).searchParams.get("continuationToken");
    return token
      ? json({ value: [{ id: 3 }] })
      : json({ value: [{ id: 1 }, { id: 2 }] }, {
        headers: { "x-ms-continuationtoken": "next" },
      });
  }, async () => {
    const r = await mkClient().list("git/repositories");
    eq(r.count, 3);
    eq(calls, 2);
  });
});

Deno.test("list respects limit", async () => {
  await withFetch(() =>
    json({ value: [{ id: 1 }, { id: 2 }, { id: 3 }] }, {
      headers: { "x-ms-continuationtoken": "more" },
    }), async () => {
    const r = await mkClient().list("x", { limit: 2 });
    eq(r.count, 2);
  });
});

Deno.test("retries 429 and 5xx then succeeds", async () => {
  const statuses = [429, 503, 200];
  let i = 0;
  await withFetch(
    () => json({ ok: true }, { status: statuses[i++] }),
    async () => {
      const r = await mkClient().get<{ ok: boolean }>("x");
      eq(r.data.ok, true);
      eq(i, 3);
    },
  );
});

Deno.test("does not retry 4xx and surfaces the ADO message", async () => {
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({ message: "TF401019: The Git repository does not exist." }, {
      status: 404,
    });
  }, async () => {
    try {
      await mkClient().get("git/repositories/nope");
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof AdoError);
      assert(e.message.includes("TF401019"));
      eq(e.status, 404);
      assert(!e.message.includes("test-token"));
      assert(!e.message.includes("api-version"));
    }
  });
  eq(calls, 1);
});

Deno.test("gives up after maxRetries", async () => {
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({ message: "down" }, { status: 500 });
  }, async () => {
    try {
      await mkClient({ maxRetries: 2 }).get("x");
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof AdoError);
    }
  });
  eq(calls, 3);
});

Deno.test("falls back to -preview once when the server requires it", async () => {
  const versions: string[] = [];
  await withFetch((u) => {
    const v = new URL(u).searchParams.get("api-version")!;
    versions.push(v);
    return v.includes("preview") ? json({ value: [] }) : json({
      message: 'The requested version "7.2" of the resource is under preview.',
    }, { status: 400 });
  }, async () => {
    const c = mkClient();
    await c.get("a");
    await c.get("b");
  });
  eq(versions, ["7.2", "7.2-preview", "7.2-preview"]);
});

Deno.test("requireConfirm blocks by default", () => {
  let threw = false;
  try {
    requireConfirm(false, "delete thing");
  } catch {
    threw = true;
  }
  assert(threw);
  requireConfirm(true, "delete thing");
});

Deno.test("instanceName is Windows-safe", () => {
  eq(instanceName("pr", "feature/x:y"), "pr-feature_x_y");
});

Deno.test("serviceBaseUrl maps hosts for cloud, legacy and on-prem", () => {
  const g = (over: Record<string, unknown>) =>
    GlobalArgsSchema.parse({ token: "t", ...over });
  eq(
    serviceBaseUrl(g({ organization: "my-org" }), "vsrm"),
    "https://vsrm.dev.azure.com/my-org",
  );
  eq(
    serviceBaseUrl(g({ baseUrl: "https://my-org.visualstudio.com" }), "feeds"),
    "https://my-org.feeds.visualstudio.com/",
  );
  eq(
    serviceBaseUrl(g({ baseUrl: "https://ado.example.com/tfs/Coll" }), "vssps"),
    "https://ado.example.com/tfs/Coll",
  );
});

Deno.test("requires org or baseUrl", () => {
  let threw = false;
  try {
    mkClient({ organization: undefined }).buildUrl("x");
  } catch {
    threw = true;
  }
  assert(threw);
});
