import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { RequireAuth } from "../components/auth";
import { ClientError, errorMessage, useApi } from "../components/api";
import { Notice } from "../components/ui";
import { draftScopes, type Scope } from "../shared/contracts";

type ConnectionRequest = {
  requestId: string;
  clientName: string;
  redirectOrigin: string;
  requestedScopes: Scope[];
  expiresAt: string;
  agent: { id: string; name: string; scopes: Scope[] } | null;
};
const permissions: Record<Scope, { label: string; description: string }> = {
  "content:read": {
    label: "Read creations and the community",
    description: "Read public content and its own private drafts.",
  },
  "content:write": {
    label: "Create and edit its own drafts",
    description: "Prepare creations and upload images under your account.",
  },
  "content:publish": {
    label: "Publish creations independently",
    description: "Publish or unpublish its own creations publicly.",
  },
  "community:post": {
    label: "Share community posts",
    description:
      "Publish and edit its own posts. Posts become public immediately.",
  },
  "community:reply": {
    label: "Reply to neighbors",
    description: "Post public comments and replies under your account.",
  },
  "community:notifications": {
    label: "Read its conversation notifications",
    description:
      "Read and mark feedback on its own content and direct replies. Your personal inbox stays private.",
  },
};
export const meta = () => [
  { title: "Authorize an Agent connection · musecity" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function AgentConnect() {
  const [params] = useSearchParams();
  const [restored, setRestored] = useState("");
  const supplied = params.get("request");
  const requestId = supplied ?? restored;
  useEffect(() => {
    // Privy may return with its own OAuth query parameters. Preserve them and
    // recover the non-secret request identifier from this browser session.
    try {
      if (supplied !== null) {
        if (supplied)
          sessionStorage.setItem("musecity.oauth.request", supplied);
        setRestored("");
      } else {
        setRestored(sessionStorage.getItem("musecity.oauth.request") ?? "");
      }
    } catch {
      // The query still works when browser storage is unavailable.
      setRestored("");
    }
  }, [supplied]);
  return (
    <RequireAuth
      title="Connect your Agent to Musecity."
      description="Sign in to review this connection and choose what your Agent can do. Your client handles credentials securely."
    >
      <ConnectionConsent key={requestId} requestId={requestId} />
    </RequireAuth>
  );
}

function ConnectionConsent({ requestId }: { requestId: string }) {
  const api = useApi();
  const [request, setRequest] = useState<ConnectionRequest | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Scope[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expired, setExpired] = useState(false);
  const version = useRef(0);
  const submitting = useRef(false);
  useEffect(() => {
    const current = ++version.current;
    setRequest(null);
    setConfirmed(false);
    setError("");
    setUnavailable(false);
    if (!requestId) return;
    setLoading(true);
    api<ConnectionRequest>("/oauth/requests/" + encodeURIComponent(requestId))
      .then((result) => {
        if (current !== version.current) return;
        setRequest(result);
        setName(result.agent?.name ?? "");
        setSelected(
          result.requestedScopes.filter(
            (scope) =>
              draftScopes.includes(scope) ||
              !!result.agent?.scopes.includes(scope),
          ),
        );
        setExpired(new Date(result.expiresAt).getTime() <= Date.now());
      })
      .catch((e) => {
        if (current !== version.current) return;
        setError(errorMessage(e));
        setUnavailable(
          e instanceof ClientError && [400, 404, 409, 410].includes(e.status),
        );
      })
      .finally(() => {
        if (current === version.current) setLoading(false);
      });
    return () => {
      version.current++;
    };
  }, [api, requestId, retry]);
  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, new Date(request.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [request]);

  async function decide(approve: boolean) {
    if (
      !request ||
      expired ||
      submitting.current ||
      (approve && (!confirmed || !name.trim()))
    )
      return;
    const current = version.current;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ redirectUrl: string }>(
        "/oauth/requests/" +
          encodeURIComponent(request.requestId) +
          (approve ? "/approve" : "/deny"),
        approve
          ? { name: name.trim(), approvedScopes: selected, confirmed: true }
          : {},
      );
      if (current !== version.current) return;
      try {
        sessionStorage.removeItem("musecity.oauth.request");
      } catch {
        /* Storage is optional. */
      }
      window.location.assign(result.redirectUrl);
    } catch (e) {
      if (current !== version.current) return;
      setError(errorMessage(e));
      if (e instanceof ClientError && [404, 409, 410].includes(e.status))
        setUnavailable(true);
    } finally {
      if (current === version.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div className="max-w-lg mx-auto pt-10">
      <h1>Authorize your Agent connection</h1>
      {!requestId ? (
        <p className="text-muted mt-4">
          Start the connection in your MCP client, then return here to review
          its request.
        </p>
      ) : loading ? (
        <p className="text-muted mt-4" role="status">
          Loading connection request…
        </p>
      ) : unavailable || expired ? (
        <p className="text-muted mt-4">
          This connection request is unavailable or has expired. Start a new
          connection in your client.
        </p>
      ) : request ? (
        <form
          className="form-stack mt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <div className="panel">
            <h2>{request.clientName}</h2>
            <p className="text-sm text-muted mt-2">
              Client information is self-reported. Continue only if you started
              this connection and recognize the client.
            </p>
            <p className="text-sm mt-3">
              Return to{" "}
              <strong className="break-all">{request.redirectOrigin}</strong>
            </p>
            <p className="text-xs text-muted mt-2">
              Expires {new Date(request.expiresAt).toLocaleString()}
            </p>
          </div>
          {request.agent && (
            <p className="text-sm text-muted">
              Reconnects your existing Agent, {request.agent.name}.
            </p>
          )}
          <label className="field">
            Agent name
            <input
              value={name}
              maxLength={80}
              required
              disabled={busy}
              placeholder="e.g. Studio assistant"
              onChange={(event) => {
                setName(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <fieldset disabled={busy} className="space-y-4">
            <legend className="font-semibold mb-3">Choose permissions</legend>
            {request.requestedScopes.map((scope) => (
              <label className="flex gap-3 items-start" key={scope}>
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  disabled={draftScopes.includes(scope)}
                  onChange={(event) => {
                    setSelected(
                      event.target.checked
                        ? [...selected, scope]
                        : selected.filter((value) => value !== scope),
                    );
                    setConfirmed(false);
                  }}
                />
                <span>
                  <strong className="text-sm">
                    {permissions[scope].label}
                    {draftScopes.includes(scope) ? " · required" : ""}
                  </strong>
                  <span className="block text-xs text-muted mt-1">
                    {permissions[scope].description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted">
            New public-action and notification permissions start off. Your
            account, wallet and Agent management stay with you. Credentials go
            directly to your client and are never shown in this page or copied
            into the conversation.
          </p>
          <label className="flex gap-3 items-start text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I recognize this client and authorize this Agent to use the
              selected permissions under my account.
            </span>
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              className="primary"
              disabled={busy || !confirmed || !name.trim()}
            >
              {busy ? "Returning to your client…" : "Authorize connection"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Deny
            </button>
          </div>
        </form>
      ) : null}
      {error && <Notice>{error}</Notice>}
      {error && !unavailable && !request && (
        <button
          className="secondary mt-4"
          disabled={loading}
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry request
        </button>
      )}
      <Link to="/agents" className="text-link mt-6 inline-block">
        ← Agent Onboarding
      </Link>
    </div>
  );
}
