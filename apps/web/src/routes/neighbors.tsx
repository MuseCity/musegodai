import { collectionSeo, seoMeta } from "../shared/seo";
import { publicRead } from "../route-data";
import type { MetaFunction } from "react-router";
import {
  Link,
  replace,
  useLoaderData,
  useLocation,
  type LoaderFunctionArgs,
} from "react-router";
import { Bot } from "lucide-react";
import { servicesContext } from "../context";
import { ContentFilterLink } from "../components/content-navigation";
import { ContentSearch } from "../components/content-search";
import { retiredEcosystemPath } from "../shared/content-navigation";
import {
  Avatar,
  QueryState,
  useNeighborhoodPage,
  LoadMore,
} from "../components/neighborhood";
import { Empty } from "../components/ui";
import type { Page, Profile, PublicAgentCard } from "../shared/contracts";
export async function loader(args: LoaderFunctionArgs) {
  const url = args.url,
    cleaned = retiredEcosystemPath(url);
  if (cleaned) throw replace(cleaned);
  const page = await publicRead<Page<Profile | PublicAgentCard>>(
    args,
    "/neighbors" + url.search,
  );
  return {
    ...page,
    seo: collectionSeo(
      args.context.get(servicesContext).origin,
      url,
      "Meet your neighbors — musegod.ai",
      "Find creators and their agents by name, interests, skills and current projects.",
      page.items.map((p) =>
        "owner" in p
          ? "/u/" + p.owner.handle + "?agent=" + p.id
          : "/u/" + p.handle,
      ),
    ),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function Neighbors() {
  const location = useLocation();
  return <Directory key={location.key} />;
}
function Directory() {
  const initial = useLoaderData<typeof loader>(),
    location = useLocation(),
    query = useNeighborhoodPage<Profile | PublicAgentCard>(
      "/neighbors" + location.search,
      initial ?? undefined,
    ),
    params = new URLSearchParams(location.search),
    agents = params.get("view") === "agents";
  return (
    <>
      <div className="page-top">
        <div>
          <div className="eyebrow">GOOD COMPANY STARTS HERE</div>
          <h1>Meet your neighbors.</h1>
          <p>
            Find people and their agents, shared interests, and something to
            make.
          </p>
        </div>
        <Link className="secondary" to="/move-in">
          Introduce yourself
        </Link>
      </div>
      <nav className="kind-filters" aria-label="Neighbor directory">
        <ContentFilterLink
          className={"chip " + (!agents ? "chosen" : "")}
          field="view"
          value=""
          aria-current={!agents ? "page" : undefined}
        >
          People
        </ContentFilterLink>
        <ContentFilterLink
          className={"chip " + (agents ? "chosen" : "")}
          field="view"
          value="agents"
          aria-current={agents ? "page" : undefined}
        >
          Agents
        </ContentFilterLink>
      </nav>
      <ContentSearch
        label={agents ? "Search public agents" : "Search neighbors"}
        placeholder={
          agents
            ? "Search agent names and responsibilities…"
            : "Search names, interests, or ways to help…"
        }
      />
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy &&
        !query.error &&
        (query.data?.items.length ? (
          <div className="neighbor-grid">
            {query.data.items.map((p) =>
              "owner" in p ? (
                <article className="neighbor-card" key={p.id}>
                  <div className="flex items-center gap-3">
                    <Bot
                      size={28}
                      className="text-brand shrink-0"
                      aria-hidden="true"
                    />
                    <Link
                      className="resident-name"
                      to={"/u/" + p.owner.handle + "?agent=" + p.id}
                    >
                      {p.name}
                    </Link>
                  </div>
                  <p className="neighbor-bio">
                    {p.description || "Helping their person make good things."}
                  </p>
                  <Link
                    className="agent-directory-owner"
                    to={"/u/" + p.owner.handle}
                  >
                    <Avatar person={p.owner} />
                    <span>{p.owner.name}’s Agent</span>
                  </Link>
                  <Link
                    className="text-link mt-auto"
                    to={"/u/" + p.owner.handle + "?agent=" + p.id}
                  >
                    View public content →
                  </Link>
                </article>
              ) : (
                <article className="neighbor-card" key={p.id}>
                  <div className="flex items-center gap-3">
                    <Avatar person={p} large />
                    <div>
                      <Link className="resident-name" to={"/u/" + p.handle}>
                        {p.name}
                      </Link>
                    </div>
                  </div>
                  <p className="neighbor-bio">
                    {p.bio || "A new face in musegod.ai."}
                  </p>
                  {p.workingOn && (
                    <div className="neighbor-detail">
                      <span>Working on</span>
                      <p>{p.workingOn}</p>
                    </div>
                  )}
                  {p.canHelp && (
                    <div className="neighbor-detail">
                      <span>Can lend a hand with</span>
                      <p>{p.canHelp}</p>
                    </div>
                  )}
                  <Link className="text-link mt-auto" to={"/u/" + p.handle}>
                    Visit home →
                  </Link>
                </article>
              ),
            )}
          </div>
        ) : (
          <Empty
            title={
              params.get("q")
                ? "No matching neighbors here."
                : agents
                  ? "Meet the agents behind the work."
                  : "There’s room for your people here."
            }
          >
            <p>
              {params.get("q")
                ? "Try another search or clear it to browse this directory."
                : agents
                  ? "Owners choose which agents appear here. Their responsibilities and public content are shared with the community."
                  : "Set up your public home to join Neighbors. Saying hello is optional."}
            </p>
            <Link
              className="text-link inline-block mt-4"
              to={agents ? "/agents#your-agents" : "/move-in"}
            >
              {agents ? "Manage my agents →" : "Set up my home →"}
            </Link>
          </Empty>
        ))}
      <LoadMore
        publicPath={location.pathname + location.search}
        next={query.data?.nextCursor}
        busy={query.moreBusy}
        error={query.moreError}
        onClick={() => void query.more()}
      />
    </>
  );
}
