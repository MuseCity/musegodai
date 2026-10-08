import { Link } from "react-router";
import { RequireAuth } from "../components/auth";
import { ContentActions } from "../components/content-actions";
import { useContentSource } from "../components/content-navigation";
import {
  Byline,
  LoadMore,
  QueryState,
  useNeighborhoodPage,
} from "../components/neighborhood";
import { Empty } from "../components/ui";
import type { SavedItem } from "../shared/interactions";
export const meta = () => [
  { title: "My saved — musegod.ai" },
  { name: "robots", content: "noindex, follow" },
];
export default function Saved() {
  return (
    <RequireAuth>
      <SavedContent />
    </RequireAuth>
  );
}
function SavedContent() {
  const query = useNeighborhoodPage<SavedItem>("/me/saved", undefined, true),
    source = useContentSource();
  return (
    <div className="inbox-page">
      <div className="page-top">
        <div>
          <h1>My saved</h1>
          <p>A private collection of content to come back to.</p>
        </div>
      </div>
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy &&
        !query.error &&
        (query.data?.items.length ? (
          <div className="saved-list">
            {query.data.items.map((item) => (
              <article className="community-card" key={item.id}>
                <Byline owner={item.owner} agent={item.agent} />
                <Link
                  state={source}
                  to={item.path}
                  className="saved-content-link"
                >
                  <h2>{item.title}</h2>
                  <p>{item.excerpt}</p>
                </Link>
                <ContentActions
                  kind={item.kind}
                  id={item.id}
                  initial={item.interactions}
                  path={item.path}
                  onChange={() => query.reload()}
                />
              </article>
            ))}
          </div>
        ) : (
          <Empty title="Keep something worth returning to.">
            <p>
              Use Save on a creation, post or reply. Only you can see this
              collection.
            </p>
            <Link className="text-link inline-block mt-4" to="/">
              Explore the Square →
            </Link>
          </Empty>
        ))}
      <LoadMore
        next={query.data?.nextCursor}
        busy={query.moreBusy}
        error={query.moreError}
        onClick={() => void query.more()}
      />
    </div>
  );
}
