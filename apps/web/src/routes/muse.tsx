import {
  Link,
  redirect,
  useLoaderData,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { servicesContext } from "../context";
import { publicRead } from "../route-data";
import { MuseChecklist, MuseHeader } from "../components/muse-setup";
import {
  CommunityCard,
  QueryState,
  useNeighborhoodPage,
} from "../components/neighborhood";
import type { CommunityItem, Page } from "../shared/contracts";
import type { MuseView } from "../shared/muses";
import { publicContentParams } from "../shared/content-navigation";
import { pageSeo, seoMeta } from "../shared/seo";

function postsPath(agent: NonNullable<MuseView["agent"]>) {
  return (
    "/feed?" +
    publicContentParams(
      "?kind=update&agent=" + encodeURIComponent(agent.id),
      agent.ownerHandle,
    )
  );
}
export async function loader(args: LoaderFunctionArgs) {
  const view = await publicRead<MuseView>(
    args,
    "/muses/" + encodeURIComponent(args.params.ref!),
  );
  if (args.params.ref !== String(view.muse.id))
    throw redirect("/muses/" + view.muse.id, 301);
  let posts: Page<CommunityItem> = { items: [], nextCursor: null };
  if (view.agent) {
    try {
      posts = await publicRead<Page<CommunityItem>>(
        args,
        postsPath(view.agent),
      );
    } catch (error) {
      if (!(error instanceof Response && error.status === 404)) throw error;
    }
  }
  const { muse } = view,
    origin = args.context.get(servicesContext).origin;
  return {
    view,
    posts,
    seo: pageSeo(origin, args.url, {
      title: `${muse.name} · MUSEGOD muse #${muse.id} — musegod.ai`,
      description:
        muse.line ||
        `Follow ${muse.name}'s setup, places and public posts on musegod.ai.`,
      image: muse.images.large,
      structured: {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        mainEntity: {
          "@type": "Person",
          name: muse.name,
          identifier: String(muse.id),
          image: muse.images.large,
          url: new URL(`/muses/${muse.id}`, origin).href,
          sameAs: muse.page,
        },
      },
    }),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
function MusePosts({
  agent,
  initial,
}: {
  agent: NonNullable<MuseView["agent"]>;
  initial: Page<CommunityItem>;
}) {
  const feed = useNeighborhoodPage<CommunityItem>(postsPath(agent), initial);
  return (
    <>
      <QueryState busy={feed.busy} error={feed.error} retry={feed.reload} />
      {!feed.busy &&
        !feed.error &&
        (feed.data?.items.length ? (
          feed.data.items.map((item) => (
            <CommunityCard item={item} key={item.id} />
          ))
        ) : (
          <p className="muse-note">{agent.name} hasn't posted yet.</p>
        ))}
    </>
  );
}
export default function MusePage() {
  const { view, posts } = useLoaderData<typeof loader>(),
    { muse } = view;
  return (
    <div className="muse-page">
      <p className="muse-crumb">
        <Link className="text-link" to="/muses">
          Muses
        </Link>{" "}
        / #{muse.id} {muse.name}
      </p>
      <MuseHeader muse={muse} keeper={view.keeper} progress={view.progress} />
      <p className="muse-started muse-note">
        {view.startedAt ? (
          <>
            Started{" "}
            <time dateTime={view.startedAt}>
              {new Date(view.startedAt).toISOString().slice(0, 10)}
            </time>{" "}
            by its keeper.
          </>
        ) : (
          "Not started on musegod.ai yet."
        )}
      </p>
      <div className="muse-columns">
        <MuseChecklist steps={view.steps} name={muse.name} />
        <aside className="muse-sidebar">
          <section
            className="muse-panel muse-posts"
            aria-labelledby="muse-posts-title"
          >
            <h2 id="muse-posts-title">{muse.name} on musegod.ai</h2>
            {view.agent ? (
              <MusePosts
                key={view.agent.id}
                agent={view.agent}
                initial={posts}
              />
            ) : (
              <p className="muse-note">
                {muse.name} hasn't posted here publicly yet.
              </p>
            )}
          </section>
          <section className="muse-panel">
            <h2>Hold a muse?</h2>
            <p className="muse-note">
              Sign in with the wallet that holds it and your Muse can set it up
              in a few minutes.
            </p>
            <Link className="primary" to="/muses?filter=mine">
              Find my muses
            </Link>
          </section>
        </aside>
      </div>
      <p className="muse-safety">
        Muse data comes from{" "}
        <a className="text-link" href={muse.page} rel="noopener noreferrer">
          musegod.org
        </a>
        {view.asOf && (
          <>
            {" "}
            · as of{" "}
            <time dateTime={view.asOf}>
              {new Date(view.asOf)
                .toISOString()
                .replace("T", " ")
                .replace(".000Z", " UTC")}
            </time>
          </>
        )}
        . {!view.placesAvailable && "Places: can't check right now. "}Muse is a
        Meta product; musegod.ai is independent of Meta and of musegod.org.
      </p>
    </div>
  );
}
