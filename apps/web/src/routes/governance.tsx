import { collectionSeo, seoMeta } from "../shared/seo";
import { publicRead } from "../route-data";
import type { MetaFunction } from "react-router";
import { useState } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import { servicesContext } from "../context";
import { useAuth } from "../components/auth";
import { useApi, errorMessage } from "../components/api";
import {
  useNeighborhoodPage,
  QueryState,
  LoadMore,
} from "../components/neighborhood";
import { MembershipCard, useMembership } from "../components/membership";
import { Empty, Notice, Dialog } from "../components/ui";
import type { Page } from "../shared/contracts";
import { governanceDate, type Proposal } from "../shared/governance";

export async function loader(args: LoaderFunctionArgs) {
  const url = args.url;
  const page = await publicRead<Page<Proposal>>(
    args,
    "/proposals" + url.search,
  );
  return {
    ...page,
    seo: collectionSeo(
      args.context.get(servicesContext).origin,
      url,
      "Governance — musegod.ai",
      "Read community proposals, voting results and public execution records on musegod.ai.",
      page.items.map((p) => "/governance/" + p.id),
    ),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function Governance() {
  const auth = useAuth(),
    location = useLocation();
  return <Proposals key={(auth.userId ?? "public") + location.key} />;
}
function Proposals() {
  const initial = useLoaderData<typeof loader>(),
    location = useLocation(),
    query = useNeighborhoodPage<Proposal>(
      "/proposals" + location.search,
      initial,
    ),
    member = useMembership();
  const api = useApi(),
    navigate = useNavigate();
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [body, setBody] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function publish() {
    setBusy(true);
    setError("");
    try {
      const result = await api<Proposal>("/proposals", { title, body });
      setCreating(false);
      await navigate("/governance/" + result.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="governance-layout">
      <div className="page-top">
        <div>
          <div className="eyebrow">BUILD OUR CITY TOGETHER</div>
          <h1>A voice in musegod.ai.</h1>
          <p>Discuss a direction. Give it a day. Decide together.</p>
        </div>
        <button
          className="primary"
          disabled={!member.data?.formalMember || !!member.error || member.busy}
          onClick={() => setCreating(true)}
        >
          New proposal
        </button>
      </div>
      <MembershipCard query={member} />
      <section className="governance-rules">
        <h2>How decisions work</h2>
        <p>
          24 hours for everyone to read, then 3 days to vote. Every signed-in
          account has 1 vote. Formal members have 10 votes total.
        </p>
        <p>
          At least 5 different accounts must participate. A proposal passes when
          the weight in favor exceeds the weight against. Abstentions count
          toward participation; a tie does not pass.
        </p>
        <p className="text-sm text-muted">
          Voting is free and needs no wallet signature. Balances are checked
          when you submit or change a vote. Existing votes keep their recorded
          weight. Moving the same tokens between accounts can qualify more than
          one account in this version.
        </p>
      </section>
      <div className="flex items-center justify-between">
        <h2>Proposals</h2>
        <button
          className="text-link"
          disabled={query.busy}
          onClick={query.reload}
        >
          Refresh proposals
        </button>
      </div>
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy &&
        !query.error &&
        (query.data?.items.length ? (
          <div className="space-y-4">
            {query.data.items.map((p) => (
              <article className="governance-panel" key={p.id}>
                <span className="governance-status">{p.status}</span>
                <h2 className="mt-3">
                  <Link to={"/governance/" + p.id}>{p.title}</Link>
                </h2>
                <p className="governance-excerpt">
                  {p.body.slice(0, 240)}
                  {p.body.length > 240 ? "…" : ""}
                </p>
                <p className="text-sm text-muted">
                  By {p.owner.name} · Voting {governanceDate(p.startsAt)} —{" "}
                  {governanceDate(p.endsAt)}
                </p>
                <p>
                  {p.results.participants} participants · {p.results.for} for ·{" "}
                  {p.results.against} against · {p.results.abstain} abstain
                </p>
                <Link className="text-link" to={"/governance/" + p.id}>
                  Read proposal →
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="What should we build together?">
            <p>
              Formal members can publish the first proposal. Everyone can take
              part in the vote.
            </p>
          </Empty>
        ))}
      <LoadMore
        publicPath={location.pathname + location.search}
        next={query.data?.nextCursor}
        busy={query.moreBusy}
        error={query.moreError}
        onClick={query.more}
      />
      {creating && (
        <Dialog
          title="Publish a proposal"
          onClose={() => {
            if (
              !busy &&
              ((!title && !body) ||
                window.confirm("Discard your unsaved proposal?"))
            )
              setCreating(false);
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void publish();
            }}
          >
            <label>
              Title
              <input
                required
                maxLength={120}
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Proposal
              <textarea
                required
                minLength={10}
                maxLength={10000}
                rows={8}
                value={body}
                disabled={busy}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Explain the change, what it needs and the intended outcome."
              />
            </label>
            <p>
              Publishing starts the 24-hour announcement now, followed by 3 days
              of voting. The content and rules become fixed. You can cancel
              before voting ends; the record remains visible.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" required disabled={busy} />I have reviewed
              the proposal and want to publish it with these rules.
            </label>
            {error && <Notice>{error}</Notice>}
            <button className="primary" disabled={busy}>
              {busy ? "Checking membership…" : "Publish proposal"}
            </button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
