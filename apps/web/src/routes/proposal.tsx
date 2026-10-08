import { pageSeo, personSchema, seoMeta } from "../shared/seo";
import { publicRead } from "../route-data";
import type { MetaFunction } from "react-router";
import { useEffect, useState } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  type LoaderFunctionArgs,
} from "react-router";
import { servicesContext } from "../context";
import { useAuth } from "../components/auth";
import { useApi, errorMessage } from "../components/api";
import {
  Byline,
  QueryState,
  ReportButton,
  useNeighborhoodData,
} from "../components/neighborhood";
import { MembershipCard, useMembership } from "../components/membership";
import { Dialog, Notice } from "../components/ui";
import {
  governanceDate,
  voteChoices,
  type Proposal,
  type VoteChoice,
} from "../shared/governance";
export async function loader(args: LoaderFunctionArgs) {
  const proposal = await publicRead<Proposal>(
    args,
    "/proposals/" + args.params.id,
  );
  const origin = args.context.get(servicesContext).origin;
  return {
    ...proposal,
    seo: pageSeo(origin, args.url, {
      title: proposal.title + " — musegod.ai",
      description: proposal.body,
      structured: {
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        name: proposal.title,
        text: proposal.body,
        datePublished: proposal.createdAt,
        author: personSchema(origin, proposal.owner),
        url: new URL("/governance/" + proposal.id, origin).href,
      },
    }),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
const labels: Record<VoteChoice, string> = {
  for: "For",
  against: "Against",
  abstain: "Abstain",
};
export default function ProposalPage() {
  const auth = useAuth(),
    location = useLocation();
  return <Detail key={(auth.userId ?? "public") + location.key} />;
}
function Detail() {
  const initial = useLoaderData<typeof loader>(),
    auth = useAuth(),
    api = useApi();
  const query = useNeighborhoodData<Proposal>(
      "/proposals/" + initial.id,
      initial,
    ),
    member = useMembership();
  const [choice, setChoice] = useState<VoteChoice>("for"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  const [action, setAction] = useState<"cancel" | "execution" | null>(null),
    [note, setNote] = useState("");
  useEffect(() => {
    if (query.data?.myVote) setChoice(query.data.myVote.choice);
  }, [query.data?.myVote?.choice]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !busy) query.reload();
    };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [query.reload, busy]);
  async function submit() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const p = await api<Proposal>(
        "/proposals/" + initial.id + "/vote",
        { choice },
        "PUT",
      );
      query.setData(p);
      member.reload();
      setSaved(
        `Vote saved: ${labels[p.myVote!.choice]}, weight ${p.myVote!.weight}.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function manage() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      query.setData(
        await api<Proposal>("/proposals/" + initial.id + "/" + action, {
          [action === "cancel" ? "reason" : "result"]: note,
          confirmed: true,
        }),
      );
      setAction(null);
      setNote("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const p = query.data;
  return (
    <div className="governance-layout">
      <Link className="text-link" to="/governance">
        ← Governance
      </Link>
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {p && !query.error && (
        <>
          <article className="governance-panel">
            <span className="governance-status">{p.status}</span>
            <h1 className="mt-4">{p.title}</h1>
            <Byline owner={p.owner} agent={null} date={p.createdAt} />
            <p className="governance-body">{p.body}</p>
            <dl className="governance-dates">
              <div>
                <dt>Voting opens</dt>
                <dd>{governanceDate(p.startsAt)}</dd>
              </div>
              <div>
                <dt>Voting closes</dt>
                <dd>{governanceDate(p.endsAt)}</dd>
              </div>
            </dl>
            {p.cancellation && (
              <Notice>
                Cancelled {governanceDate(p.cancellation.at)}:{" "}
                {p.cancellation.reason}
              </Notice>
            )}
            {p.execution && (
              <section className="mt-5">
                <h2>Execution record</h2>
                <p className="governance-body">{p.execution.result}</p>
                <p className="text-sm text-muted">
                  Recorded {governanceDate(p.execution.at)}. This is an
                  operator's record of execution.
                </p>
              </section>
            )}
            <div className="flex flex-wrap gap-4 mt-6">
              <ReportButton kind="proposal" id={p.id} />
              {p.canCancel && (
                <button
                  className="text-link"
                  onClick={() => {
                    setAction("cancel");
                    setNote("");
                    setError("");
                  }}
                >
                  Cancel proposal
                </button>
              )}
              {p.canRecordExecution && (
                <button
                  className="text-link"
                  onClick={() => {
                    setAction("execution");
                    setNote("");
                    setError("");
                  }}
                >
                  Record execution result
                </button>
              )}
            </div>
          </article>
          <section className="governance-panel">
            <h2>
              {p.status === "voting" || p.status === "announcement"
                ? "Current results"
                : "Recorded results"}
            </h2>
            <p>
              <strong>{p.results.participants}</strong> different accounts
              participated · {p.rules.quorum} required
            </p>
            <div className="vote-results">
              {voteChoices.map((c) => (
                <div key={c}>
                  <div className="flex justify-between">
                    <span>{labels[c]}</span>
                    <strong>{p.results[c]}</strong>
                  </div>
                  <progress
                    aria-label={labels[c] + " weighted votes"}
                    value={p.results[c]}
                    max={Math.max(
                      1,
                      p.results.for + p.results.against + p.results.abstain,
                    )}
                  />
                </div>
              ))}
            </div>
            <p className="text-sm text-muted">
              {p.rules.quorum} accounts must participate and For must exceed
              Against. Abstentions count toward participation. A tie does not
              pass. Published content and rules cannot be edited.
            </p>
          </section>
          <MembershipCard query={member} />
          <section className="governance-panel">
            <h2>Your vote</h2>
            {p.myVote && (
              <p>
                Recorded:{" "}
                <strong>
                  {labels[p.myVote.choice]} · weight {p.myVote.weight}
                </strong>
                . Checked {governanceDate(p.myVote.checkedAt)}.
              </p>
            )}
            {p.status === "voting" ? (
              auth.userId ? (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                  }}
                >
                  <fieldset disabled={busy} className="vote-choices">
                    <legend className="sr-only">Your choice</legend>
                    {voteChoices.map((c) => (
                      <label key={c}>
                        <input
                          type="radio"
                          name="vote"
                          value={c}
                          checked={choice === c}
                          onChange={() => setChoice(c)}
                        />
                        {labels[c]}
                      </label>
                    ))}
                  </fieldset>
                  <p>
                    Submitting checks your current MUSEGOD balance and replaces
                    your previous vote. Your recorded weight stays fixed until
                    you submit again. No signature or gas is needed.
                  </p>
                  <button className="primary" disabled={busy}>
                    {busy
                      ? "Checking balance and saving…"
                      : p.myVote
                        ? "Update vote and recheck balance"
                        : "Submit vote"}
                  </button>
                </form>
              ) : (
                <button
                  className="primary"
                  onClick={auth.login}
                  disabled={!auth.ready}
                >
                  Sign in to vote
                </button>
              )
            ) : (
              <p>
                {p.status === "announcement"
                  ? "The announcement period is open. Voting begins at the time above."
                  : "Voting is closed. Recorded votes are retained."}
              </p>
            )}
            {saved && (
              <p role="status" className="mt-4">
                {saved}
              </p>
            )}
            {error && !action && <Notice>{error}</Notice>}
            <button
              className="text-link mt-4"
              onClick={query.reload}
              disabled={busy}
            >
              Refresh proposal
            </button>
          </section>
        </>
      )}
      {action && (
        <Dialog
          title={
            action === "cancel"
              ? "Cancel this proposal?"
              : "Record execution result"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void manage();
            }}
          >
            <p>
              {action === "cancel"
                ? "Voting will stop. The proposal, reason and votes will remain on record."
                : "Describe what was actually carried out. This record is permanent and does not execute a transaction."}
            </p>
            <label>
              {action === "cancel" ? "Reason" : "Result"}
              <textarea
                required
                minLength={5}
                maxLength={action === "cancel" ? 1000 : 5000}
                rows={5}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
              />
            </label>
            {error && <Notice>{error}</Notice>}
            <button className="primary" disabled={busy}>
              {busy
                ? "Saving…"
                : action === "cancel"
                  ? "Confirm cancellation"
                  : "Save execution record"}
            </button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
