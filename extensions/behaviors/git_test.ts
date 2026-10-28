import { behavior } from "./git.ts";
import {
  eq,
  expectRejects,
  json,
  makeCtx,
  withFetch,
} from "./_lib/test_util.ts";

Deno.test("listRepositories writes a list resource", async () => {
  const ctx = makeCtx();
  await withFetch(
    () => json({ value: [{ id: "1", name: "my-repo" }], count: 1 }),
    async () => {
      await behavior.methods.listRepositories.execute(
        { includeHidden: false },
        ctx,
      );
    },
  );
  eq(ctx.written[0].spec, "repositories");
  eq(ctx.written[0].data.count, 1);
});

Deno.test("createPullRequest sends full ref names", async () => {
  const ctx = makeCtx();
  let body: Record<string, unknown> = {};
  await withFetch((_u, init) => {
    body = JSON.parse(init?.body as string);
    return json({ pullRequestId: 7, title: "T" });
  }, async () => {
    await behavior.methods.createPullRequest.execute({
      repository: "my-repo",
      sourceBranch: "feature/x",
      targetBranch: "main",
      title: "T",
      isDraft: false,
      reviewerIds: [],
      labels: [],
      workItemIds: [],
    }, ctx);
  });
  eq(body.sourceRefName, "refs/heads/feature/x");
  eq(body.targetRefName, "refs/heads/main");
  eq(ctx.written[0].name, "pr-7");
});

Deno.test("destructive methods refuse without confirm and never call HTTP", async () => {
  const ctx = makeCtx();
  let calls = 0;
  await withFetch(() => {
    calls++;
    return json({});
  }, async () => {
    const m = behavior.methods;
    await expectRejects(() =>
      m.abandonPullRequest.execute(
        { repository: "r", pullRequestId: 1, confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      m.completePullRequest.execute({
        repository: "r",
        pullRequestId: 1,
        mergeStrategy: "squash",
        deleteSourceBranch: false,
        confirm: false,
      }, ctx)
    );
    await expectRejects(() =>
      m.deleteBranch.execute(
        { repository: "r", name: "x", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      m.forceUpdateBranch.execute(
        { repository: "r", name: "x", newCommitId: "abc", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      m.deleteRepository.execute(
        { repositoryId: "id", confirm: false },
        ctx,
      )
    );
    await expectRejects(() =>
      m.removeReviewer.execute({
        repository: "r",
        pullRequestId: 1,
        reviewerId: "u",
        confirm: false,
      }, ctx)
    );
  });
  eq(calls, 0);
});

Deno.test("setVote resolves the caller identity when no reviewerId", async () => {
  const ctx = makeCtx();
  const urls: string[] = [];
  let body: Record<string, unknown> = {};
  await withFetch((u, init) => {
    urls.push(u);
    if (u.includes("connectionData")) {
      return json({ authenticatedUser: { id: "user-id" } });
    }
    body = JSON.parse(init?.body as string);
    return json({ id: "user-id", vote: 10 });
  }, async () => {
    await behavior.methods.setVote.execute({
      repository: "my-repo",
      pullRequestId: 3,
      vote: "approved",
    }, ctx);
  });
  eq(body.vote, 10);
  eq(urls[1].includes("/reviewers/user-id"), true);
});

Deno.test("createBranch fails clearly when the source branch is missing", async () => {
  const ctx = makeCtx();
  await withFetch(() => json({ value: [] }), async () => {
    await expectRejects(() =>
      behavior.methods.createBranch.execute(
        { repository: "my-repo", name: "feature/x", sourceBranch: "main" },
        ctx,
      )
    );
  });
});

Deno.test("listPullRequests pages with $skip until a short page", async () => {
  const ctx = makeCtx();
  const skips: string[] = [];
  await withFetch((u) => {
    const skip = new URL(u).searchParams.get("$skip")!;
    skips.push(skip);
    return json({ value: skip === "0" ? [{ pullRequestId: 1 }, { pullRequestId: 2 }] : [] });
  }, async () => {
    await behavior.methods.listPullRequests.execute(
      { status: "active", limit: 2 },
      ctx,
    );
  });
  eq(ctx.written[0].data.count, 2);
});

Deno.test("API errors surface the ADO message", async () => {
  const ctx = makeCtx();
  await withFetch(
    () => json({ message: "TF401019: not found" }, { status: 404 }),
    async () => {
      try {
        await behavior.methods.getRepository.execute(
          { repository: "nope" },
          ctx,
        );
        throw new Error("should fail");
      } catch (e) {
        eq((e as Error).message.includes("TF401019"), true);
      }
    },
  );
});
