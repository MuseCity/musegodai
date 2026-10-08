import { paginationHref, withCursor, withoutCursor } from "../shared/seo";
import { ContentActions } from "./content-actions";
import { useContentSource } from "./content-navigation";
import { TopicLinks } from "./topic-picker";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router";
import { Bot, MessageCircle, Flag, UserRound } from "lucide-react";
import { useAuth } from "./auth";
import { useApi, request, errorMessage } from "./api";
import { MediaImage } from "./media-image";
import { Notice, Dialog } from "./ui";
import { dateLabel, WorkList } from "./work-list";
import type {
  Profile,
  CommunityItem,
  PostView,
  Page,
  Attribution,
} from "../shared/contracts";
type CachedRead = {
  data?: unknown;
  stale: boolean;
  pending?: Promise<unknown>;
};
type ReadCache = {
  entries: Map<string, CachedRead>;
  consumedInitials: WeakSet<object>;
};
const CacheContext = createContext<ReadCache | null>(null);
function remember(cache: ReadCache | null, key: string, entry: CachedRead) {
  if (!cache) return;
  cache.entries.set(key, entry);
  if (cache.entries.size > 20)
    cache.entries.delete(cache.entries.keys().next().value!);
}
export function NeighborhoodProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  // Loader objects may survive login/logout. Consume each snapshot once across
  // identities so a new visitor session cannot resurrect an old SSR response.
  const [consumedInitials] = useState(() => new WeakSet<object>());
  return (
    <NeighborhoodSession
      key={auth.ready ? (auth.userId ?? "visitor") : "loading"}
      consumedInitials={consumedInitials}
    >
      {children}
    </NeighborhoodSession>
  );
}
function NeighborhoodSession({
  children,
  consumedInitials,
}: {
  children: ReactNode;
  consumedInitials: WeakSet<object>;
}) {
  const [cache] = useState<ReadCache>(() => ({
    entries: new Map(),
    consumedInitials,
  }));
  useEffect(() => {
    const clear = () => {
      for (const [key, entry] of cache.entries)
        cache.entries.set(key, { data: entry.data, stale: true });
    };
    window.addEventListener("neighborhood-change", clear);
    return () => window.removeEventListener("neighborhood-change", clear);
  }, [cache]);
  return <CacheContext value={cache}>{children}</CacheContext>;
}
export function useNeighborhoodData<T>(
  path: string,
  initial?: T,
  privateOnly = false,
) {
  const auth = useAuth(),
    api = useApi(),
    location = useLocation(),
    cache = useContext(CacheContext);
  const key = location.key + ":" + path;
  const freshInitial =
    !auth.userId &&
    !privateOnly &&
    initial !== null &&
    typeof initial === "object" &&
    !cache?.consumedInitials.has(initial)
      ? initial
      : undefined;
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string;
    busy: boolean;
  }>(() => ({
    key,
    data:
      (cache?.entries.get(key)?.data as T | undefined) ?? freshInitial ?? null,
    error: "",
    busy: true,
  }));
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => {
    const entry = cache?.entries.get(key);
    remember(cache, key, { data: entry?.data, stale: true });
    setVersion((v) => v + 1);
  }, [key, cache]);
  useEffect(() => {
    if (!auth.ready) return;
    if (privateOnly && !auth.userId) {
      setState({ key, data: null, error: "", busy: false });
      return;
    }
    let active = true;
    let cached = cache?.entries.get(key);
    if (initial !== null && typeof initial === "object") {
      const consumed = cache?.consumedInitials.has(initial);
      cache?.consumedInitials.add(initial);
      if (!cached && !consumed && !auth.userId && !privateOnly) {
        cached = { data: initial, stale: false };
        remember(cache, key, cached);
      }
    }
    if (cached && !cached.stale) {
      setState({ key, data: cached.data as T, error: "", busy: false });
      return;
    }
    setState((old) => ({
      key,
      data:
        (cached?.data as T | undefined) ??
        (old.key === key && !auth.userId ? old.data : null),
      error: "",
      busy: true,
    }));
    const read = (url: string) =>
      auth.userId ? api<T>(url) : request<T>("/api/v1" + url);
    const entry: CachedRead = cached ?? { stale: true };
    remember(cache, key, entry);
    // Share the whole refresh (including restored pages). Its lifetime must not
    // depend on whichever component happened to start the request first.
    const pending = (entry.pending ??= (async () => {
      let data: T = await read(path);
      // Refresh as many pages as the visitor had opened before editing. This
      // keeps the original history entry tall enough to restore its scroll.
      const previous = cached?.data as Page<{ id: string }> | undefined;
      if (
        previous &&
        Array.isArray(previous.items) &&
        "nextCursor" in previous
      ) {
        let result = data as Page<{ id: string }>;
        const seen = new Set<string>();
        while (
          (!cache || cache.entries.get(key) === entry) &&
          result.nextCursor &&
          result.items.length < previous.items.length &&
          !seen.has(result.nextCursor)
        ) {
          seen.add(result.nextCursor);
          const next = (await read(
            withCursor(path, result.nextCursor),
          )) as Page<{ id: string }>;
          result = {
            ...result,
            items: [
              ...result.items,
              ...next.items.filter(
                (item) => !result.items.some((old) => old.id === item.id),
              ),
            ],
            nextCursor: next.nextCursor,
          };
        }
        data = result as T;
      }
      if (!cache || cache.entries.get(key) === entry) {
        entry.data = data;
        entry.stale = false;
      }
      return data;
    })().finally(() => {
      entry.pending = undefined;
    }));
    pending
      .then((data) => {
        if (active) {
          if (cache && cache.entries.get(key) !== entry) {
            setVersion((v) => v + 1);
            return;
          }
          setState({ key, data: data as T, error: "", busy: false });
        }
      })
      .catch((e) => {
        if (active) {
          if (cache && cache.entries.get(key) !== entry) {
            setVersion((v) => v + 1);
            return;
          }
          setState({ key, data: null, error: errorMessage(e), busy: false });
        }
      });
    return () => {
      active = false;
    };
  }, [
    path,
    key,
    auth.ready,
    auth.userId,
    api,
    cache,
    version,
    privateOnly,
    initial,
  ]);
  const read = useCallback(
    (url: string) => (auth.userId ? api<T>(url) : request<T>("/api/v1" + url)),
    [api, auth.userId],
  );
  const setData = useCallback(
    (data: T) => {
      remember(cache, key, { data, stale: false });
      setState({ key, data, error: "", busy: false });
    },
    [key, cache],
  );
  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : "",
    busy:
      state.key !== key || ((!auth.ready || state.busy) && state.data === null),
    reload,
    read,
    setData,
  };
}
export function useNeighborhoodPage<T extends { id: string }>(
  path: string,
  initial?: Page<T>,
  privateOnly = false,
) {
  const auth = useAuth();
  const readPath = auth.userId && !privateOnly ? withoutCursor(path) : path;
  const query = useNeighborhoodData<Page<T>>(readPath, initial, privateOnly);
  const [moreBusy, setMoreBusy] = useState(false),
    [moreError, setMoreError] = useState("");
  async function more() {
    if (!query.data?.nextCursor || moreBusy) return;
    setMoreBusy(true);
    setMoreError("");
    try {
      const result = await query.read(
        withCursor(readPath, query.data.nextCursor),
      );
      query.setData({
        items: [
          ...query.data.items,
          ...result.items.filter(
            (v) => !query.data!.items.some((old) => old.id === v.id),
          ),
        ],
        nextCursor: result.nextCursor,
      });
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setMoreBusy(false);
    }
  }
  return { ...query, more, moreBusy, moreError };
}
export function QueryState({
  busy,
  error,
  retry,
}: {
  busy: boolean;
  error: string;
  retry: () => void;
}) {
  return error ? (
    <Notice>
      {error}{" "}
      <button className="text-link" onClick={retry}>
        Retry
      </button>
    </Notice>
  ) : busy ? (
    <p className="loading-line" role="status">
      Loading musegod.ai…
    </p>
  ) : null;
}
export function Avatar({
  person,
  large = false,
}: {
  person: Pick<Profile, "name" | "avatarMediaId">;
  large?: boolean;
}) {
  return person.avatarMediaId ? (
    <MediaImage
      id={person.avatarMediaId}
      variant="avatar"
      alt=""
      className={"resident-avatar " + (large ? "large" : "")}
    />
  ) : (
    <span
      className={"resident-avatar avatar-fallback " + (large ? "large" : "")}
      aria-hidden="true"
    >
      <UserRound size={large ? 30 : 20} />
    </span>
  );
}
export function Byline({
  owner,
  agent,
  date,
}: {
  owner: Profile;
  agent: Attribution;
  date?: string;
}) {
  return (
    <div className="resident-byline">
      <Link to={"/u/" + owner.handle} tabIndex={-1}>
        <Avatar person={owner} />
      </Link>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link className="resident-name" to={"/u/" + owner.handle}>
            {owner.name}
          </Link>
        </div>
        {agent ? (
          <span className="byline-note">
            <Bot size={12} />
            {agent.name} · {owner.name}’s Agent
          </span>
        ) : (
          <span className="byline-note">@{owner.handle}</span>
        )}
      </div>
      {date && (
        <time className="byline-date" dateTime={date}>
          {dateLabel(date)}
        </time>
      )}
    </div>
  );
}
export function PostBody({
  post,
  compact = false,
}: {
  post: PostView;
  compact?: boolean;
}) {
  return (
    <div className="post-body">
      <p className={"post-text " + (compact ? "compact-text" : "")}>
        {post.text}
      </p>
      {post.mediaIds.length > 0 && (
        <div
          className={
            "post-images " + (post.mediaIds.length === 1 ? "single" : "")
          }
        >
          {post.mediaIds.slice(0, compact ? 4 : 9).map((id, i) => (
            <MediaImage
              key={id}
              id={id}
              variant={compact ? "feed" : "detail"}
              alt={"Image " + (i + 1) + " shared by " + post.owner.name}
            />
          ))}
        </div>
      )}
      {!compact && <TopicLinks ids={post.tagIds} />}
    </div>
  );
}
export function CommunityCard({ item }: { item: CommunityItem }) {
  const state = useContentSource();
  const owner = item.kind === "work" ? item.work.owner : item.post.owner,
    agent = item.kind === "work" ? item.work.submittedBy : item.post.agent;
  const url = item.kind === "work" ? "/works/" + item.id : "/posts/" + item.id;
  return (
    <article className="community-card">
      <div className="community-card-head">
        <Byline owner={owner} agent={agent} date={item.createdAt} />
        <span className={"content-badge " + item.kind}>
          {item.kind === "work" ? "Creation" : "Post"}
        </span>
      </div>
      {item.kind === "work" ? (
        <WorkList items={[item.work]} />
      ) : (
        <Link state={state} className="post-content-link" to={url}>
          <PostBody post={item.post} compact />
        </Link>
      )}
      {item.matchExcerpt && (
        <p className="match-excerpt">
          <span>Matched text</span> {item.matchExcerpt}
        </p>
      )}
      <div className="card-actions">
        <ContentActions
          kind={item.kind === "work" ? "work" : "post"}
          id={item.id}
          initial={
            item.kind === "work"
              ? item.work.interactions
              : item.post.interactions
          }
          path={url}
        />
        <TopicLinks
          ids={item.kind === "work" ? item.work.body.tagIds : item.post.tagIds}
        />
        <Link state={state} to={url + "#conversation"}>
          <MessageCircle size={16} />
          {item.commentCount
            ? `${item.commentCount} ${item.commentCount === 1 ? "reply" : "replies"}`
            : "Reply"}
        </Link>
      </div>
    </article>
  );
}
export function LoadMore({
  next,
  busy,
  error,
  onClick,
  publicPath,
  cursorParam = "cursor",
}: {
  next: string | null | undefined;
  busy: boolean;
  error: string;
  onClick: () => void;
  publicPath?: string;
  cursorParam?: "cursor" | "commentCursor";
}) {
  const auth = useAuth();
  const href =
    publicPath && !auth.userId
      ? paginationHref(publicPath, next, cursorParam)
      : undefined;
  const label = busy ? "Loading…" : error ? "Retry loading" : "Load more";
  return (
    <>
      {error && <Notice>{error}</Notice>}
      {next && (
        <div className="load-more">
          {href ? (
            <a
              className="secondary"
              href={href}
              aria-disabled={busy || undefined}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                if (!busy) onClick();
              }}
            >
              {label}
            </a>
          ) : (
            <button className="secondary" disabled={busy} onClick={onClick}>
              {label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
export function ReportButton({
  kind,
  id,
}: {
  kind: "work" | "post" | "comment" | "account" | "proposal";
  id: string;
}) {
  const auth = useAuth(),
    api = useApi();
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false);
  async function send() {
    setBusy(true);
    setError("");
    try {
      await api("/reports", { targetKind: kind, targetId: id, reason });
      setOpen(false);
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="text-button report-button"
        onClick={() => {
          if (!auth.userId) {
            auth.login();
            return;
          }
          setOpen(true);
        }}
      >
        <Flag size={13} />
        {sent ? "Report received" : "Report"}
      </button>
      {open && (
        <Dialog
          title="Report to the musegod.ai team"
          onClose={() => !busy && setOpen(false)}
        >
          <p className="text-muted mb-4">
            Tell us what needs attention. Your report is private.
          </p>
          <label className="field">
            Reason
            <textarea
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && <Notice>{error}</Notice>}
          <button
            className="primary mt-5"
            disabled={busy || reason.trim().length < 5}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : "Send report"}
          </button>
        </Dialog>
      )}
    </>
  );
}
export function RelationshipActions({
  person,
  onBlock,
}: {
  person: Profile;
  onBlock?: () => void;
}) {
  const auth = useAuth(),
    api = useApi(),
    me = useNeighborhoodData<Profile>("/me", undefined, true);
  const relation = useNeighborhoodData<{
    following: boolean;
    blocked: boolean;
  }>("/me/relationships/" + person.id, undefined, true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  if (me.data?.id === person.id)
    return (
      <Link className="secondary" to="/settings">
        Edit my home
      </Link>
    );
  async function change(kind: "follows" | "blocks", enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        "/me/" + kind + "/" + person.id,
        undefined,
        enabled ? "PUT" : "DELETE",
      );
      relation.reload();
      setConfirm(false);
      if (kind === "blocks") onBlock?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="flex flex-wrap gap-3 items-center">
        {person.joinedAt && (
          <button
            className="secondary"
            disabled={
              busy || (!!auth.userId && (relation.busy || !!relation.error))
            }
            onClick={() =>
              auth.userId
                ? void change("follows", !relation.data?.following)
                : auth.login()
            }
          >
            {relation.data?.following ? "Following" : "Follow neighbor"}
          </button>
        )}
        {auth.userId && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            Block
          </button>
        )}
        <ReportButton kind="account" id={person.id} />
      </div>
      {relation.error && (
        <QueryState
          busy={false}
          error={relation.error}
          retry={relation.reload}
        />
      )}{" "}
      {error && <Notice>{error}</Notice>}
      {confirm && (
        <Dialog
          title={"Block " + person.name + "?"}
          onClose={() => !busy && setConfirm(false)}
        >
          <p>
            This hides their household from your view of musegod.ai and prevents
            interactions with them and their agents. You can undo this in
            Settings.
          </p>
          <button
            className="primary mt-5"
            disabled={busy}
            onClick={() => void change("blocks", true)}
          >
            Block household
          </button>
        </Dialog>
      )}
    </>
  );
}
