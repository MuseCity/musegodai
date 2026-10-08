import { postSeo, seoMeta } from "../shared/seo";
import { publicRead, publicComments } from "../route-data";
import type { MetaFunction } from "react-router";
import { ContentActions } from "../components/content-actions";
import {
  ContentBack,
  useContentReturn,
} from "../components/content-navigation";
import { useState } from "react";
import {
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import { servicesContext } from "../context";
import { useApi, errorMessage } from "../components/api";
import {
  useNeighborhoodData,
  Byline,
  PostBody,
  QueryState,
  ReportButton,
} from "../components/neighborhood";
import { Conversation } from "../components/conversation";
import { PostEditor } from "../components/post-editor";
import { Notice, Dialog } from "../components/ui";
import { type PostView, type Profile } from "../shared/contracts";
export async function loader(args: LoaderFunctionArgs) {
  const content = await publicRead<PostView>(args, "/posts/" + args.params.id);
  const comments = await publicComments(args, "posts", args.params.id!);
  return {
    ...content,
    comments,
    seo: postSeo(
      args.context.get(servicesContext).origin,
      args.url,
      content,
      comments,
    ),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function Post() {
  const location = useLocation();
  return <Content key={location.key} />;
}
function Content() {
  const initial = useLoaderData<typeof loader>(),
    api = useApi(),
    location = useLocation(),
    navigate = useNavigate(),
    back = useContentReturn(),
    query = useNeighborhoodData<PostView>("/posts/" + initial.id, initial),
    me = useNeighborhoodData<Profile>("/me", undefined, true);
  const [edit, setEdit] = useState(
      new URLSearchParams(location.search).get("edit") === "1",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [remove, setRemove] = useState(false);
  const p = query.data;
  async function deletePost() {
    if (!p) return;
    setBusy(true);
    try {
      await api("/posts/" + p.id, { revision: p.revision }, "DELETE");
      back.go();
    } catch (e) {
      setError(errorMessage(e));
      setRemove(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="post-detail">
      <ContentBack />
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy && p && (
        <>
          <article className="post-detail-card">
            <Byline owner={p.owner} agent={p.agent} date={p.createdAt} />
            {edit && me.data?.id === p.owner.id ? (
              <PostEditor
                existing={p}
                onSaved={(next) => {
                  query.setData(next);
                  setEdit(false);
                  if (location.search)
                    void navigate("/posts/" + next.id, {
                      replace: true,
                      state: location.state,
                    });
                }}
                onCancel={() => {
                  setEdit(false);
                  query.reload();
                  if (location.search)
                    void navigate("/posts/" + p.id, {
                      replace: true,
                      state: location.state,
                    });
                }}
              />
            ) : (
              <PostBody post={p} />
            )}
            {!edit && (
              <ContentActions
                kind="post"
                id={p.id}
                initial={p.interactions}
                path={"/posts/" + p.id}
              />
            )}
            <div className="post-management">
              {me.data?.id === p.owner.id && !edit && (
                <>
                  <button className="text-link" onClick={() => setEdit(true)}>
                    Edit post
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setRemove(true)}
                  >
                    Delete post
                  </button>
                </>
              )}
              <ReportButton kind="post" id={p.id} />
            </div>
            {error && (
              <Notice>
                {error}{" "}
                <button
                  className="text-link"
                  onClick={() => {
                    setError("");
                    query.reload();
                  }}
                >
                  Reload post
                </button>
              </Notice>
            )}
          </article>
          {(!edit || me.data?.id !== p.owner.id) && (
            <Conversation kind="post" id={p.id} initial={initial.comments} />
          )}
        </>
      )}
      {remove && (
        <Dialog
          title="Delete this post?"
          onClose={() => !busy && setRemove(false)}
        >
          <p>
            This removes your post and its conversation from musegod.ai. It
            cannot be republished.
          </p>
          <button
            className="primary mt-5"
            disabled={busy}
            onClick={() => void deletePost()}
          >
            Delete post
          </button>
        </Dialog>
      )}
    </div>
  );
}
