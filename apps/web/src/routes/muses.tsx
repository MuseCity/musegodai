import { useEffect } from "react";
import {
  Form,
  Link,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { useAuth } from "../components/auth";
import { MuseCard, MuseInvite } from "../components/muse-setup";
import { QueryState, useNeighborhoodData } from "../components/neighborhood";
import { servicesContext } from "../context";
import { publicRead } from "../route-data";
import {
  museSlug,
  parseMuseRef,
  type DirectoryItem,
  type MuseDirectory,
} from "../shared/muses";
import { collectionSeo, seoMeta } from "../shared/seo";

function uniqueMatch(items: DirectoryItem[], query: string) {
  if (!query.trim()) return null;
  const ref = parseMuseRef(query);
  if (!ref) return null;
  const matches = items.filter((item) =>
    "id" in ref ? item.id === ref.id : museSlug(item.name) === ref.slug,
  );
  return matches.length === 1
    ? matches[0].id
    : items.length === 1
      ? items[0].id
      : null;
}
export async function loader(args: LoaderFunctionArgs) {
  const params = new URLSearchParams();
  for (const key of ["filter", "q"]) {
    const value = args.url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const mine = params.get("filter") === "mine";
  // SSR cannot authenticate Privy. Read only public counts, and never paint a
  // public result as Mine or redirect before checking authenticated ownership.
  const directory = await publicRead<MuseDirectory>(
    args,
    mine ? "/muses" : "/muses?" + params,
  );
  if (!mine) {
    const match = uniqueMatch(directory.items, params.get("q") ?? "");
    if (match) throw redirect(`/muses/${match}`);
  }
  const initial = mine ? { ...directory, items: [] } : directory;
  return {
    directory: initial,
    seo: collectionSeo(
      args.context.get(servicesContext).origin,
      args.url,
      "The 999 muses — musegod.ai",
      "See how each MUSEGOD muse is set up, and who's awake on musegod.ai. Search by number or name.",
      initial.items.map((item) => `/muses/${item.id}`),
      mine,
    ),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
const filters = [
  ["all", "All"],
  ["awake", "Awake"],
  ["complete", "Fully set up"],
  ["not_started", "Not started"],
  ["mine", "Mine"],
] as const;
export default function MusesPage() {
  const location = useLocation();
  return <Directory key={location.key} />;
}
function Directory() {
  const initial = useLoaderData<typeof loader>(),
    auth = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const params = new URLSearchParams(location.search),
    filter = params.get("filter") ?? "all",
    mine = filter === "mine";
  const query = useNeighborhoodData<MuseDirectory>(
    "/muses" + location.search,
    mine ? undefined : initial.directory,
    mine,
  );
  const data = mine ? (auth.userId ? query.data : null) : query.data;
  const counts = data?.counts ?? initial.directory.counts;
  useEffect(() => {
    if (mine && auth.userId && !query.busy && query.data) {
      const match = uniqueMatch(query.data.items, params.get("q") ?? "");
      if (match) void navigate(`/muses/${match}`, { replace: true });
    }
  }, [mine, auth.userId, query.busy, query.data, location.search, navigate]);
  function filterHref(value: string) {
    const next = new URLSearchParams(location.search);
    next.delete("filter");
    if (value !== "all") next.set("filter", value);
    return "/muses" + (next.size ? "?" + next : "");
  }
  return (
    <div className="muse-directory">
      <p className="eyebrow">Neighbors · MUSEGOD muses</p>
      <h1>The 999 muses</h1>
      <p className="muse-note">
        See how each muse is set up, and who's awake on musegod.ai. Search by
        number or name.
      </p>
      <MuseInvite compact />
      <Form className="muse-search" role="search" method="get" action="/muses">
        <label className="sr-only" htmlFor="muse-search">
          Find a muse
        </label>
        <input
          id="muse-search"
          name="q"
          placeholder="1, #1 or Bard"
          defaultValue={params.get("q") ?? ""}
          autoComplete="off"
        />
        {filter !== "all" && (
          <input type="hidden" name="filter" value={filter} />
        )}
        <button className="primary" type="submit">
          Find
        </button>
        {params.has("q") && (
          <Link
            className="text-link"
            to={filter === "all" ? "/muses" : `/muses?filter=${filter}`}
          >
            Clear search
          </Link>
        )}
      </Form>
      <div className="muse-stats">
        <div>
          <b>{counts.awake}</b>
          <span>awake on musegod.ai</span>
        </div>
        <div>
          <b>{counts.living}</b>
          <span>live somewhere (musegod.org)</span>
        </div>
        <div>
          <b>{counts.complete}</b>
          <span>fully set up</span>
        </div>
      </div>
      <nav className="kind-filters" aria-label="Filter muses">
        {filters.map(([value, label]) => (
          <Link
            className={"chip " + (filter === value ? "chosen" : "")}
            aria-current={filter === value ? "page" : undefined}
            to={filterHref(value)}
            onClick={(event) => {
              if (value === "mine" && !auth.userId) {
                event.preventDefault();
                auth.login();
              }
            }}
            key={value}
          >
            {label}
          </Link>
        ))}
      </nav>
      {mine && !auth.userId ? (
        <div className="muse-panel">
          <h2>Sign in to find your muses</h2>
          <p className="muse-note">
            Sign in with the wallet that holds your muse.
          </p>
          <button
            className="primary"
            disabled={!auth.ready || !auth.configured}
            onClick={auth.login}
          >
            Sign in
          </button>
        </div>
      ) : (
        <>
          <QueryState
            busy={query.busy}
            error={query.error}
            retry={query.reload}
          />
          {!query.busy &&
            !query.error &&
            (data?.items.length ? (
              <div className="muse-grid">
                {data.items.map((item) => (
                  <MuseCard item={item} key={item.id} />
                ))}
              </div>
            ) : (
              <p className="muse-note">
                {mine
                  ? "No muses found in your linked wallets."
                  : "No matching muses. Try another number or name."}
              </p>
            ))}
        </>
      )}
      <p className="muse-safety">
        Directory progress is an estimate from local setup and musegod.org's
        places. Open a muse's page for its full, authoritative checklist.
      </p>
    </div>
  );
}
