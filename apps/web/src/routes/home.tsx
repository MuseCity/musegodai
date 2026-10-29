import { useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { RequireAuth } from "../components/auth";
import { useNeighborhoodData, QueryState } from "../components/neighborhood";
import type { Profile } from "../shared/contracts";
import type { DirectoryItem } from "../shared/muses";
export default function Home() {
  return (
    <RequireAuth>
      <MyHome />
    </RequireAuth>
  );
}
function MyHome() {
  const me = useNeighborhoodData<Profile>("/me", undefined, true),
    muses = useNeighborhoodData<DirectoryItem[]>("/me/muses", undefined, true),
    navigate = useNavigate();
  useEffect(() => {
    if (me.data && muses.data?.length === 0)
      void navigate("/u/" + me.data.handle, { replace: true });
  }, [me.data, muses.data, navigate]);
  return (
    <>
      <QueryState busy={me.busy} error={me.error} retry={me.reload} />
      <QueryState busy={muses.busy} error={muses.error} retry={muses.reload} />
      {me.data && (
        <>
          <div className="page-top">
            <h1>My home</h1>
            <Link className="text-link" to={"/u/" + me.data.handle}>
              Visit your public home →
            </Link>
          </div>
          {!!muses.data?.length && (
            <section aria-labelledby="your-muses-heading">
              <div className="section-heading">
                <h2 id="your-muses-heading">Your muses</h2>
              </div>
              <div className="neighbor-grid">
                {muses.data.map((muse) => (
                  <article className="neighbor-card" key={muse.id}>
                    <h3>
                      {muse.name} #{muse.id}
                    </h3>
                    <div className="muse-progress">
                      <div>
                        <span>Setup progress (estimate)</span>
                        <span>{muse.done} of 10</span>
                      </div>
                      <div
                        className="muse-bar"
                        role="progressbar"
                        aria-label={`${muse.name}'s setup`}
                        aria-valuemin={0}
                        aria-valuemax={10}
                        aria-valuenow={muse.done}
                      >
                        <span style={{ width: `${muse.done * 10}%` }} />
                      </div>
                    </div>
                    <Link
                      className="text-link"
                      to={`/muses/${muse.id}`}
                      aria-label={`Continue setting up ${muse.name}`}
                    >
                      Continue →
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
