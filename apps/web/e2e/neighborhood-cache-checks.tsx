// Browser-only regression harness loaded through the isolated Vite fixture.
// Uses the real hooks with controlled HTTP responses, never production identity.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { AuthContext, type Session } from "../src/components/auth";
import {
  NeighborhoodProvider,
  useNeighborhoodPage,
} from "../src/components/neighborhood";
import type { Page } from "../src/shared/contracts";

type Item = { id: string };
const page = (...ids: string[]): Page<Item> => ({
  items: ids.map((id) => ({ id })),
  nextCursor: null,
});
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out: " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function deferred() {
  let resolve!: (value: Page<Item>) => void;
  const promise = new Promise<Page<Item>>((done) => (resolve = done));
  return { promise, resolve };
}

async function harness(
  run: (h: {
    set: (patch: Partial<Settings>) => void;
    calls: { path: string; token: string | null }[];
    respond: (fn: Responder) => void;
    query: (id?: string) => ReturnType<typeof useNeighborhoodPage<Item>>;
    navigate: (to: string | number) => void;
  }) => Promise<void>,
) {
  const element = document.createElement("section");
  document.body.appendChild(element);
  const root = createRoot(element);
  const originalFetch = window.fetch;
  const calls: { path: string; token: string | null }[] = [];
  let respond: Responder = () => page("network");
  const queries = new Map<
    string,
    ReturnType<typeof useNeighborhoodPage<Item>>
  >();
  let navigate: ReturnType<typeof useNavigate>;
  let settings: Settings = {
    ready: true,
    userId: null,
    first: true,
    second: false,
    privateOnly: false,
  };
  window.fetch = async (input, options) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    if (!url.pathname.startsWith("/api/v1/__cache-check"))
      return originalFetch(input, options);
    const call = {
      path: url.pathname + url.search,
      token: new Headers(options?.headers).get("authorization"),
    };
    calls.push(call);
    const result = await respond(call);
    return result instanceof Response ? result : Response.json(result);
  };
  function Probe({ id }: { id: string }) {
    const { pathname } = useLocation();
    navigate = useNavigate();
    const query = useNeighborhoodPage<Item>(
      "/__cache-check" + pathname,
      settings.initial,
      settings.privateOnly,
    );
    useEffect(() => {
      queries.set(id, query);
    });
    return (
      <output>{query.data?.items.map((item) => item.id).join(",")}</output>
    );
  }
  function render() {
    const userId = settings.userId;
    const session: Session = {
      ready: settings.ready,
      userId,
      configured: true,
      login: () => {},
      logout: async () => {},
      token: async () => userId,
      evmAddresses: [],
      signMessage: async () => {
        throw new Error("No wallet in this cache fixture.");
      },
      retryWallet: async () => {},
      link: () => {},
      linked: [],
    };
    flushSync(() => {
      root.render(
        <AuthContext value={session}>
          <MemoryRouter>
            <NeighborhoodProvider>
              {settings.first && <Probe key="first" id="first" />}
              {settings.second && <Probe key="second" id="second" />}
            </NeighborhoodProvider>
          </MemoryRouter>
        </AuthContext>,
      );
    });
  }
  try {
    await run({
      set: (patch) => {
        settings = { ...settings, ...patch };
        render();
      },
      calls,
      respond: (fn) => (respond = fn),
      query: (id = "first") => queries.get(id)!,
      navigate: (to) => {
        if (typeof to === "number") void navigate(to);
        else void navigate(to);
      },
    });
  } finally {
    flushSync(() => root.unmount());
    element.remove();
    window.fetch = originalFetch;
  }
}
type Settings = {
  ready: boolean;
  userId: string | null;
  initial?: Page<Item>;
  first: boolean;
  second: boolean;
  privateOnly: boolean;
};
type Responder = (call: {
  path: string;
  token: string | null;
}) => Page<Item> | Response | Promise<Page<Item> | Response>;

export async function runNeighborhoodCacheChecks() {
  const passed: string[] = [];
  async function check(name: string, run: Parameters<typeof harness>[0]) {
    await harness(run);
    passed.push(name);
  }
  await check(
    "anonymous hydration reuses SSR after auth becomes ready",
    async (h) => {
      h.set({ ready: false, initial: page("ssr") });
      assert(h.calls.length === 0, "Auth-pending hydration must not fetch");
      h.set({ ready: true, second: true });
      await until(
        () => !h.query()?.busy && !h.query("second")?.busy,
        "SSR consumers",
      );
      assert(h.query().data?.items[0].id === "ssr", "SSR content missing");
      assert(h.calls.length === 0, "SSR hydration duplicated its API request");
    },
  );
  await check(
    "concurrent consumers share a request after its first consumer unmounts",
    async (h) => {
      const request = deferred();
      h.respond(() => request.promise);
      h.set({ second: true });
      await until(() => h.calls.length === 1, "shared request");
      h.set({ first: false });
      request.resolve(page("shared"));
      await until(() => !h.query("second")?.busy, "remaining consumer");
      assert(
        h.query("second").data?.items[0].id === "shared",
        "Shared result lost",
      );
      assert(h.calls.length === 1, "Duplicate concurrent read");
    },
  );
  await check(
    "identity changes discard data and never replay consumed anonymous SSR",
    async (h) => {
      h.respond(({ token }) => page(token ?? "fresh-visitor"));
      h.set({ initial: page("old-ssr") });
      await until(() => !h.query()?.busy, "initial visitor");
      for (const userId of ["alice", "bob", null]) {
        h.set({ userId });
        assert(!h.query().data, "Previous identity or SSR data flashed");
        await until(() => !h.query().busy, "identity refresh");
        assert(
          h.query().data?.items[0].id ===
            (userId ? "Bearer " + userId : "fresh-visitor"),
          "Wrong identity projection",
        );
      }
      assert(h.calls.length === 3, "Each new identity must refresh once");
    },
  );
  await check(
    "invalidated pending responses cannot make the cache fresh again",
    async (h) => {
      const old = deferred();
      h.respond(() => (h.calls.length === 1 ? old.promise : page("fresh")));
      h.set({ second: true });
      await until(() => h.calls.length === 1, "old request");
      window.dispatchEvent(new Event("neighborhood-change"));
      old.resolve(page("stale"));
      await until(
        () => h.query()?.data?.items[0].id === "fresh",
        "fresh replacement",
      );
      await until(
        () => h.query("second")?.data?.items[0].id === "fresh",
        "second replacement",
      );
      assert(
        h.calls.length === 2,
        "Invalidation should trigger one replacement read",
      );
    },
  );
  await check(
    "failed reads remain retryable without restoring old SSR",
    async (h) => {
      h.set({ initial: page("ssr") });
      h.respond(() =>
        Response.json({ error: { message: "Try again" } }, { status: 503 }),
      );
      h.query().reload();
      await until(() => !!h.query()?.error, "read error");
      h.respond(() => page("recovered"));
      h.query().reload();
      await until(() => h.query()?.data?.items[0].id === "recovered", "retry");
      assert(h.calls.length === 2, "Retry used SSR or duplicated a request");
    },
  );
  await check(
    "private reads ignore public SSR and are isolated from anonymous consumers",
    async (h) => {
      h.set({ privateOnly: true, initial: page("public") });
      await until(() => !h.query()?.busy, "anonymous private gate");
      assert(
        h.query().data === null && h.calls.length === 0,
        "Private data gate failed",
      );
      h.respond(() => page("owner"));
      h.set({ userId: "alice" });
      await until(() => !h.query()?.busy, "private fetch");
      assert(
        h.query().data?.items[0].id === "owner",
        "Public SSR used as private data",
      );
    },
  );
  await check(
    "history and invalidation preserve loaded pagination without duplicates",
    async (h) => {
      const first = { ...page("one", "two"), nextCursor: "next" };
      h.respond(({ path }) =>
        path.includes("cursor=") ? page("two", "three") : first,
      );
      h.set({ initial: first });
      await h.query().more();
      await until(() => h.query()?.data?.items.length === 3, "load more");
      h.navigate("/another");
      await until(
        () => h.calls.length === 2 && !h.query()?.busy,
        "new history entry",
      );
      h.navigate(-1);
      await until(() => h.query()?.data?.items.length === 3, "history restore");
      assert(
        h.calls.length === 2,
        "History restore refetched a valid cached page",
      );
      window.dispatchEvent(new Event("neighborhood-change"));
      h.query().reload();
      await until(
        () => h.calls.length === 4 && !h.query()?.busy,
        "all pages refreshed",
      );
      assert(
        h
          .query()
          .data?.items.map((item) => item.id)
          .join(",") === "one,two,three",
        "Pagination restore lost or duplicated items",
      );
    },
  );
  return passed;
}
