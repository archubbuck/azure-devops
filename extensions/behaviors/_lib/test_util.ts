// deno-lint-ignore-file no-explicit-any
// Test helpers: a fake method context and a fetch mock. No real credentials.
export function eq<T>(a: T, b: T) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

export function makeCtx(globalArgs: Record<string, unknown> = {}): any {
  const written: { spec: string; name: string; data: any }[] = [];
  return {
    written,
    globalArgs: {
      organization: "my-org",
      project: "my-project",
      token: "test-token",
      apiVersion: "7.2",
      authType: "pat",
      maxRetries: 0,
      retryBaseMs: 0,
      ...globalArgs,
    },
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
}

export async function withFetch(
  impl: (url: string, init?: RequestInit) => Response,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((u: string, i?: RequestInit) =>
    Promise.resolve(impl(String(u), i))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

export const json = (b: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(b), init);

export async function expectRejects(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("expected the call to be rejected");
}
