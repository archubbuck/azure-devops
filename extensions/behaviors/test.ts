// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4";
import {
  clientFrom,
  emit,
  GlobalArgsSchema,
  instanceName,
  ListSchema,
  ProjectArg,
} from "./_lib/client.ts";

const spec = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 10,
});

const LooseSchema = z.record(z.string(), z.unknown());

const planArg = z.number().int().positive().describe("Test plan ID.");
const suiteArg = z.number().int().positive().describe("Test suite ID.");
const runArg = z.number().int().positive().describe("Test run ID.");
const buildArg = z.number().int().positive().describe("Build ID.");
const limitArg = z.number().int().positive().default(100);

export const behavior = {
  type: "@adamchubbuck/azure-devops/test",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    testplan: spec("A single test plan", LooseSchema),
    testplans: spec("List of test plans", ListSchema),
    testsuites: spec("List of test suites of a plan", ListSchema),
    testcases: spec("List of test cases of a suite", ListSchema),
    testpoints: spec("List of test points of a suite", ListSchema),
    testrun: spec("A single test run", LooseSchema),
    testruns: spec("List of test runs", ListSchema),
    testresult: spec("A single test result", LooseSchema),
    testresults: spec("List of test results", ListSchema),
    coverage: spec("Code coverage summary of a build", LooseSchema),
  },
  methods: {
    listTestPlans: {
      description: "List test plans of a project.",
      arguments: z.object({
        project: ProjectArg,
        owner: z.string().optional().describe("Filter by owner."),
        filterActivePlans: z.boolean().optional(),
        includePlanDetails: z.boolean().optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          owner?: string;
          filterActivePlans?: boolean;
          includePlanDetails?: boolean;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const list = await c.list("testplan/plans", {
          project,
          limit: args.limit,
          query: {
            owner: args.owner,
            filterActivePlans: args.filterActivePlans,
            includePlanDetails: args.includePlanDetails,
          },
        });
        return emit(ctx, "testplans", instanceName("testplans", project), list);
      },
    },
    getTestPlan: {
      description: "Get one test plan by ID.",
      arguments: z.object({ project: ProjectArg, planId: planArg }),
      execute: async (
        args: { project?: string; planId: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`testplan/Plans/${args.planId}`, {
          project: c.requireProject(args.project),
        });
        return emit(
          ctx,
          "testplan",
          instanceName("testplan", args.planId),
          data,
        );
      },
    },
    listTestSuites: {
      description: "List the test suites of a test plan.",
      arguments: z.object({
        project: ProjectArg,
        planId: planArg,
        expand: z.enum(["none", "children", "defaultTesters"]).optional(),
        asTreeView: z.boolean().optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          planId: number;
          expand?: string;
          asTreeView?: boolean;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`testplan/Plans/${args.planId}/suites`, {
          project: c.requireProject(args.project),
          limit: args.limit,
          query: { expand: args.expand, asTreeView: args.asTreeView },
        });
        return emit(
          ctx,
          "testsuites",
          instanceName("testsuites", args.planId),
          list,
        );
      },
    },
    listTestCases: {
      description: "List the test cases in a suite of a test plan.",
      arguments: z.object({
        project: ProjectArg,
        planId: planArg,
        suiteId: suiteArg,
        witFields: z.array(z.string()).optional().describe(
          "Work item fields to include, e.g. ['System.Title'].",
        ),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          planId: number;
          suiteId: number;
          witFields?: string[];
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `testplan/Plans/${args.planId}/Suites/${args.suiteId}/TestCase`,
          {
            project: c.requireProject(args.project),
            limit: args.limit,
            query: { witFields: args.witFields?.join(",") },
          },
        );
        return emit(
          ctx,
          "testcases",
          instanceName("testcases", args.planId, args.suiteId),
          list,
        );
      },
    },
    listTestPoints: {
      description: "List the test points (case x configuration) of a suite.",
      arguments: z.object({
        project: ProjectArg,
        planId: planArg,
        suiteId: suiteArg,
        testCaseId: z.string().optional().describe("Filter by test case ID."),
        includePointDetails: z.boolean().optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          planId: number;
          suiteId: number;
          testCaseId?: string;
          includePointDetails?: boolean;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(
          `testplan/Plans/${args.planId}/Suites/${args.suiteId}/TestPoint`,
          {
            project: c.requireProject(args.project),
            limit: args.limit,
            query: {
              testCaseId: args.testCaseId,
              includePointDetails: args.includePointDetails,
            },
          },
        );
        return emit(
          ctx,
          "testpoints",
          instanceName("testpoints", args.planId, args.suiteId),
          list,
        );
      },
    },
    listTestRuns: {
      description: "List test runs, optionally filtered by plan or build.",
      arguments: z.object({
        project: ProjectArg,
        planId: z.number().int().positive().optional(),
        buildUri: z.string().optional().describe(
          "e.g. 'vstfs:///Build/Build/123'.",
        ),
        automated: z.boolean().optional(),
        includeRunDetails: z.boolean().optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          planId?: number;
          buildUri?: string;
          automated?: boolean;
          includeRunDetails?: boolean;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const project = c.requireProject(args.project);
        const list = await c.list("test/runs", {
          project,
          limit: args.limit,
          query: {
            planId: args.planId,
            buildUri: args.buildUri,
            automated: args.automated,
            includeRunDetails: args.includeRunDetails,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(ctx, "testruns", instanceName("testruns", project), list);
      },
    },
    getTestRun: {
      description: "Get one test run with its statistics.",
      arguments: z.object({
        project: ProjectArg,
        runId: runArg,
        includeDetails: z.boolean().optional(),
      }),
      execute: async (
        args: { project?: string; runId: number; includeDetails?: boolean },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(`test/runs/${args.runId}`, {
          project: c.requireProject(args.project),
          query: { includeDetails: args.includeDetails },
        });
        return emit(ctx, "testrun", instanceName("testrun", args.runId), data);
      },
    },
    createTestRun: {
      description:
        "Create a test run record (planned or automated) to which results can be posted. Does not execute any tests.",
      arguments: z.object({
        project: ProjectArg,
        name: z.string().min(1),
        planId: z.number().int().positive().optional(),
        pointIds: z.array(z.number().int()).optional().describe(
          "Test point IDs to include (planned runs).",
        ),
        automated: z.boolean().default(true),
        buildId: z.number().int().positive().optional(),
        state: z.enum(["NotStarted", "InProgress"]).optional(),
        comment: z.string().optional(),
      }),
      execute: async (
        args: {
          project?: string;
          name: string;
          planId?: number;
          pointIds?: number[];
          automated: boolean;
          buildId?: number;
          state?: string;
          comment?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.post<{ id?: number }>("test/runs", {
          name: args.name,
          automated: args.automated,
          plan: args.planId ? { id: String(args.planId) } : undefined,
          pointIds: args.pointIds,
          build: args.buildId ? { id: String(args.buildId) } : undefined,
          state: args.state,
          comment: args.comment,
        }, { project: c.requireProject(args.project) });
        return emit(
          ctx,
          "testrun",
          instanceName("testrun", data?.id ?? args.name),
          data,
        );
      },
    },
    listTestResults: {
      description: "List the results of a test run.",
      arguments: z.object({
        project: ProjectArg,
        runId: runArg,
        outcomes: z.array(z.string()).optional().describe(
          "e.g. ['Failed','Aborted'].",
        ),
        detailsToInclude: z.enum([
          "None",
          "Iterations",
          "WorkItems",
          "SubResults",
          "Point",
        ]).optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          runId: number;
          outcomes?: string[];
          detailsToInclude?: string;
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list(`test/runs/${args.runId}/results`, {
          project: c.requireProject(args.project),
          limit: args.limit,
          query: {
            outcomes: args.outcomes?.join(","),
            detailsToInclude: args.detailsToInclude,
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "testresults",
          instanceName("testresults", args.runId),
          list,
        );
      },
    },
    getTestResult: {
      description: "Get one test result of a run.",
      arguments: z.object({
        project: ProjectArg,
        runId: runArg,
        resultId: z.number().int().positive(),
        detailsToInclude: z.enum([
          "None",
          "Iterations",
          "WorkItems",
          "SubResults",
          "Point",
        ]).optional(),
      }),
      execute: async (
        args: {
          project?: string;
          runId: number;
          resultId: number;
          detailsToInclude?: string;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get(
          `test/runs/${args.runId}/results/${args.resultId}`,
          {
            project: c.requireProject(args.project),
            query: { detailsToInclude: args.detailsToInclude },
          },
        );
        return emit(
          ctx,
          "testresult",
          instanceName("testresult", args.runId, args.resultId),
          data,
        );
      },
    },
    updateTestResults: {
      description:
        "Update (e.g. set outcome/state of) existing test results in a run. Each entry must include the result 'id'.",
      arguments: z.object({
        project: ProjectArg,
        runId: runArg,
        results: z.array(
          z.object({ id: z.number().int() }).passthrough(),
        ).min(1).describe(
          "e.g. [{id: 100000, outcome: 'Passed', state: 'Completed'}].",
        ),
      }),
      execute: async (
        args: {
          project?: string;
          runId: number;
          results: Record<string, unknown>[];
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.patch<{ value?: unknown[] } | unknown[]>(
          `test/runs/${args.runId}/results`,
          args.results,
          { project: c.requireProject(args.project) },
        );
        const items =
          (Array.isArray(data) ? data : data?.value ?? []) as Record<
            string,
            unknown
          >[];
        return emit(
          ctx,
          "testresults",
          instanceName("testresults", args.runId, "updated"),
          { count: items.length, items },
        );
      },
    },
    getCodeCoverageSummary: {
      description: "Get the code coverage summary of a build (preview API).",
      arguments: z.object({
        project: ProjectArg,
        buildId: buildArg,
        deltaBuildId: z.number().int().positive().optional().describe(
          "Compare against this build.",
        ),
      }),
      execute: async (
        args: { project?: string; buildId: number; deltaBuildId?: number },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const { data } = await c.get("test/codecoverage", {
          project: c.requireProject(args.project),
          preview: 1,
          query: { buildId: args.buildId, deltaBuildId: args.deltaBuildId },
        });
        return emit(
          ctx,
          "coverage",
          instanceName("coverage", args.buildId),
          data,
        );
      },
    },
    listTestResultsByBuild: {
      description: "List test results of a build (preview API).",
      arguments: z.object({
        project: ProjectArg,
        buildId: buildArg,
        publishContext: z.string().optional().describe("e.g. 'CI' or 'PR'."),
        outcomes: z.array(z.string()).optional(),
        limit: limitArg,
      }),
      execute: async (
        args: {
          project?: string;
          buildId: number;
          publishContext?: string;
          outcomes?: string[];
          limit: number;
        },
        ctx: any,
      ) => {
        const c = clientFrom(ctx);
        const list = await c.list("test/resultsbybuild", {
          project: c.requireProject(args.project),
          preview: 1,
          limit: args.limit,
          query: {
            buildId: args.buildId,
            publishContext: args.publishContext,
            outcomes: args.outcomes?.join(","),
            $top: Math.min(args.limit, 1000),
          },
        });
        return emit(
          ctx,
          "testresults",
          instanceName("testresults", "build", args.buildId),
          list,
        );
      },
    },
  },
};
