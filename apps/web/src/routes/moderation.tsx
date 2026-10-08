import { useState } from "react";
import { RequireAuth } from "../components/auth";
import { useApi, errorMessage } from "../components/api";
import {
  useNeighborhoodPage,
  QueryState,
  LoadMore,
} from "../components/neighborhood";
import { Notice, Empty, Dialog } from "../components/ui";
import type { ReportView } from "../shared/contracts";
export default function Moderation() {
  return (
    <RequireAuth>
      <Reports />
    </RequireAuth>
  );
}
function Reports() {
  const api = useApi(),
    query = useNeighborhoodPage<ReportView>(
      "/moderation/reports",
      undefined,
      true,
    );
  const [action, setAction] = useState<{
      report: ReportView;
      kind: "hide" | "dismiss" | "restore";
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function perform() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      await api("/moderation/reports/" + action.report.id, {
        action: action.kind,
        confirmed: true,
      });
      setAction(null);
      query.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-top">
        <div>
          <h1>musegod.ai care.</h1>
          <p>
            Review reports, hide harmful content, and restore it when
            appropriate.
          </p>
        </div>
      </div>
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy &&
        !query.error &&
        (query.data?.items.length ? (
          <div className="space-y-4">
            {query.data.items.map((r) => (
              <article className="panel" key={r.id}>
                <div className="flex items-center justify-between">
                  <strong>{r.targetKind} report</strong>
                  <span className="status-chip">{r.status}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap mt-3">{r.reason}</p>
                {r.preview && (
                  <blockquote className="moderation-preview">
                    {r.preview}
                  </blockquote>
                )}
                {r.targetPath && (
                  <a
                    className="text-link inline-block mt-3"
                    href={r.targetPath}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View in context ↗
                  </a>
                )}
                <div className="flex gap-4 mt-5">
                  {r.status === "pending" && (
                    <>
                      <button
                        className="secondary"
                        onClick={() => setAction({ report: r, kind: "hide" })}
                      >
                        Hide content
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          setAction({ report: r, kind: "dismiss" })
                        }
                      >
                        Dismiss report
                      </button>
                    </>
                  )}
                  {r.status === "hidden" && (
                    <button
                      className="secondary"
                      onClick={() => setAction({ report: r, kind: "restore" })}
                    >
                      Restore content
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="No reports to review." />
        ))}
      <LoadMore
        next={query.data?.nextCursor}
        busy={query.moreBusy}
        error={query.moreError}
        onClick={() => void query.more()}
      />
      {action && (
        <Dialog
          title={
            action.kind === "hide"
              ? "Hide this from musegod.ai?"
              : action.kind === "restore"
                ? "Restore this content?"
                : "Dismiss this report?"
          }
          onClose={() => !busy && setAction(null)}
        >
          <p>
            {action.kind === "hide"
              ? "This also hides related conversations and public media where applicable. Account reports restrict the entire household."
              : action.kind === "restore"
                ? "This makes eligible content available again. Deleted content remains deleted."
                : "The reported content will remain available."}
          </p>
          {error && <Notice>{error}</Notice>}
          <button
            className="primary mt-5"
            disabled={busy}
            onClick={() => void perform()}
          >
            {busy ? "Applying…" : "Confirm"}
          </button>
        </Dialog>
      )}
    </>
  );
}
