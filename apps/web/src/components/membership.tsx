import { Link, useLocation } from "react-router";
import { formatUnits } from "viem";
import { useAuth } from "./auth";
import { useNeighborhoodData, QueryState } from "./neighborhood";
import { governanceDate, type Membership } from "../shared/governance";

export function useMembership() {
  return useNeighborhoodData<Membership>("/me/membership", undefined, true);
}
export function MembershipCard({
  query,
}: {
  query: ReturnType<typeof useMembership>;
}) {
  const auth = useAuth();
  const onWalletPage = useLocation().pathname === "/wallet";
  if (!auth.userId)
    return (
      <section className="governance-panel">
        <h2>Everyone has a voice.</h2>
        <p>
          Sign in to vote. Hold 100,000 MUSEGOD in your musegod.ai wallet to
          become a formal member and publish proposals.
        </p>
        <button
          className="secondary"
          disabled={!auth.ready}
          onClick={auth.login}
        >
          Sign in
        </button>
      </section>
    );
  if (onWalletPage)
    return (
      <section className="governance-panel wallet-membership">
        <div className="wallet-section-heading">
          <h2>Membership</h2>
          <Link to="/governance" className="text-link">
            Governance ↗
          </Link>
        </div>
        {query.error ? (
          <>
            <p role="alert">Membership is temporarily unavailable.</p>
            <button className="text-link" onClick={query.reload}>
              Retry membership check
            </button>
          </>
        ) : query.busy ? (
          <p role="status">Checking membership…</p>
        ) : query.data ? (
          <>
            <p>
              <strong>
                {query.data.formalMember ? "Formal member" : "Community member"}
              </strong>
              <span className="wallet-votes">
                {query.data.weight} {query.data.weight === 1 ? "vote" : "votes"}
              </span>
            </p>
            <p className="field-note">
              Checked {governanceDate(query.data.checkedAt)}.
            </p>
          </>
        ) : (
          <p>Membership has not been checked yet.</p>
        )}
        <details className="wallet-membership-rules">
          <summary>Membership rules</summary>
          <p className="text-sm text-muted">
            Hold at least 100,000 MUSEGOD on Robinhood Chain in the wallet
            created here for 10 votes total and permission to publish proposals.
            External or imported wallets do not qualify. Each vote submission
            checks your current balance again.
          </p>
          {!query.busy && !query.error && query.data && (
            <p className="field-note">
              {query.data.balance === null
                ? "No qualifying musegod.ai wallet."
                : `${formatUnits(BigInt(query.data.balance), 18)} MUSEGOD on Robinhood Chain.`}
            </p>
          )}
          <button
            className="text-link"
            disabled={query.busy}
            onClick={query.reload}
          >
            Refresh membership
          </button>
        </details>
      </section>
    );
  return (
    <section className="governance-panel">
      <h2>{query.data?.formalMember ? "Formal member" : "Your membership"}</h2>
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy && !query.error && query.data && (
        <>
          <p>
            Your current voting weight: <strong>{query.data.weight}</strong>.{" "}
            {query.data.formalMember
              ? "You can publish proposals."
              : "All signed-in members can vote. Formal members can also publish proposals."}
          </p>
          <p className="text-sm text-muted">
            {query.data.balance === null
              ? "No qualifying musegod.ai wallet."
              : `${formatUnits(BigInt(query.data.balance), 18)} MUSEGOD on Robinhood Chain.`}{" "}
            Checked {governanceDate(query.data.checkedAt)}.
          </p>
        </>
      )}
      <p className="text-sm text-muted">
        Hold at least 100,000 MUSEGOD in the wallet created here for 10 votes
        total. External or imported wallets do not qualify. Each vote submission
        checks your current balance again.
      </p>
      <div className="flex flex-wrap gap-4">
        <Link
          to={onWalletPage ? "/governance" : "/wallet"}
          className="text-link"
        >
          {onWalletPage ? "Open governance" : "Open wallet"}
        </Link>
        <button
          className="text-link"
          disabled={query.busy}
          onClick={query.reload}
        >
          Refresh membership
        </button>
      </div>
    </section>
  );
}
