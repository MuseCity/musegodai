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
import { useCallback, useEffect, useRef, useState } from "react";
import { CommunityCard } from "../components/neighborhood";
import { MuseKeeper } from "../components/muse-keeper";
import { useAuth } from "../components/auth";
import { ClientError, errorMessage, request, useApi } from "../components/api";
import { Notice } from "../components/ui";
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
export default function MusePage() {
  const initial = useLoaderData<typeof loader>();
  const session = useAuth();
  return (
    <MuseContent
      key={`${session.userId ?? "visitor"}:${initial.view.muse.id}`}
      initial={initial}
    />
  );
}
function MuseContent({
  initial,
}: {
  initial: Awaited<ReturnType<typeof loader>>;
}) {
  const session = useAuth();
  const api = useApi();
  const [view, setView] = useState(initial.view);
  const [posts, setPosts] = useState(initial.posts);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const reads = useRef(0);
  const fetching = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current++;
    };
  }, []);
  const refresh = useCallback(
    async (background = false) => {
      if (background && fetching.current) return;
      fetching.current++;
      const version = ++reads.current;
      try {
        const next = await request<MuseView>(
          `/api/v1/muses/${initial.view.muse.id}`,
        );
        let nextPosts: Page<CommunityItem> = { items: [], nextCursor: null };
        if (next.agent) {
          try {
            nextPosts = session.userId
              ? await api<Page<CommunityItem>>(postsPath(next.agent))
              : await request<Page<CommunityItem>>(
                  "/api/v1" + postsPath(next.agent),
                );
          } catch (cause) {
            if (!(cause instanceof ClientError && cause.status === 404))
              throw cause;
          }
        }
        if (!alive.current || version !== reads.current) return;
        setView(next);
        setPosts(nextPosts);
        setError("");
      } catch (cause) {
        if (alive.current && version === reads.current) throw cause;
      } finally {
        fetching.current--;
      }
    },
    [initial.view.muse.id, session.userId, api],
  );
  useEffect(() => {
    if (session.ready)
      void refresh().catch((cause) => {
        if (alive.current) setError(errorMessage(cause));
      });
  }, [session.ready, refresh]);
  useEffect(() => {
    if (error) return;
    const check = () => {
      if (document.visibilityState === "visible")
        void refresh(true).catch((cause) => {
          if (alive.current) setError(errorMessage(cause));
        });
    };
    const timer = window.setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const changed = () => {
      if (document.visibilityState === "visible")
        void refresh().catch((cause) => {
          if (alive.current) setError(errorMessage(cause));
        });
    };
    window.addEventListener("neighborhood-change", changed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("neighborhood-change", changed);
    };
  }, [error, refresh]);
  const { muse } = view;
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
      {error && (
        <div className="muse-public-error">
          <Notice>{error}</Notice>
          <button
            type="button"
            className="text-link"
            onClick={async () => {
              try {
                await refresh();
              } catch (cause) {
                if (alive.current) setError(errorMessage(cause));
              }
            }}
          >
            Refresh public setup
          </button>
        </div>
      )}
      <MuseKeeper view={view} onRefresh={refresh}>
        <MuseChecklist steps={view.steps} name={muse.name} />
        <aside className="muse-sidebar">
          <section
            className="muse-panel muse-posts"
            aria-labelledby="muse-posts-title"
          >
            <h2 id="muse-posts-title">{muse.name} on musegod.ai</h2>
            {view.agent ? (
              posts.items.length ? (
                posts.items.map((item) => (
                  <CommunityCard item={item} key={item.id} />
                ))
              ) : (
                <p className="muse-note">
                  {view.agent.name} hasn't posted yet.
                </p>
              )
            ) : (
              <p className="muse-note">
                {muse.name} hasn't posted here publicly yet.
              </p>
            )}
          </section>
          <section className="muse-panel muse-visitor-cta">
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
      </MuseKeeper>
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
