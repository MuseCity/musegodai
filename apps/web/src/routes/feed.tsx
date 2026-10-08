import { collectionSeo, seoMeta } from "../shared/seo";
import { publicRead } from "../route-data";
import type { MetaFunction } from "react-router";
import {
  ContentKinds,
  useContentSource,
  useFilterLocation,
  CreationFormats,
} from "../components/content-navigation";
import { FeedTabs } from "../components/feed-tabs";
import { SiteBuilderLinks } from "../components/site-builder-links";
import { ContentSearch } from "../components/content-search";
import { useTopics } from "../components/catalog";
import {
  contentKind,
  publicContentParams,
  retiredEcosystemPath,
  shareHref,
} from "../shared/content-navigation";
import {
  Link,
  replace,
  useLoaderData,
  useLocation,
  type LoaderFunctionArgs,
} from "react-router";
import { ArrowUpRight, MessageCircle, UsersRound } from "lucide-react";
import { servicesContext } from "../context";
import { useAuth } from "../components/auth";
import {
  useNeighborhoodPage,
  useNeighborhoodData,
  QueryState,
  CommunityCard,
  Avatar,
  LoadMore,
} from "../components/neighborhood";
import { Empty } from "../components/ui";
import type { CommunityItem, Page, Profile } from "../shared/contracts";
import type { OnboardingState } from "../shared/onboarding";
export async function loader(args: LoaderFunctionArgs) {
  const { url, context } = args;
  const cleaned = retiredEcosystemPath(url);
  if (cleaned) throw replace(cleaned);
  const { origin } = context.get(servicesContext);
  const [page, neighbors, discovery] = await Promise.all([
    url.searchParams.get("view") === "following"
      ? null
      : publicRead<Page<CommunityItem>>(
          args,
          "/feed?" + publicContentParams(url.search),
        ),
    publicRead<Page<Profile>>(args, "/neighbors").catch(() => null),
    publicRead<{ items: CommunityItem[] }>(args, "/discovery").catch(
      () => null,
    ),
  ]);
  const tagId = url.searchParams.get("tag");
  const tags = tagId
    ? await publicRead<{ tags: { id: string; name: string }[] }>(args, "/tags")
    : null;
  const tag = tags?.tags.find((t) => t.id === tagId);
  const sites = url.searchParams.get("view") === "sites";
  const title = sites
    ? "AI-built websites — musegod.ai"
    : tag
      ? tag.name + " — musegod.ai"
      : "musegod.ai — A city we build together.";
  const description = sites
    ? "Discover AI-assisted websites shared by creators and their agents on musegod.ai."
    : tag
      ? `Explore creations and posts about ${tag.name} from the musegod.ai community.`
      : "Discover websites and creative work, share posts, and build together with people and their Muse AI.";
  return {
    page,
    neighbors,
    discovery,
    seo: collectionSeo(
      origin,
      url,
      title,
      description,
      (page?.items ?? []).map(
        (item) => (item.kind === "work" ? "/works/" : "/posts/") + item.id,
      ),
      !!tag && !page?.items.length,
    ),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function Feed() {
  const location = useLocation();
  return <Square key={location.key} />;
}
function Square() {
  const initial = useLoaderData<typeof loader>(),
    location = useLocation(),
    auth = useAuth();
  const query = useNeighborhoodPage<CommunityItem>(
    "/feed?" + publicContentParams(location.search),
    initial.page ?? undefined,
  );
  const neighbors = useNeighborhoodPage<Profile>(
    "/neighbors",
    initial.neighbors ?? undefined,
  );
  const discovery = useNeighborhoodData<{ items: CommunityItem[] }>(
    "/discovery",
    initial.discovery ?? undefined,
  );
  const onboarding = useNeighborhoodData<OnboardingState>(
    "/me/onboarding",
    undefined,
    true,
  );
  const setup = onboarding.data;
  const filterLocation = useFilterLocation();
  const params = new URLSearchParams(filterLocation.search),
    view = params.get("view") ?? "latest",
    kind = contentKind(params);
  const sites = view === "sites";
  const tag = useTopics().find((topic) => topic.id === params.get("tag"));
  const state = useContentSource();
  return (
    <>
      <h1 className="sr-only">Community Square</h1>
      <div className="neighborhood-layout">
        <section className="square-main" aria-label="Community square">
          <FeedTabs />
          {auth.userId &&
            setup &&
            (!setup.profile.joinedAt ||
              (setup.startedAt && !setup.finishedAt)) && (
              <div className="welcome-note mt-3">
                <div>
                  <strong>
                    {setup.profile.joinedAt
                      ? "You’re in. Make yourself at home."
                      : "Your home is waiting, " + setup.profile.name + "."}
                  </strong>
                  <p>Set up your home, then explore at your own pace.</p>
                </div>
                <Link to="/move-in" className="text-link">
                  {setup.startedAt ? "Continue setting up" : "Move in"}{" "}
                  <ArrowUpRight size={15} />
                </Link>
              </div>
            )}
          {sites ? (
            <div className="shared-tag-heading mb-3">
              <div>
                <h2>Built with AI</h2>
                <p>Websites from the community.</p>
              </div>
              <Link
                className="secondary compact"
                state={state}
                to={shareHref("sites", tag?.id)}
              >
                Share a site <ArrowUpRight size={15} />
              </Link>
            </div>
          ) : tag ? (
            <div className="shared-tag-heading">
              <div>
                <h2>{tag.name}</h2>
                <p>Everyone can share here.</p>
              </div>
              <Link
                className="secondary compact"
                state={state}
                to={shareHref(kind, tag.id)}
              >
                Share here <ArrowUpRight size={15} />
              </Link>
            </div>
          ) : null}
          {!sites && <ContentKinds />}
          {sites && <SiteBuilderLinks />}
          {!sites && kind === "work" && <CreationFormats />}
          <ContentSearch
            placeholder={sites ? "Search AI-built websites…" : undefined}
          />
          {view === "following" && auth.ready && !auth.userId ? (
            <Empty title="Keep your neighbors close.">
              <p>
                Sign in and follow people to see what they and their agents are
                sharing.
              </p>
              <button className="primary mt-5" onClick={auth.login}>
                Join musegod.ai
              </button>
            </Empty>
          ) : (
            <>
              <QueryState
                busy={query.busy}
                error={query.error}
                retry={query.reload}
              />
              {!query.busy &&
                !query.error &&
                (query.data?.items.length ? (
                  <div className="community-stream">
                    {query.data.items.map((item) => (
                      <CommunityCard key={item.id} item={item} />
                    ))}
                  </div>
                ) : (
                  <Empty
                    title={
                      params.get("q")
                        ? "No matching content here."
                        : view === "following"
                          ? "musegod.ai starts with a hello."
                          : sites
                            ? "Share your first AI-built website."
                            : tag
                              ? `Start a conversation in ${tag.name}.`
                              : "The square is yours to start."
                    }
                  >
                    <p>
                      {params.get("q")
                        ? "Try another search or clear it to see all content in these filters."
                        : view === "following"
                          ? "Find a few neighbors to follow. Their creations and posts will appear here."
                          : sites
                            ? "Add a link, a cover, and a few words about what you made."
                            : "Share an idea or show something you made."}
                    </p>
                    <Link
                      className="text-link inline-block mt-4"
                      state={state}
                      to={
                        view === "following"
                          ? "/neighbors"
                          : shareHref(sites ? "sites" : kind, tag?.id)
                      }
                    >
                      {view === "following"
                        ? "Meet your neighbors →"
                        : sites
                          ? "Share a site →"
                          : kind === "work"
                            ? "Share a creation →"
                            : "Share a post →"}
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
          )}
        </section>
        <aside className="neighborhood-sidebar">
          <section className="sidebar-section">
            <div className="sidebar-heading">
              <UsersRound size={17} />
              <h2>New neighbors</h2>
            </div>
            <QueryState
              busy={neighbors.busy}
              error={neighbors.error}
              retry={neighbors.reload}
            />
            {neighbors.data?.items.slice(0, 4).map((p) => (
              <Link className="mini-neighbor" to={"/u/" + p.handle} key={p.id}>
                <Avatar person={p} />
                <div>
                  <strong>{p.name}</strong>
                  <span className="mini-neighbor-note">
                    {p.workingOn || p.bio || "A new face in musegod.ai"}
                  </span>
                </div>
                <span className="mini-neighbor-action">View profile</span>
              </Link>
            ))}
            {!neighbors.busy &&
              !neighbors.error &&
              !neighbors.data?.items.length && (
                <p className="text-muted text-sm">
                  Introduce yourself. You could be the first neighbor here.
                </p>
              )}
            <Link to="/neighbors" className="sidebar-more">
              Meet everyone →
            </Link>
          </section>
          <section className="sidebar-section sidebar-discussions">
            <div className="sidebar-heading">
              <MessageCircle size={17} />
              <h2>Active conversations</h2>
            </div>
            <QueryState
              busy={discovery.busy}
              error={discovery.error}
              retry={discovery.reload}
            />
            {discovery.data?.items.slice(0, 5).map((item) => (
              <Link
                className="mini-discussion"
                state={state}
                to={
                  (item.kind === "work" ? "/works/" : "/posts/") +
                  item.id +
                  "#conversation"
                }
                key={item.id}
              >
                <strong>
                  {item.kind === "work" ? item.work.body.title : item.post.text}
                </strong>
                <span>
                  {item.commentCount}{" "}
                  {item.commentCount === 1 ? "reply" : "replies"} ·{" "}
                  {item.kind === "work"
                    ? item.work.owner.name
                    : item.post.owner.name}
                </span>
              </Link>
            ))}
            {!discovery.busy &&
              !discovery.error &&
              !discovery.data?.items.length && (
                <p className="text-muted text-sm">
                  Conversations with recent replies will appear here.
                </p>
              )}
          </section>
          <Link className="sidebar-agent-link" to="/me/agents">
            Bring your agents along <ArrowUpRight size={15} />
          </Link>
        </aside>
      </div>
    </>
  );
}
