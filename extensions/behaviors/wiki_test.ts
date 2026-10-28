// deno-lint-ignore-file no-explicit-any
import { behavior } from "./wiki.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("write methods refuse without confirm", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    await expectRejects(() =>
      behavior.methods.createOrUpdatePage.execute(
        { wikiIdentifier: "w", path: "/a", content: "x", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.deletePage.execute(
        { wikiIdentifier: "w", path: "/a", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.deleteWiki.execute(
        { wikiIdentifier: "w", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      behavior.methods.createWiki.execute(
        { name: "w", type: "projectWiki", mappedPath: "/", confirm: false },
        ctx,
      )
    );
  });
  eq(calls, 0);
});

Deno.test("createOrUpdatePage sends If-Match, path, comment and content", async () => {
  const ctx = makeCtx();
  let url = "";
  let init: any;
  await withFetch((u, i) => {
    url = u;
    init = i;
    return json({ id: 3, path: "/Home" });
  }, async () => {
    await behavior.methods.createOrUpdatePage.execute({
      wikiIdentifier: "my-wiki",
      path: "/Home",
      content: "# Hi",
      comment: "edit",
      etag: '"abc"',
      confirm: true,
    }, ctx);
  });
  const u = new URL(url);
  eq(init.method, "PUT");
  eq(u.pathname, "/my-org/my-project/_apis/wiki/wikis/my-wiki/pages");
  eq(u.searchParams.get("path"), "/Home");
  eq(u.searchParams.get("comment"), "edit");
  eq(init.headers["If-Match"], '"abc"');
  eq(JSON.parse(init.body), { content: "# Hi" });
});

Deno.test("createOrUpdatePage omits If-Match when creating", async () => {
  const ctx = makeCtx();
  let init: any;
  await withFetch((_u, i) => {
    init = i;
    return json({ id: 1 });
  }, async () => {
    await behavior.methods.createOrUpdatePage.execute(
      { wikiIdentifier: "w", path: "/N", content: "x", confirm: true },
      ctx,
    );
  });
  eq(init.headers["If-Match"], undefined);
});

Deno.test("getPage passes includeContent", async () => {
  const ctx = makeCtx();
  let url = "";
  await withFetch((u) => {
    url = u;
    return json({ path: "/Home", content: "x" });
  }, async () => {
    await behavior.methods.getPage.execute(
      { wikiIdentifier: "w", path: "/Home", includeContent: true },
      ctx,
    );
  });
  eq(new URL(url).searchParams.get("includeContent"), "true");
});

Deno.test("listPages follows continuation tokens via pagesbatch", async () => {
  const ctx = makeCtx();
  let n = 0;
  await withFetch(() => {
    n++;
    return n === 1
      ? json({ value: [{ id: 1 }] }, {
        headers: { "x-ms-continuationtoken": "t" },
      })
      : json({ value: [{ id: 2 }] });
  }, async () => {
    await behavior.methods.listPages.execute(
      { wikiIdentifier: "w", limit: 10 },
      ctx,
    );
  });
  eq(ctx.written[0].data.count, 2);
});
