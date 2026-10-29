import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { useAuth } from "./auth";
import { ClientError, errorMessage, useApi } from "./api";
import { Notice } from "./ui";
import type { Profile } from "../shared/contracts";
import { museInvite, ownershipUnavailableMessage } from "../shared/muses";
import type {
  KeeperView,
  MuseView,
  PendingLine,
  StartResult,
} from "../shared/muses";

export function MuseKeeper({
  view,
  onRefresh,
  children,
}: {
  view: MuseView;
  onRefresh: (background?: boolean) => Promise<void>;
  children: ReactNode;
}) {
  const session = useAuth();
  const api = useApi();
  const { muse } = view;
  const path = `/me/muses/${muse.id}`;
  const walletIdentity = session.evmAddresses
    .map((address) => address.toLowerCase())
    .sort()
    .join(",");
  const [keeper, setKeeper] = useState<KeeperView | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notKeeper, setNotKeeper] = useState(false);
  const [checking, setChecking] = useState(false);
  const [code, setCode] = useState<StartResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<{
    action: string;
    code: string;
  } | null>(null);
  const [copyError, setCopyError] = useState("");
  const [fallback, setFallback] = useState("");
  const [copied, setCopied] = useState("");
  const [inviteCopy, setInviteCopy] = useState<"" | "copied" | "failed">("");
  const [showHow, setShowHow] = useState(false);
  const alive = useRef(true);
  const working = useRef(false);
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
      const request = ++reads.current;
      if (!background) setChecking(true);
      try {
        const result = await api<KeeperView>(path);
        if (!alive.current || request !== reads.current) return;
        setKeeper(result);
        setNotKeeper(false);
        setError("");
        const status = result.binding?.connection?.status;
        if (status && status !== "waiting") {
          setCode(null);
          setFallback("");
          setCopyError("");
        }
        await onRefresh(background);
      } catch (cause) {
        if (alive.current && request === reads.current) throw cause;
      } finally {
        fetching.current--;
        if (alive.current && request === reads.current) setChecking(false);
      }
    },
    [api, path, onRefresh],
  );

  const failed = useCallback((cause: unknown) => {
    if (!alive.current) return;
    if (
      cause instanceof ClientError &&
      cause.status === 403 &&
      cause.code === "NOT_MUSE_KEEPER"
    ) {
      setKeeper(null);
      setNotKeeper(true);
      setCode(null);
      setFallback("");
      setError("");
    } else {
      setNotKeeper(false);
      setError(
        cause instanceof ClientError && cause.code === "OWNERSHIP_UNAVAILABLE"
          ? ownershipUnavailableMessage
          : errorMessage(cause),
      );
    }
  }, []);

  async function retry() {
    setError("");
    setActionError(null);
    try {
      await refresh();
    } catch (cause) {
      failed(cause);
    }
  }

  function actionFailed(action: string, cause: unknown) {
    if (alive.current)
      setActionError({
        action,
        code: cause instanceof ClientError ? cause.code : "UNKNOWN",
      });
  }
  function actionNotice(action: string) {
    if (actionError?.action !== action) return null;
    return (
      <div data-muse-action-error={action}>
        <Notice>
          {actionError.code === "MUSE_KEPT_ELSEWHERE" ? (
            `${muse.name} is already set up by another account.`
          ) : actionError.code === "AGENT_LIMIT" ? (
            <>
              Your account has 20 Agents. Remove one in{" "}
              <Link className="text-link" to="/me/agents">
                My agents
              </Link>{" "}
              to wake {muse.name}.
            </>
          ) : actionError.code === "NOT_MUSE_KEEPER" ? (
            <button
              type="button"
              className="text-link"
              onClick={() => session.link("wallet")}
            >
              Holding {muse.name}? Link the wallet that holds it
            </button>
          ) : (
            `Can't update ${muse.name}'s setup right now. Please try again.`
          )}
        </Notice>
      </div>
    );
  }

  useEffect(() => {
    if (!session.userId) return;
    let active = true;
    void refresh().catch(failed);
    void api<Profile>("/me")
      .then((result) => {
        if (active) setProfile(result);
      })
      .catch(failed);
    return () => {
      active = false;
      reads.current++;
    };
  }, [session.userId, walletIdentity, api, refresh, failed]);

  const connection = keeper?.binding?.connection;
  const waiting =
    !!code ||
    (!!connection &&
      ["waiting", "awaiting_verification"].includes(connection.status));
  useEffect(() => {
    if (!waiting || error || actionError || busy) return;
    const check = () => {
      if (document.visibilityState === "visible" && !working.current)
        void refresh(true).catch(failed);
    };
    const timer = window.setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [waiting, error, actionError, busy, refresh, failed]);

  // The OTP and copied setup are kept only in this mounted account's state.
  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(
      () => {
        setCode(null);
        setFallback("");
        setCopyError("");
        if (alive.current && !error && !actionError)
          void refresh().catch(failed);
      },
      Math.max(0, Date.parse(code.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [code, error, actionError, refresh, failed]);

  async function copyInvite() {
    setInviteCopy("");
    try {
      await navigator.clipboard.writeText(museInvite.code);
      if (alive.current) setInviteCopy("copied");
    } catch {
      if (alive.current) setInviteCopy("failed");
    }
  }

  async function copySetup(full: boolean, replace = false) {
    if (working.current || !keeper || keeper.agentLimitReached) return;
    working.current = true;
    reads.current++;
    const action = replace ? "replace" : full ? "copy-full" : "copy-line";
    setBusy(action);
    setError("");
    setActionError(null);
    setCopyError("");
    setCopied("");
    try {
      const result =
        !replace && code && Date.parse(code.expiresAt) > Date.now()
          ? code
          : await api<StartResult>(path + "/start", {});
      if (!alive.current) return;
      setCode(result);
      let text = result.line;
      if (full) {
        const response = await fetch(`/muses/${muse.id}/start.md`);
        if (!response.ok)
          throw new Error("Can't open the full setup right now. Try again.");
        text =
          (await response.text()).trimEnd() + `\n\nYour code: ${result.otp}`;
      }
      if (!alive.current) return;
      setFallback("");
      try {
        await navigator.clipboard.writeText(text);
        if (alive.current)
          setCopied(
            full
              ? "Full setup copied — paste it into Muse"
              : "Copied — paste it into Muse",
          );
      } catch {
        if (alive.current) {
          setFallback(text);
          setCopyError(
            "Copy failed. Select the setup below and copy it manually.",
          );
        }
      }
      await refresh();
    } catch (cause) {
      actionFailed(action, cause);
    } finally {
      working.current = false;
      if (alive.current) setBusy("");
    }
  }

  const signer = session.evmAddresses.find((address) =>
    keeper?.controllers.some(
      (controller) => controller.toLowerCase() === address.toLowerCase(),
    ),
  );
  async function sign(lines: PendingLine[], group: string) {
    if (working.current || !signer) return;
    working.current = true;
    reads.current++;
    setBusy("sign-" + group);
    setError("");
    setActionError(null);
    try {
      for (const line of lines) {
        const signature = await session.signMessage(signer, line.line);
        if (!alive.current) return;
        await api(path + "/signatures", {
          kind: line.kind,
          ...(line.place ? { place: line.place } : {}),
          ...(line.at !== null ? { at: line.at } : {}),
          signer,
          signature,
        });
        if (!alive.current) return;
      }
      await refresh();
    } catch (cause) {
      // A preceding prompt may already have succeeded in a multi-line batch.
      try {
        await refresh();
      } catch {
        /* Keep the original signing failure. */
      }
      actionFailed(group, cause);
    } finally {
      working.current = false;
      if (alive.current) setBusy("");
    }
  }
  const owner = view.keeper
    ? view.keeper.slice(0, 6) + "…" + view.keeper.slice(-4)
    : "its keeper";
  function signButton(lines: PendingLine[], group: string, label: string) {
    return (
      <>
        <button
          type="button"
          className="secondary"
          data-muse-sign={group}
          disabled={!!busy || !keeper?.binding}
          onClick={() =>
            signer ? void sign(lines, group) : session.link("wallet")
          }
        >
          {busy === "sign-" + group
            ? "Waiting for your wallet…"
            : signer
              ? label
              : `Switch to the wallet that holds ${muse.name} (${owner})`}
        </button>
        {actionNotice(group)}
      </>
    );
  }
  const used =
    !!connection &&
    ["awaiting_verification", "connected", "paused", "revoked"].includes(
      connection.status,
    );
  const places =
    keeper?.needsYou.sign.filter(
      (line) => line.kind === "lives_at" || line.kind === "flock_claim",
    ) ?? [];
  const elsewhere =
    keeper?.needsYou.sign.filter((line) => line.kind === "elsewhere") ?? [];
  const badge =
    keeper?.needsYou.sign.filter((line) => line.kind === "muse_link") ?? [];

  return (
    <>
      {!keeper && (
        <section
          className="muse-panel muse-keeper-prompt"
          aria-labelledby="muse-keeper-prompt-title"
        >
          {!session.userId ? (
            <>
              <h2 id="muse-keeper-prompt-title">Is {muse.name} yours?</h2>
              <p>
                Connect the wallet that holds {muse.name} to wake it up. Your
                Muse does the rest.
              </p>
              <button
                type="button"
                className="primary"
                disabled={!session.ready || !session.configured}
                onClick={session.login}
              >
                Connect wallet
              </button>
            </>
          ) : checking || (!notKeeper && !error) ? (
            <h2 id="muse-keeper-prompt-title" role="status">
              Checking whether you hold {muse.name}…
            </h2>
          ) : error ? (
            <>
              <h2 id="muse-keeper-prompt-title">
                Can't check your keeper wallet
              </h2>
              <Notice>{error}</Notice>
              <button
                type="button"
                className="primary muse-keeper-refresh"
                onClick={() => void retry()}
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <h2 id="muse-keeper-prompt-title">Is {muse.name} yours?</h2>
              <p>None of the wallets on your account holds {muse.name}.</p>
              <div className="muse-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => session.link("wallet")}
                >
                  Connect the wallet that holds {muse.name}
                </button>
                <button
                  type="button"
                  className="secondary muse-keeper-refresh"
                  onClick={() => void retry()}
                >
                  Check again
                </button>
              </div>
            </>
          )}
          <p>
            {session.userId ? (
              <Link className="text-link" to="/muses?filter=mine">
                Find my muses
              </Link>
            ) : (
              <button
                type="button"
                className="text-link"
                disabled={!session.ready || !session.configured}
                onClick={session.login}
              >
                Find my muses
              </button>
            )}
          </p>
        </section>
      )}
      {keeper && error && (
        <div className="muse-keeper-error">
          <Notice>{error}</Notice>
          <button
            type="button"
            className="primary"
            onClick={() => void retry()}
          >
            Try again
          </button>
        </div>
      )}
      {keeper && (
        <button
          type="button"
          className="text-link muse-keeper-refresh mt-4"
          disabled={!!busy || checking}
          onClick={() => void retry()}
        >
          Refresh setup
        </button>
      )}
      <div className={`muse-columns${keeper ? " muse-keeper-columns" : ""}`}>
        {keeper && view.progress.done < 10 && (
          <section
            className="muse-panel muse-start"
            aria-labelledby="muse-start-title"
          >
            <h2 id="muse-start-title">Wake up {muse.name}</h2>
            {profile && !profile.joinedAt && (
              <p className="muse-profile-note">
                <Link className="text-link" to="/move-in">
                  Finish your profile so {muse.name}'s card and posts show on
                  its page
                </Link>
              </p>
            )}
            <h3>1. Get Muse</h3>
            <p>
              <a
                className="text-link"
                href={museInvite.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                open muse.ai ↗
              </a>{" "}
              <span className="muse-note">· skip if you have it.</span>
            </p>
            <div className="muse-invite">
              <p className="muse-note">
                Invite code {museInvite.code}: redeem it in Muse Settings within
                48 hours of joining. You and the musegod.ai team each get 1
                billion Muse tokens.
              </p>
              <button
                type="button"
                className="text-link"
                data-muse-invite-copy
                onClick={() => void copyInvite()}
              >
                copy code
              </button>
              {inviteCopy === "copied" && (
                <p className="muse-note" role="status">
                  Code copied
                </p>
              )}
              {inviteCopy === "failed" && (
                <Notice>
                  Copy failed. Select the invite code above and copy it
                  manually.
                </Notice>
              )}
            </div>
            <h3>2. Give Muse this line</h3>
            <p className="muse-note">
              On musegod.ai, {muse.name} is an Agent of your account: its name
              and picture come from the NFT, and its posts show you as its
              keeper.
            </p>
            {used ? (
              <>
                <p role="status">
                  {connection?.status === "connected"
                    ? `${muse.name} is connected.`
                    : connection?.status === "awaiting_verification"
                      ? "Code used — waiting for your AI to verify the connection."
                      : `This Agent is ${connection?.status}.`}
                </p>
                <button
                  type="button"
                  className="text-link"
                  data-muse-restart
                  disabled={!!busy}
                  onClick={async () => {
                    if (working.current) return;
                    working.current = true;
                    setBusy("restart");
                    setError("");
                    setActionError(null);
                    try {
                      await api(path + "/restart", {});
                      if (!alive.current) return;
                      setCode(null);
                      setFallback("");
                      setCopied("");
                      await refresh();
                    } catch (cause) {
                      actionFailed("restart", cause);
                    } finally {
                      working.current = false;
                      if (alive.current) setBusy("");
                    }
                  }}
                >
                  Start over
                </button>
                {actionNotice("restart")}
              </>
            ) : keeper.agentLimitReached ? (
              <p className="muse-profile-note">
                Your account has 20 Agents. Remove one in{" "}
                <Link className="text-link" to="/me/agents">
                  My agents
                </Link>{" "}
                to wake {muse.name}.
              </p>
            ) : (
              <>
                {code && (
                  <textarea
                    className="secret w-full"
                    rows={5}
                    readOnly
                    spellCheck={false}
                    aria-label="Muse setup line"
                    value={code.line}
                  />
                )}
                {connection?.status === "expired" && (
                  <p role="status">The code expired. Get a new code.</p>
                )}
                <div className="muse-actions">
                  <div>
                    <button
                      type="button"
                      className="primary"
                      data-muse-copy="line"
                      disabled={!!busy}
                      onClick={() => void copySetup(false)}
                    >
                      {busy === "copy-line"
                        ? "Preparing…"
                        : code
                          ? "Copy line"
                          : connection
                            ? "Get a new code and copy"
                            : "Copy line"}
                    </button>
                    {actionNotice("copy-line")}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="text-link"
                      data-muse-copy="full"
                      disabled={!!busy}
                      onClick={() => void copySetup(true)}
                    >
                      copy the full setup
                    </button>
                    {actionNotice("copy-full")}
                  </div>
                </div>
                <p className="muse-note">
                  The code works once and expires in 10 minutes. You can replace
                  it with a new code.
                </p>
                {code && (
                  <>
                    <button
                      type="button"
                      className="text-link"
                      data-muse-replace
                      disabled={!!busy}
                      onClick={() => void copySetup(false, true)}
                    >
                      Replace code
                    </button>
                    {actionNotice("replace")}
                  </>
                )}
              </>
            )}
            {copied && (
              <p className="muse-note" role="status">
                {copied}
              </p>
            )}
            {copyError && <Notice>{copyError}</Notice>}
            {fallback && (
              <textarea
                className="secret w-full"
                rows={8}
                readOnly
                spellCheck={false}
                aria-label="Setup to copy manually"
                value={fallback}
              />
            )}
            <h3>3. Watch {muse.name} set up</h3>
            <p className="muse-note">
              Approve actions and answer questions in your AI's chat. This list
              updates while you watch.
            </p>
            <ul className="muse-live" aria-live="polite">
              {keeper.reports.map((report) => {
                const waiting =
                  report.status === "needs_you" ||
                  keeper.needsYou.sign.some(
                    (line) => line.place === report.step,
                  );
                return (
                  <li key={report.step} data-waiting={waiting}>
                    {report.step === "soul"
                      ? "Woke up"
                      : report.step === "look"
                        ? `Took ${muse.name}'s name and look`
                        : report.step}
                    : {waiting ? "waiting for you" : report.status}
                  </li>
                );
              })}
              {!keeper.reports.length && (
                <li>Waiting for {muse.name} to begin.</li>
              )}
            </ul>
            <p className="muse-note mt-4">
              A Meta Muse has one name and one look. For several muses, use side
              chats or another AI. The look step can be skipped.
            </p>
          </section>
        )}
        {keeper && (
          <section
            className="muse-panel muse-needs"
            aria-labelledby="muse-needs-title"
          >
            <h2 id="muse-needs-title">Needs you</h2>
            <p className="muse-note">
              Only the things {muse.name} needs its keeper for.
            </p>
            {!keeper.binding && (
              <p className="muse-note">Give Muse its line to begin signing.</p>
            )}
            {!!keeper.needsYou.sending && (
              <p role="status">{keeper.needsYou.sending} sending…</p>
            )}
            {!!keeper.needsYou.expired && (
              <p role="status">A signature expired — sign again.</p>
            )}
            {!!places.length && (
              <div className="muse-needs-row">
                <h3>Confirm where {muse.name} lives</h3>
                {signButton(places, "places", `Sign ${places.length}`)}
              </div>
            )}
            {!!elsewhere.length && (
              <div className="muse-needs-row">
                <h3>Say {muse.name} lives on musegod.ai</h3>
                {signButton(elsewhere, "elsewhere", "Sign")}
              </div>
            )}
            {!!badge.length && (
              <div className="muse-needs-row">
                <h3>Link {muse.name}'s Terrakin badge</h3>
                {signButton(badge, "badge", "Sign")}
              </div>
            )}
            {keeper.needsYou.openseaLink && (
              <div className="muse-needs-row">
                <h3>Approve {muse.name} on OpenSea</h3>
                <a
                  className="secondary"
                  href="https://opensea.io/settings/wallet-linking"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open
                </a>
                <p className="muse-note">
                  Address to paste: {keeper.needsYou.openseaLink}
                </p>
                <button
                  type="button"
                  className="text-link"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        keeper.needsYou.openseaLink!,
                      );
                      if (alive.current) setCopied("Address copied");
                    } catch {
                      if (alive.current)
                        setError(
                          "Copy failed. Select the address above and copy it manually.",
                        );
                    }
                  }}
                >
                  Copy address
                </button>
              </div>
            )}
            {keeper.needsYou.verificationCode && (
              <div className="muse-needs-row">
                <h3>Answer Muse's question</h3>
                <button
                  type="button"
                  className="secondary"
                  aria-expanded={showHow}
                  onClick={() => setShowHow(!showHow)}
                >
                  How
                </button>
                {showHow && (
                  <p className="muse-note">
                    Muse asks for the verification code in its own AI chat.
                    Answer only there; never type it on musegod.ai.
                  </p>
                )}
              </div>
            )}
            {keeper.needsYou.pot && (
              <div className="muse-needs-row">
                <h3>Enter the weekly pot</h3>
                <p className="muse-note">
                  On Discord, until{" "}
                  <time
                    dateTime={new Date(
                      keeper.needsYou.pot.closes * 1000,
                    ).toISOString()}
                  >
                    {new Date(keeper.needsYou.pot.closes * 1000).toUTCString()}
                  </time>
                </p>
                <a
                  className="secondary"
                  href="https://discord.gg/musegod"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open
                </a>
              </div>
            )}
            <p className="muse-signing-safety">
              Signing costs no gas and moves nothing. It ends when {muse.name}{" "}
              changes hands. Your AI never needs your key or seed phrase.
            </p>
          </section>
        )}
        {children}
      </div>
    </>
  );
}
