// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4";
import {
  clientFrom,
  ConfirmArg,
  emit,
  GlobalArgsSchema,
  instanceName,
  ListSchema,
  ProjectArg,
  requireConfirm,
} from "./_lib/client.ts";

const ZERO_OID = "0000000000000000000000000000000000000000";

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const RepoSchema = z.object({
  id: z.string(),
  name: z.string(),
  defaultBranch: z.string().optional(),
  webUrl: z.string().optional(),
  remoteUrl: z.string().optional(),
}).passthrough();
const PrSchema = z.object({
  pullRequestId: z.number(),
  title: z.string().optional(),
  status: z.string().optional(),
  sourceRefName: z.string().optional(),
  targetRefName: z.string().optional(),
  isDraft: z.boolean().optional(),
}).passthrough();
const CommitSchema = z.object({
  commitId: z.string(),
  comment: z.string().optional(),
}).passthrough();
const PushSchema = z.object({ pushId: z.number() }).passthrough();
const ThreadSchema = z.object({
  id: z.number(),
  status: z.string().optional(),
}).passthrough();
const ReviewerSchema = z.object({
  id: z.string(),
  vote: z.number().optional(),
}).passthrough();
const ResultSchema = z.object({
  operation: z.string(),
  target: z.string(),
  status: z.string(),
  detail: z.unknown().optional(),
}).passthrough();

const repoArg = z.string().describe("Repository name or ID (e.g. 'my-repo').");
const prArg = z.number().int().positive().describe("Pull request ID.");
const limitArg = z.number().int().positive().optional().describe(
  "Stop after this many items; omit to fetch everything.",
);

const fullRef = (name: string, kind = "heads") =>
  name.startsWith("refs/") ? name : `refs/${kind}/${name}`;
const enc = encodeURIComponent;
const repoPath = (repo: string) => `git/repositories/${enc(repo)}`;

/** Pull request vote names mapped to their Azure DevOps numeric values. */
export const VOTES = {
  approved: 10,
  approvedWithSuggestions: 5,
  noVote: 0,
  waitingForAuthor: -5,
  rejected: -10,
} as const;

const THREAD_STATUS = [
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending",
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Azure DevOps Git model: repositories, branches, pull requests, threads and votes. */
export const model = {
  type: "@adamchubbuck/azure-devops/git",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    repository: spec("A single Git repository", RepoSchema),
    repositories: spec("List of Git repositories", ListSchema),
    refs: spec("List of refs or branches", ListSchema),
    commit: spec("A single commit", CommitSchema),
    commits: spec("List of commits", ListSchema),
    push: spec("A single push", PushSchema),
    pushes: spec("List of pushes", ListSchema),
    pullRequest: spec("A single pull request", PrSchema),
    pullRequests: spec("List of pull requests", ListSchema),
    thread: spec("A single PR comment thread", ThreadSchema),
    threads: spec("List of PR comment threads", ListSchema),
    reviewer: spec("A single PR reviewer", ReviewerSchema),
    reviewers: spec("List of PR reviewers", ListSchema),
    policies: spec("Branch policy configurations or evaluations", ListSchema),
    result: spec("Outcome of a write operation", ResultSchema),
  },
  methods: {
    /* ---------------- repositories ---------------- */
    listRepositories: {
      description:
        "List Git repositories in a project, or in the whole organization when no project is set.",
      arguments: z.object({
        project: ProjectArg,
        includeHidden: z.boolean().default(false),
      }),
      execute: async (
        args: { project?: string; includeHidden: boolean },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("git/repositories", {
          project: args.project,
          query: { includeHidden: args.includeHidden || undefined },
        });
        return emit(
          ctx,
          "repositories",
          instanceName("repos", args.project ?? ctx.globalArgs.project),
          list,
        );
      },
    },
    getRepository: {
      description: "Get one repository by name or ID.",
      arguments: z.object({ project: ProjectArg, repository: repoArg }),
      execute: async (
        args: { project?: string; repository: string },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(repoPath(args.repository), {
          project: args.project,
        });
        return emit(
          ctx,
          "repository",
          instanceName("repo", args.repository),
          data,
        );
      },
    },
    createRepository: {
      description: "Create a new Git repository in a project.",
      arguments: z.object({
        project: ProjectArg,
        name: z.string().describe("New repository name (e.g. 'my-repo')."),
      }),
      execute: async (args: { project?: string; name: string }, ctx: any) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const { data } = await c.post("git/repositories", { name: args.name }, {
          project,
        });
        return emit(ctx, "repository", instanceName("repo", args.name), data);
      },
    },
    updateRepository: {
      description:
        "Rename a repository, change its default branch, or disable it.",
      arguments: z.object({
        project: ProjectArg,
        repositoryId: z.string().describe("Repository ID (GUID)."),
        name: z.string().optional(),
        defaultBranch: z.string().optional().describe(
          "e.g. 'main' or 'refs/heads/main'.",
        ),
        isDisabled: z.boolean().optional(),
      }),
      execute: async (
        args: {
          project?: string;
          repositoryId: string;
          name?: string;
          defaultBranch?: string;
          isDisabled?: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.patch(repoPath(args.repositoryId), {
          name: args.name,
          defaultBranch: args.defaultBranch
            ? fullRef(args.defaultBranch)
            : undefined,
          isDisabled: args.isDisabled,
        }, { project: args.project });
        return emit(
          ctx,
          "repository",
          instanceName("repo", args.repositoryId),
          data,
        );
      },
    },
    deleteRepository: {
      description:
        "DESTRUCTIVE: delete a repository (moves it to the recycle bin). Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        repositoryId: z.string().describe("Repository ID (GUID)."),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: { project?: string; repositoryId: string; confirm: boolean },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete repository ${args.repositoryId}`);
        const c = clientFrom(ctx);
        await c.delete(repoPath(args.repositoryId), { project: args.project });
        return emit(
          ctx,
          "result",
          instanceName("delete-repo", args.repositoryId),
          {
            operation: "deleteRepository",
            target: args.repositoryId,
            status: "deleted",
          },
        );
      },
    },

    /* ---------------- branches & refs ---------------- */
    listBranches: {
      description: "List branches of a repository with ahead/behind stats.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        filter: z.string().optional().describe(
          "Only branches whose name starts with this, e.g. 'feature/'.",
        ),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          filter?: string;
          limit?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`${repoPath(args.repository)}/refs`, {
          project: args.project,
          limit: args.limit,
          query: { filter: `heads/${args.filter ?? ""}`, $top: 1000 },
        });
        return emit(
          ctx,
          "refs",
          instanceName("branches", args.repository),
          list,
        );
      },
    },
    listRefs: {
      description:
        "List refs (branches, tags, ...) of a repository, optionally filtered, e.g. filter 'tags/'.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        filter: z.string().optional().describe("Ref prefix after 'refs/'."),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          filter?: string;
          limit?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`${repoPath(args.repository)}/refs`, {
          project: args.project,
          limit: args.limit,
          query: { filter: args.filter, $top: 1000 },
        });
        return emit(ctx, "refs", instanceName("refs", args.repository), list);
      },
    },
    createBranch: {
      description:
        "Create a branch from another branch or a commit. Fails if the branch already exists.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        name: z.string().describe("New branch name, e.g. 'feature/x'."),
        sourceBranch: z.string().optional().describe(
          "Branch to branch from, e.g. 'main'. Ignored when commitId is set.",
        ),
        commitId: z.string().optional().describe("Commit SHA to branch from."),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          name: string;
          sourceBranch?: string;
          commitId?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        let sha = args.commitId;
        if (!sha) {
          if (!args.sourceBranch) {
            throw new Error("Provide sourceBranch or commitId.");
          }
          const src = fullRef(args.sourceBranch);
          const refs = await c.list<{ name: string; objectId: string }>(
            `${repoPath(args.repository)}/refs`,
            {
              project: args.project,
              query: { filter: src.replace(/^refs\//, "") },
            },
          );
          sha = refs.items.find((r) => r.name === src)?.objectId;
          if (!sha) throw new Error(`Source branch '${src}' was not found.`);
        }
        const { data } = await c.post<{ value: Record<string, unknown>[] }>(
          `${repoPath(args.repository)}/refs`,
          [{
            name: fullRef(args.name),
            oldObjectId: ZERO_OID,
            newObjectId: sha,
          }],
          { project: args.project },
        );
        const r = data.value?.[0] ?? {};
        if (r.success === false) {
          throw new Error(
            `Branch not created: ${r.customMessage ?? r.updateStatus}`,
          );
        }
        return emit(ctx, "result", instanceName("create-branch", args.name), {
          operation: "createBranch",
          target: fullRef(args.name),
          status: "created",
          detail: r,
        });
      },
    },
    deleteBranch: {
      description: "DESTRUCTIVE: delete a branch. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        name: z.string().describe("Branch name, e.g. 'feature/x'."),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          name: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `delete branch ${args.name}`);
        const c = clientFrom(ctx);
        const ref = fullRef(args.name);
        const refs = await c.list<{ name: string; objectId: string }>(
          `${repoPath(args.repository)}/refs`,
          {
            project: args.project,
            query: { filter: ref.replace(/^refs\//, "") },
          },
        );
        const sha = refs.items.find((r) => r.name === ref)?.objectId;
        if (!sha) throw new Error(`Branch '${ref}' was not found.`);
        const { data } = await c.post<{ value: Record<string, unknown>[] }>(
          `${repoPath(args.repository)}/refs`,
          [{ name: ref, oldObjectId: sha, newObjectId: ZERO_OID }],
          { project: args.project },
        );
        return emit(ctx, "result", instanceName("delete-branch", args.name), {
          operation: "deleteBranch",
          target: ref,
          status: "deleted",
          detail: data.value?.[0],
        });
      },
    },
    forceUpdateBranch: {
      description:
        "DESTRUCTIVE: force-move a branch to a commit, discarding commits not reachable from it. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        name: z.string().describe("Branch name."),
        newCommitId: z.string().describe(
          "Commit SHA the branch should point to.",
        ),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          name: string;
          newCommitId: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `force-update branch ${args.name}`);
        const c = clientFrom(ctx);
        const ref = fullRef(args.name);
        const refs = await c.list<{ name: string; objectId: string }>(
          `${repoPath(args.repository)}/refs`,
          {
            project: args.project,
            query: { filter: ref.replace(/^refs\//, "") },
          },
        );
        const sha = refs.items.find((r) => r.name === ref)?.objectId;
        if (!sha) throw new Error(`Branch '${ref}' was not found.`);
        const { data } = await c.post<{ value: Record<string, unknown>[] }>(
          `${repoPath(args.repository)}/refs`,
          [{ name: ref, oldObjectId: sha, newObjectId: args.newCommitId }],
          { project: args.project },
        );
        return emit(ctx, "result", instanceName("force-update", args.name), {
          operation: "forceUpdateBranch",
          target: ref,
          status: "updated",
          detail: data.value?.[0],
        });
      },
    },

    /* ---------------- commits & pushes ---------------- */
    listCommits: {
      description:
        "List commits on a branch, optionally filtered by path, author or dates.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        branch: z.string().optional().describe("Branch name, e.g. 'main'."),
        path: z.string().optional().describe(
          "Only commits touching this path.",
        ),
        author: z.string().optional(),
        fromDate: z.string().optional().describe("ISO date."),
        toDate: z.string().optional().describe("ISO date."),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          branch?: string;
          path?: string;
          author?: string;
          fromDate?: string;
          toDate?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`${repoPath(args.repository)}/commits`, {
          project: args.project,
          limit: args.limit,
          query: {
            "searchCriteria.itemVersion.version": args.branch,
            "searchCriteria.itemPath": args.path,
            "searchCriteria.author": args.author,
            "searchCriteria.fromDate": args.fromDate,
            "searchCriteria.toDate": args.toDate,
            "searchCriteria.$top": Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "commits",
          instanceName("commits", args.repository),
          list,
        );
      },
    },
    getCommit: {
      description: "Get one commit by SHA, optionally with change counts.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        commitId: z.string(),
        changeCount: z.number().int().min(0).optional(),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          commitId: string;
          changeCount?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `${repoPath(args.repository)}/commits/${enc(args.commitId)}`,
          { project: args.project, query: { changeCount: args.changeCount } },
        );
        return emit(ctx, "commit", instanceName("commit", args.commitId), data);
      },
    },
    listPushes: {
      description: "List pushes to a repository, optionally for one branch.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        branch: z.string().optional(),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          branch?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`${repoPath(args.repository)}/pushes`, {
          project: args.project,
          limit: args.limit,
          query: {
            "searchCriteria.refName": args.branch
              ? fullRef(args.branch)
              : undefined,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "pushes",
          instanceName("pushes", args.repository),
          list,
        );
      },
    },
    getPush: {
      description: "Get one push by ID, including its commits.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pushId: z.number().int().positive(),
      }),
      execute: async (
        args: { project?: string; repository: string; pushId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `${repoPath(args.repository)}/pushes/${args.pushId}`,
          { project: args.project, query: { includeCommits: 100 } },
        );
        return emit(ctx, "push", instanceName("push", args.pushId), data);
      },
    },
    createPush: {
      description:
        "Push one commit that adds, edits or deletes files on a branch. Creates the branch when it does not exist. Never force-pushes: fails if the branch moved.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        branch: z.string().describe("Target branch, e.g. 'feature/x'."),
        message: z.string().describe("Commit message."),
        changes: z.array(z.object({
          changeType: z.enum(["add", "edit", "delete"]),
          path: z.string().describe("Repo path, e.g. '/docs/readme.md'."),
          content: z.string().optional().describe(
            "UTF-8 text content. Required for add and edit.",
          ),
        })).min(1),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          branch: string;
          message: string;
          changes: {
            changeType: "add" | "edit" | "delete";
            path: string;
            content?: string;
          }[];
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const ref = fullRef(args.branch);
        const refs = await c.list<{ name: string; objectId: string }>(
          `${repoPath(args.repository)}/refs`,
          {
            project: args.project,
            query: { filter: ref.replace(/^refs\//, "") },
          },
        );
        const oldObjectId = refs.items.find((r) => r.name === ref)?.objectId ??
          ZERO_OID;
        const changes = args.changes.map((ch) => {
          if (ch.changeType !== "delete" && ch.content === undefined) {
            throw new Error(`Change for ${ch.path} needs 'content'.`);
          }
          return {
            changeType: ch.changeType,
            item: { path: ch.path },
            newContent: ch.changeType === "delete"
              ? undefined
              : { content: ch.content, contentType: "rawtext" },
          };
        });
        const { data } = await c.post(`${repoPath(args.repository)}/pushes`, {
          refUpdates: [{ name: ref, oldObjectId }],
          commits: [{ comment: args.message, changes }],
        }, { project: args.project });
        return emit(
          ctx,
          "push",
          instanceName("push", (data as any)?.pushId ?? Date.now()),
          data,
        );
      },
    },

    /* ---------------- pull requests ---------------- */
    listPullRequests: {
      description:
        "List pull requests in a repository (or the whole project when no repository is given).",
      arguments: z.object({
        project: ProjectArg,
        repository: z.string().optional(),
        status: z.enum(["active", "abandoned", "completed", "all"]).default(
          "active",
        ),
        sourceBranch: z.string().optional(),
        targetBranch: z.string().optional(),
        creatorId: z.string().optional(),
        reviewerId: z.string().optional(),
        limit: z.number().int().positive().default(100),
      }),
      execute: async (
        args: {
          project?: string;
          repository?: string;
          status: string;
          sourceBranch?: string;
          targetBranch?: string;
          creatorId?: string;
          reviewerId?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const path = args.repository
          ? `${repoPath(args.repository)}/pullrequests`
          : "git/pullrequests";
        const pageSize = Math.min(args.limit, 100);
        const items: unknown[] = [];
        // Pull requests page with $skip rather than continuation tokens.
        for (let skip = 0; items.length < args.limit; skip += pageSize) {
          const { data } = await c.get<{ value: unknown[] }>(path, {
            project: args.project,
            query: {
              "searchCriteria.status": args.status,
              "searchCriteria.sourceRefName": args.sourceBranch
                ? fullRef(args.sourceBranch)
                : undefined,
              "searchCriteria.targetRefName": args.targetBranch
                ? fullRef(args.targetBranch)
                : undefined,
              "searchCriteria.creatorId": args.creatorId,
              "searchCriteria.reviewerId": args.reviewerId,
              $top: pageSize,
              $skip: skip,
            },
          });
          const batch = data?.value ?? [];
          items.push(...batch);
          if (batch.length < pageSize) break;
        }
        const out = items.slice(0, args.limit);
        return emit(
          ctx,
          "pullRequests",
          instanceName("prs", args.repository ?? "project", args.status),
          { count: out.length, items: out },
        );
      },
    },
    getPullRequest: {
      description: "Get one pull request by ID.",
      arguments: z.object({
        project: ProjectArg,
        repository: z.string().optional().describe(
          "Optional; the ID alone is enough within a project.",
        ),
        pullRequestId: prArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository?: string;
          pullRequestId: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const path = args.repository
          ? `${repoPath(args.repository)}/pullrequests/${args.pullRequestId}`
          : `git/pullrequests/${args.pullRequestId}`;
        const { data } = await c.get(path, { project: args.project });
        return emit(
          ctx,
          "pullRequest",
          instanceName("pr", args.pullRequestId),
          data,
        );
      },
    },
    createPullRequest: {
      description:
        "Create a pull request, e.g. from 'feature/x' into 'main'. Reuses nothing: fails if an active PR for the same branches exists.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        sourceBranch: z.string().describe("e.g. 'feature/x'"),
        targetBranch: z.string().describe("e.g. 'main'"),
        title: z.string(),
        description: z.string().optional(),
        isDraft: z.boolean().default(false),
        reviewerIds: z.array(z.string()).default([]).describe(
          "Identity IDs of reviewers to add.",
        ),
        labels: z.array(z.string()).default([]),
        workItemIds: z.array(z.number().int()).default([]).describe(
          "Work items to link.",
        ),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          sourceBranch: string;
          targetBranch: string;
          title: string;
          description?: string;
          isDraft: boolean;
          reviewerIds: string[];
          labels: string[];
          workItemIds: number[];
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post<{ pullRequestId: number }>(
          `${repoPath(args.repository)}/pullrequests`,
          {
            sourceRefName: fullRef(args.sourceBranch),
            targetRefName: fullRef(args.targetBranch),
            title: args.title,
            description: args.description,
            isDraft: args.isDraft,
            reviewers: args.reviewerIds.map((id) => ({ id })),
            labels: args.labels.map((name) => ({ name })),
            workItemRefs: args.workItemIds.map((id) => ({ id: String(id) })),
          },
          { project: args.project },
        );
        return emit(
          ctx,
          "pullRequest",
          instanceName("pr", data.pullRequestId),
          data,
        );
      },
    },
    updatePullRequest: {
      description:
        "Update a pull request's title, description, target branch or draft state. Does not abandon or complete it.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        title: z.string().optional(),
        description: z.string().optional(),
        targetBranch: z.string().optional(),
        isDraft: z.boolean().optional(),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          title?: string;
          description?: string;
          targetBranch?: string;
          isDraft?: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.patch(
          `${repoPath(args.repository)}/pullrequests/${args.pullRequestId}`,
          {
            title: args.title,
            description: args.description,
            targetRefName: args.targetBranch
              ? fullRef(args.targetBranch)
              : undefined,
            isDraft: args.isDraft,
          },
          { project: args.project },
        );
        return emit(
          ctx,
          "pullRequest",
          instanceName("pr", args.pullRequestId),
          data,
        );
      },
    },
    abandonPullRequest: {
      description:
        "DESTRUCTIVE: abandon (close without merging) a pull request. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `abandon pull request ${args.pullRequestId}`,
        );
        const c = clientFrom(ctx);
        const { data } = await c.patch(
          `${repoPath(args.repository)}/pullrequests/${args.pullRequestId}`,
          { status: "abandoned" },
          { project: args.project },
        );
        return emit(
          ctx,
          "pullRequest",
          instanceName("pr", args.pullRequestId),
          data,
        );
      },
    },
    completePullRequest: {
      description:
        "DESTRUCTIVE: complete (merge) a pull request using its current source commit. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        mergeStrategy: z.enum([
          "noFastForward",
          "squash",
          "rebase",
          "rebaseMerge",
        ])
          .default("squash"),
        deleteSourceBranch: z.boolean().default(false),
        mergeCommitMessage: z.string().optional(),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          mergeStrategy: string;
          deleteSourceBranch: boolean;
          mergeCommitMessage?: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(
          args.confirm,
          `complete pull request ${args.pullRequestId}`,
        );
        const c = clientFrom(ctx);
        const path = `${
          repoPath(args.repository)
        }/pullrequests/${args.pullRequestId}`;
        const { data: pr } = await c.get<any>(path, { project: args.project });
        const { data } = await c.patch(path, {
          status: "completed",
          lastMergeSourceCommit: pr.lastMergeSourceCommit,
          completionOptions: {
            mergeStrategy: args.mergeStrategy,
            deleteSourceBranch: args.deleteSourceBranch,
            mergeCommitMessage: args.mergeCommitMessage,
          },
        }, { project: args.project });
        return emit(
          ctx,
          "pullRequest",
          instanceName("pr", args.pullRequestId),
          data,
        );
      },
    },

    /* ---------------- threads ---------------- */
    listThreads: {
      description: "List comment threads on a pull request.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/threads`,
          { project: args.project },
        );
        return emit(
          ctx,
          "threads",
          instanceName("threads", args.pullRequestId),
          list,
        );
      },
    },
    createThread: {
      description:
        "Start a comment thread on a pull request, general or anchored to a file line.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        content: z.string().describe("Markdown comment text."),
        status: z.enum(THREAD_STATUS).default("active"),
        filePath: z.string().optional().describe("e.g. '/src/app.ts'."),
        line: z.number().int().positive().optional().describe(
          "Line in the right (new) side of the file; requires filePath.",
        ),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          content: string;
          status: string;
          filePath?: string;
          line?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const threadContext = args.filePath
          ? {
            filePath: args.filePath,
            rightFileStart: { line: args.line ?? 1, offset: 1 },
            rightFileEnd: { line: args.line ?? 1, offset: 2 },
          }
          : undefined;
        const { data } = await c.post<{ id: number }>(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/threads`,
          {
            comments: [{
              parentCommentId: 0,
              content: args.content,
              commentType: 1,
            }],
            status: args.status,
            threadContext,
          },
          { project: args.project },
        );
        return emit(
          ctx,
          "thread",
          instanceName("thread", args.pullRequestId, data.id),
          data,
        );
      },
    },
    replyToThread: {
      description: "Add a reply comment to an existing pull request thread.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        threadId: z.number().int().positive(),
        content: z.string(),
        parentCommentId: z.number().int().min(0).default(1),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          threadId: number;
          content: string;
          parentCommentId: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/threads/${args.threadId}/comments`,
          {
            content: args.content,
            parentCommentId: args.parentCommentId,
            commentType: 1,
          },
          { project: args.project },
        );
        return emit(
          ctx,
          "result",
          instanceName("reply", args.pullRequestId, args.threadId),
          {
            operation: "replyToThread",
            target: `${args.pullRequestId}/${args.threadId}`,
            status: "created",
            detail: data,
          },
        );
      },
    },
    updateThreadStatus: {
      description:
        "Set a pull request thread's status, e.g. resolve it as 'fixed'.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        threadId: z.number().int().positive(),
        status: z.enum(THREAD_STATUS),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          threadId: number;
          status: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.patch(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/threads/${args.threadId}`,
          { status: args.status },
          { project: args.project },
        );
        return emit(
          ctx,
          "thread",
          instanceName("thread", args.pullRequestId, args.threadId),
          data,
        );
      },
    },

    /* ---------------- reviewers & votes ---------------- */
    listReviewers: {
      description: "List reviewers of a pull request with their votes.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/reviewers`,
          { project: args.project },
        );
        return emit(
          ctx,
          "reviewers",
          instanceName("reviewers", args.pullRequestId),
          list,
        );
      },
    },
    addReviewer: {
      description:
        "Add a reviewer (user or group identity ID) to a pull request.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        reviewerId: z.string().describe("Identity ID (GUID)."),
        isRequired: z.boolean().default(false),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          reviewerId: string;
          isRequired: boolean;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.put(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/reviewers/${
            enc(args.reviewerId)
          }`,
          { id: args.reviewerId, vote: 0, isRequired: args.isRequired },
          { project: args.project },
        );
        return emit(
          ctx,
          "reviewer",
          instanceName("reviewer", args.pullRequestId, args.reviewerId),
          data,
        );
      },
    },
    setVote: {
      description:
        "Cast a vote on a pull request as the authenticated identity (or another reviewer ID).",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        vote: z.enum([
          "approved",
          "approvedWithSuggestions",
          "noVote",
          "waitingForAuthor",
          "rejected",
        ]),
        reviewerId: z.string().optional().describe(
          "Defaults to the identity that owns the token.",
        ),
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          vote: keyof typeof VOTES;
          reviewerId?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        let id = args.reviewerId;
        if (!id) {
          const { data } = await c.get<any>("connectionData", {
            project: null,
            preview: 1,
          });
          id = data?.authenticatedUser?.id;
          if (!id) {
            throw new Error("Could not determine the caller's identity ID.");
          }
        }
        const { data } = await c.put(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/reviewers/${enc(id)}`,
          { id, vote: VOTES[args.vote] },
          { project: args.project },
        );
        return emit(
          ctx,
          "reviewer",
          instanceName("reviewer", args.pullRequestId, id),
          data,
        );
      },
    },
    removeReviewer: {
      description:
        "DESTRUCTIVE: remove a reviewer from a pull request. Requires confirm: true.",
      arguments: z.object({
        project: ProjectArg,
        repository: repoArg,
        pullRequestId: prArg,
        reviewerId: z.string(),
        confirm: ConfirmArg,
      }),
      execute: async (
        args: {
          project?: string;
          repository: string;
          pullRequestId: number;
          reviewerId: string;
          confirm: boolean;
        },
        ctx: any,
      ) => {
        requireConfirm(args.confirm, `remove reviewer ${args.reviewerId}`);
        const c = clientFrom(ctx);
        await c.delete(
          `${
            repoPath(args.repository)
          }/pullrequests/${args.pullRequestId}/reviewers/${
            enc(args.reviewerId)
          }`,
          { project: args.project },
        );
        return emit(
          ctx,
          "result",
          instanceName("remove-reviewer", args.pullRequestId, args.reviewerId),
          {
            operation: "removeReviewer",
            target: `${args.pullRequestId}/${args.reviewerId}`,
            status: "removed",
          },
        );
      },
    },

    /* ---------------- policies ---------------- */
    listPolicyConfigurations: {
      description:
        "List branch policy configurations in a project, optionally for one repository and branch.",
      arguments: z.object({
        project: ProjectArg,
        repositoryId: z.string().optional().describe("Repository ID (GUID)."),
        branch: z.string().optional().describe(
          "e.g. 'main'. Requires repositoryId.",
        ),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          repositoryId?: string;
          branch?: string;
          limit?: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("policy/configurations", {
          project: args.project,
          preview: 1,
          limit: args.limit,
          query: {
            repositoryId: args.repositoryId,
            refName: args.branch ? fullRef(args.branch) : undefined,
          },
        });
        return emit(
          ctx,
          "policies",
          instanceName("policies", args.repositoryId ?? "project"),
          list,
        );
      },
    },
    listPolicyEvaluations: {
      description:
        "List branch policy evaluations (build, reviewers, comments...) for a pull request.",
      arguments: z.object({
        project: ProjectArg,
        pullRequestId: prArg,
      }),
      execute: async (
        args: { project?: string; pullRequestId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data: pr } = await c.get<any>(
          `git/pullrequests/${args.pullRequestId}`,
          { project: args.project },
        );
        const projectId = pr?.repository?.project?.id;
        if (!projectId) throw new Error("Could not resolve the project ID.");
        const list = await c.list("policy/evaluations", {
          project: args.project,
          preview: 1,
          query: {
            artifactId:
              `vstfs:///CodeReview/CodeReviewId/${projectId}/${args.pullRequestId}`,
          },
        });
        return emit(
          ctx,
          "policies",
          instanceName("evaluations", args.pullRequestId),
          list,
        );
      },
    },
  },
};
