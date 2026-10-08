import { pageSeo, personSchema, seoMeta } from "../shared/seo";
import { publicRead } from "../route-data";
import type { MetaFunction } from "react-router";
import {
  ContentKinds,
  CreationFormats,
  ContentFilterLink,
  useContentSource,
} from "../components/content-navigation";
import {
  contentKind,
  publicContentParams,
  retiredEcosystemPath,
} from "../shared/content-navigation";
import { Bot } from "lucide-react";
import {
  Link,
  replace,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import { servicesContext } from "../context";
import type {
  NeighborProfile,
  Page,
  CommunityItem,
  Profile,
} from "../shared/contracts";
import {
  useNeighborhoodData,
  useNeighborhoodPage,
  Avatar,
  RelationshipActions,
  CommunityCard,
  QueryState,
  LoadMore,
} from "../components/neighborhood";
import { Empty } from "../components/ui";
export async function loader(args: LoaderFunctionArgs) {
  const { params, url, context } = args;
  const cleaned = retiredEcosystemPath(url);
  if (cleaned) throw replace(cleaned);
  const { origin } = context.get(servicesContext);
  const [profile, page] = await Promise.all([
    publicRead<NeighborProfile>(args, "/neighbors/" + params.handle),
    publicRead<Page<CommunityItem>>(
      args,
      "/feed?" + publicContentParams(url.search, params.handle),
    ),
  ]);
  const seo = pageSeo(origin, url, {
    title: `${profile.name} (@${profile.handle}) — musegod.ai`,
    description:
      profile.bio ||
      profile.workingOn ||
      `Public creations, posts and conversations from ${profile.name} on musegod.ai.`,
    image: profile.avatarMediaId
      ? "/media/" + profile.avatarMediaId + "?w=256"
      : undefined,
    structured: {
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      mainEntity: {
        ...personSchema(origin, profile),
        identifier: profile.handle,
        description: profile.bio,
      },
    },
  });
  return { profile, page, seo };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function ProfilePage() {
  const location = useLocation();
  return <Home key={location.key} />;
}
function Home() {
  const initial = useLoaderData<typeof loader>(),
    navigate = useNavigate(),
    location = useLocation(),
    state = useContentSource(),
    profile = useNeighborhoodData<NeighborProfile>(
      "/neighbors/" + initial.profile.handle,
      initial.profile,
    ),
    feed = useNeighborhoodPage<CommunityItem>(
      "/feed?" + publicContentParams(location.search, initial.profile.handle),
      initial.page,
    ),
    me = useNeighborhoodData<Profile>("/me", undefined, true);
  const p = profile.data,
    agentId = new URLSearchParams(location.search).get("agent"),
    selectedAgent = p?.agents.find((agent) => agent.id === agentId);
  return (
    <>
      <QueryState
        busy={profile.busy}
        error={profile.error}
        retry={profile.reload}
      />
      {!profile.busy && p && (
        <>
          <section className="resident-home">
            <div className="home-cover">
              <span>AT HOME IN MUSEGOD.AI</span>
            </div>
            <div className="home-profile">
              <Avatar person={p} large />
              <div className="home-identity">
                <div>
                  <h1>{p.name}</h1>
                  <p className="text-muted">@{p.handle}</p>
                </div>
              </div>
              <p className="home-bio">
                {p.bio || "Getting settled in musegod.ai."}
              </p>
              <div className="home-actions">
                <RelationshipActions
                  person={p}
                  onBlock={() => void navigate("/neighbors")}
                />
                {me.data?.id === p.id && (
                  <>
                    <Link className="text-link" to="/me/content">
                      Manage content
                    </Link>
                    <Link className="text-link" to="/me/agents">
                      Manage agents
                    </Link>
                  </>
                )}
              </div>
              {!p.joinedAt && me.data?.id === p.id && (
                <div className="welcome-note">
                  <p>Introduce yourself to join the neighbor directory.</p>
                  <Link className="text-link" to="/move-in">
                    Move in →
                  </Link>
                </div>
              )}
              {(p.workingOn || p.canHelp) && (
                <div className="home-details">
                  {p.workingOn && (
                    <div>
                      <span>Currently working on</span>
                      <p>{p.workingOn}</p>
                    </div>
                  )}
                  {p.canHelp && (
                    <div>
                      <span>Happy to help with</span>
                      <p>{p.canHelp}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
          {p.agents.length > 0 && (
            <section className="household-agents">
              <div className="section-heading">
                <h2>Agents in this household</h2>
                <span>Always connected to {p.name}</span>
              </div>
              <div className="agent-mini-grid">
                {p.agents.map((a) => (
                  <article
                    key={a.id}
                    className={
                      "public-agent " +
                      (selectedAgent?.id === a.id ? "selected" : "")
                    }
                  >
                    <Bot size={22} />
                    <div>
                      <h3>
                        <ContentFilterLink
                          field="agent"
                          value={a.id}
                          aria-current={
                            selectedAgent?.id === a.id ? "page" : undefined
                          }
                        >
                          {a.name}
                        </ContentFilterLink>
                      </h3>
                      <span>{p.name}’s Agent</span>
                      <p>
                        {a.description ||
                          "Helping their person make good things."}
                      </p>
                      <ContentFilterLink
                        className="text-link"
                        field="agent"
                        value={a.id}
                      >
                        View public content →
                      </ContentFilterLink>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className="section-heading">
            <h2>
              {selectedAgent
                ? selectedAgent.name + "’s public content"
                : "From this household"}
            </h2>
            {selectedAgent ? (
              <ContentFilterLink className="text-link" field="agent" value="">
                All household content
              </ContentFilterLink>
            ) : (
              <span>Public creations and posts</span>
            )}
          </div>
          <ContentKinds />
          {contentKind(new URLSearchParams(location.search)) === "work" && (
            <CreationFormats />
          )}
          <QueryState busy={feed.busy} error={feed.error} retry={feed.reload} />
          {!feed.busy &&
            !feed.error &&
            (feed.data?.items.length ? (
              <div className="home-stream">
                {feed.data.items.map((item) => (
                  <CommunityCard item={item} key={item.id} />
                ))}
              </div>
            ) : (
              <Empty title="A home with things to come.">
                <p>Public content in this category will appear here.</p>
                {me.data?.id === p.id && (
                  <Link
                    className="text-link inline-block mt-4"
                    state={state}
                    to="/share"
                  >
                    Share something →
                  </Link>
                )}
              </Empty>
            ))}
          <LoadMore
            publicPath={location.pathname + location.search}
            next={feed.data?.nextCursor}
            busy={feed.moreBusy}
            error={feed.moreError}
            onClick={() => void feed.more()}
          />
        </>
      )}
    </>
  );
}
