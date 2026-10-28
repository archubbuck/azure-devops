# @adamchubbuck/azure-devops

Full Azure DevOps API coverage: Git, pipelines, work items and more. Built on
the Azure DevOps REST API v7.2. Works with Azure DevOps Services
(`dev.azure.com`), legacy `*.visualstudio.com` URLs and Server/on-prem.

**Coverage:** Core, Git, Build, Pipelines, Work Item Tracking, Release, Test,
Artifacts, Graph, Security, Wiki, Dashboards and Service Hooks.

## Types

| Type | Covers |
| ---- | ------ |
| `@adamchubbuck/azure-devops/core` | Projects, teams, team members |
| `@adamchubbuck/azure-devops/git` | Repos, branches, refs, commits, pushes, pull requests, threads, reviewers, votes, branch policies |
| `@adamchubbuck/azure-devops/build` | Build definitions, builds, logs, artifacts |
| `@adamchubbuck/azure-devops/pipelines` | Pipelines, runs, run logs |
| `@adamchubbuck/azure-devops/workitems` | Work items, WIQL, queries, types, fields, comments, revisions, links, areas, iterations, tags |
| `@adamchubbuck/azure-devops/test` | Test plans, suites, cases, points, runs, results, code coverage |
| `@adamchubbuck/azure-devops/release` | Classic release definitions, releases, deployments, approvals, logs |
| `@adamchubbuck/azure-devops/artifacts` | Feeds, packages, versions, views, permissions, retention, build artifacts |
| `@adamchubbuck/azure-devops/graph` | Users, groups, memberships, descriptors, identity search |
| `@adamchubbuck/azure-devops/security` | Security namespaces, ACLs and ACEs, permission checks |
| `@adamchubbuck/azure-devops/wiki` | Wikis, pages (ETag-aware updates), page stats |
| `@adamchubbuck/azure-devops/dashboards` | Team dashboards and widgets |
| `@adamchubbuck/azure-devops/servicehooks` | Publishers, consumers, subscriptions, notifications |

Release, Artifacts and Graph use separate service hosts (`vsrm`, `feeds`,
`vssps`); these are derived automatically for `dev.azure.com` and
`visualstudio.com` URLs. On Server/on-prem the collection URL is used as-is.

## Global arguments (every type)

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `organization` | - | Organization name, e.g. `my-org` (`https://dev.azure.com/my-org`) |
| `baseUrl` | - | Full collection URL. Overrides `organization`. Legacy: `https://my-org.visualstudio.com`. Server: `https://ado.example.com/tfs/DefaultCollection` |
| `project` | - | Default project, e.g. `my-project` (override per method) |
| `apiVersion` | `7.2` | Use `7.1`, `6.0`, ... for older Server. If the server reports a version is preview-only, the client retries once with `-preview` automatically |
| `token` | required | PAT or Entra ID bearer token, via a vault reference |
| `authType` | `pat` | `pat` (HTTP Basic) or `bearer` (Entra ID) |
| `maxRetries` / `retryBaseMs` | `4` / `500` | Exponential backoff for HTTP 429, 5xx and network errors (honours `Retry-After`) |

## Authentication

Never put a token in a definition. Store it in a vault and reference it:

```
swamp vault create local_encryption ado
swamp vault put ado TOKEN          # prompts with hidden input
```

```yaml
# models/.../my-git.yaml
globalArguments:
  organization: my-org
  project: my-project
  token: ${{ vault.get("ado", "TOKEN") }}
```

Suggested PAT scopes: Code (Read / Read & Write), Project and Team (Read), Build
(Read / Read & Execute). Tokens are never logged, and error messages never
include credentials or query strings.

## Safety

Destructive methods are never run by default. They take `confirm: boolean`
(default `false`) and refuse to touch the API unless it is `true`:

`core`: `deleteProject`, `deleteTeam`. `git`: `deleteRepository`,
`deleteBranch`, `forceUpdateBranch`, `abandonPullRequest`,
`completePullRequest`, `removeReviewer`. `build`: `deleteDefinition`,
`queueBuild`, `cancelBuild`. `pipelines`: `runPipeline`. `workitems`:
`deleteWorkItem`, `removeLink`. `release`: `createRelease`,
`updateReleaseEnvironment`, `startDeployment`, `updateApproval`,
`abandonRelease`, `deleteDefinition`. `artifacts`: `createFeed`, `deleteFeed`,
`deletePackageVersion`, `promotePackageVersion`. `graph`: `createGroup`,
`deleteGroup`, `addMembership`, `removeMembership`. `security`:
`setAccessControlEntries`, `removeAccessControlEntries`. `wiki`: `createWiki`,
`deleteWiki`, `createOrUpdatePage`, `deletePage`. `dashboards`: every
create/update/delete method. `servicehooks`: `createSubscription`,
`replaceSubscription`, `deleteSubscription`, `testSubscription`.

`createPush` never force-pushes; it fails if the branch moved.

## Pagination and output

List methods follow `x-ms-continuationtoken` (or `$skip`/`$top` for pull
requests) and accept `limit`. Each method writes a typed resource (lists have the
shape `{ count, items, nextPageToken? }`). Reference results with CEL:

```
data.latest("my-git", "repos-my-project").attributes.items
```

## Examples

List repositories and branches:

```
swamp behavior run my-git listRepositories
swamp behavior run my-git listBranches --input repository=my-repo --input filter=feature/
```

Create a PR from `feature/x` into `main`, then review it:

```
swamp behavior run my-git createPullRequest \
  --input repository=my-repo --input sourceBranch=feature/x \
  --input targetBranch=main --input title="Add feature x" --input isDraft=true
swamp behavior run my-git createThread \
  --input repository=my-repo --input pullRequestId=42 \
  --input content="Looks good" --input filePath=/src/app.ts --input line=10
swamp behavior run my-git setVote \
  --input repository=my-repo --input pullRequestId=42 --input vote=approved
```

Create a branch:

```
swamp behavior run my-git createBranch --input repository=my-repo \
  --input name=feature/x --input sourceBranch=main
```

Complete a PR (destructive, explicit):

```
swamp behavior run my-git completePullRequest --input repository=my-repo \
  --input pullRequestId=42 --input mergeStrategy=squash --input confirm=true
```

Builds and pipelines:

```
swamp behavior run my-build listBuilds --input branch=main --input resultFilter=failed
swamp behavior run my-build getLog --input buildId=100 --input logId=5
swamp behavior run my-pipelines runPipeline --input pipelineId=7 \
  --input branch=main --input confirm=true
```

Projects and teams:

```
swamp behavior run my-core listProjects
swamp behavior run my-core listTeams --input project=my-project
```

## Method reference

Run `swamp behavior type describe <type> --json` for every method, argument and
description.
