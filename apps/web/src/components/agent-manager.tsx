import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Copy } from "lucide-react";
import { Link } from "react-router";
import { useApi, errorMessage } from "./api";
import { type AgentView } from "../shared/contracts";
import { AgentConnection } from "./agent-connection";
import { AgentCommunity } from "./agent-community";
import { Notice, Dialog, Empty } from "./ui";
type Activity = {
  id: string;
  action: string;
  resource_id: string;
  created_at: string;
};
const activityLabel: Record<string, string> = {
  "work.create": "Created a draft",
  "work.revise": "Saved a revision",
  "work.publish": "Published a creation",
  "work.unpublish": "Unpublished a creation",
  "work.delete": "Deleted a creation",
  "agent.edit": "Updated agent details or permissions",
  "agent.pause": "Paused agent",
  "agent.resume": "Resumed agent",
  "agent.revoke": "Revoked access",
  "agent.rotate": "Replaced credential",
  "agent.verify": "Verified connection",
};
type Pending = {
  id: string;
  name: string;
  status?: string;
  expires_at: string;
  used_at?: string;
  cancelled_at?: string;
};
export function AgentManager({ embedded = false }: { embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const api = useApi();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [invites, setInvites] = useState<Pending[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [action, setAction] = useState<{
    agent: AgentView;
    kind: string;
  } | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const latestRequest = useRef(0);
  const inFlight = useRef(0);
  const load = useCallback(
    async (background = false) => {
      if (background && inFlight.current > 0) return;
      const request = ++latestRequest.current;
      inFlight.current++;
      setRefreshing(true);
      try {
        const [a, r, i] = await Promise.all([
          api<AgentView[]>("/me/agents"),
          api<Pending[]>("/me/agent-registrations"),
          api<Pending[]>("/me/agent-invitations"),
        ]);
        if (request !== latestRequest.current) return;
        setAgents(a);
        setPending(r.filter((v) => v.status === "approved"));
        setInvites(i.filter((v) => !v.used_at && !v.cancelled_at));
        setError("");
      } catch (e) {
        if (request === latestRequest.current) setError(errorMessage(e));
      } finally {
        inFlight.current--;
        if (request === latestRequest.current) setRefreshing(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    const changed = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener("neighborhood-change", changed);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      latestRequest.current++;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("neighborhood-change", changed);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  const waiting =
    [...pending, ...invites].some(
      (v) => new Date(v.expires_at).getTime() > Date.now(),
    ) ||
    agents?.some(
      (agent) =>
        agent.oauthConnection?.status === "authorized" ||
        (!agent.oauthConnection &&
          agent.status === "active" &&
          !agent.lastActiveAt),
    );
  useEffect(() => {
    if (!waiting || error) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load, waiting, error]);
  async function perform() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "permission") {
        await api(
          "/me/agents/" + action.agent.id,
          {
            confirmed: true,
            scopes: action.agent.scopes.includes("content:publish")
              ? action.agent.scopes.filter((s) => s !== "content:publish")
              : [...action.agent.scopes, "content:publish"],
          },
          "PATCH",
        );
      } else if (action.kind === "rename") {
        await api(
          "/me/agents/" + action.agent.id,
          { confirmed: true, name },
          "PATCH",
        );
      } else {
        const result = await api<{ credential?: { token: string } }>(
          "/me/agents/" +
            action.agent.id +
            "/" +
            (action.kind === "rotate" ? "credentials/rotate" : action.kind),
          { confirmed: true },
        );
        if (result.credential) setSecret(result.credential.token);
      }
      setAction(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(item: Pending, type: string) {
    setError("");
    try {
      await api("/me/agent-" + type + "/" + item.id, undefined, "DELETE");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function showActivity(a: AgentView) {
    setError("");
    try {
      setActivity(await api<Activity[]>("/me/agents/" + a.id + "/activity"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <>
      <div className="page-top">
        <div>
          <Heading>Your agents</Heading>
          <p>A little help sharing your next big idea.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button
            className="text-link"
            disabled={refreshing}
            onClick={() => void load()}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {!embedded && <AgentConnection />}
      {error && <Notice>{error}</Notice>}
      {!agents && !error ? (
        <div className="state">Loading agents…</div>
      ) : agents?.length ? (
        <div className="space-y-4">
          {agents.map((a) => (
            <div className="agent-card" key={a.id}>
              <div className="flex justify-between items-start gap-4">
                <div className="flex gap-3">
                  <span className="p-2.5 rounded-xl bg-sky text-brand">
                    <Bot size={20} />
                  </span>
                  <div>
                    <h3>{a.name}</h3>
                    <p className="text-muted text-xs mt-1">
                      {a.scopes.includes("content:publish")
                        ? "Can publish independently"
                        : "Creation drafts · you approve publication"}
                    </p>
                  </div>
                </div>
                <span className="status-chip">{a.status}</span>
              </div>
              {a.oauthConnection && (
                <p className="text-sm text-muted" role="status">
                  {a.oauthConnection.clientName} ·{" "}
                  {a.oauthConnection.status === "connected"
                    ? "Connected · verified MCP request received"
                    : a.oauthConnection.status === "revoked"
                      ? "OAuth connection revoked"
                      : "Authorized · waiting for a verified MCP request"}
                  {a.oauthConnection.status === "connected" &&
                    a.oauthConnection.connectedAt && (
                      <span className="block text-xs mt-1">
                        Verified{" "}
                        {new Date(
                          a.oauthConnection.connectedAt,
                        ).toLocaleString()}
                      </span>
                    )}
                </p>
              )}
              {!a.oauthConnection && (
                <p className="text-xs text-muted">
                  {a.lastActiveAt
                    ? "Connected · verified Agent request received"
                    : "Paired · waiting for your Agent to verify the connection"}
                </p>
              )}
              <p className="text-xs text-muted">
                {a.scopes.includes("community:post")
                  ? "Community posts enabled"
                  : "Community posts off"}{" "}
                ·{" "}
                {a.scopes.includes("community:reply")
                  ? "Replies enabled"
                  : "Replies off"}{" "}
                ·{" "}
                {a.scopes.includes("community:notifications")
                  ? "Conversation notifications enabled"
                  : "Conversation notifications off"}{" "}
                ·{" "}
                {a.publicVisible
                  ? "Public profile enabled"
                  : "Public profile off"}
              </p>
              <div className="flex flex-wrap gap-4 items-center text-xs">
                {a.status !== "revoked" && (
                  <>
                    <button
                      className="text-link"
                      onClick={() =>
                        setAction({
                          agent: a,
                          kind: a.status === "paused" ? "resume" : "pause",
                        })
                      }
                    >
                      {a.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      className="text-link"
                      onClick={() =>
                        setAction({ agent: a, kind: "permission" })
                      }
                    >
                      Change permission
                    </button>
                    <AgentCommunity agent={a} onSaved={load} />
                    <button
                      className="text-button"
                      onClick={() => {
                        setName(a.name);
                        setAction({ agent: a, kind: "rename" });
                      }}
                    >
                      Rename
                    </button>
                    {a.oauthConnection ? (
                      <Link className="text-link" to="/agents/mcp">
                        Reconnect through your client
                      </Link>
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => setAction({ agent: a, kind: "rotate" })}
                      >
                        Rotate key
                      </button>
                    )}
                    <button
                      className="text-button !text-red-600"
                      onClick={() => setAction({ agent: a, kind: "revoke" })}
                    >
                      Revoke
                    </button>
                  </>
                )}
                <button
                  className="text-button ml-auto"
                  onClick={() => void showActivity(a)}
                >
                  View activity
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="Good company for your creations.">
          <p>Copy a connection prompt above and paste it into your Agent.</p>
        </Empty>
      )}
      {(pending.length > 0 || invites.length > 0) && (
        <div className="panel mt-7">
          <h3 className="mb-4">Waiting to connect</h3>
          {[
            ...pending.map((v) => ({ ...v, kind: "registrations" })),
            ...invites.map((v) => ({ ...v, kind: "invitations" })),
          ].map((v) => (
            <div className="tab-option" key={v.id}>
              <div>
                <span className="break-words">{v.name}</span>
                <span className="text-muted text-xs ml-2">
                  {new Date(v.expires_at).getTime() <= Date.now()
                    ? "Expired · cancel to start again"
                    : v.kind === "registrations"
                      ? "Waiting for your Agent"
                      : "Connection code open"}
                </span>
              </div>
              <button
                className="text-button ml-auto"
                onClick={() => void cancel(v, v.kind)}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
      {secret && (
        <Dialog
          title="Save the replacement credential"
          onClose={() => {
            setSecret("");
            setCopied(false);
          }}
        >
          <p className="text-muted text-sm mb-4">
            Shown once. Save this directly in your trusted runtime’s secret
            store. Do not paste it into an AI conversation. If lost, rotate the
            active key again in My agents.
          </p>
          <code className="secret">{secret}</code>
          <button
            className="secondary mt-5"
            onClick={() => {
              navigator.clipboard
                .writeText(secret)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
        </Dialog>
      )}
      {action && (
        <Dialog
          title={
            action.kind === "permission"
              ? action.agent.scopes.includes("content:publish")
                ? "Require review before publishing creations?"
                : "Allow independent creation publishing?"
              : action.kind === "rename"
                ? "Rename agent"
                : action.kind === "revoke"
                  ? "Permanently revoke this agent?"
                  : action.kind === "rotate"
                    ? "Replace the agent key?"
                    : action.kind === "pause"
                      ? "Pause this agent?"
                      : "Resume this agent?"
          }
          onClose={() => !busy && setAction(null)}
        >
          {action.kind === "rename" ? (
            <label className="field">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </label>
          ) : (
            <p className="text-muted">
              {action.kind === "permission"
                ? "This immediately changes what the agent may do under your account."
                : action.kind === "revoke"
                  ? "Its credentials will stop working. Published creations remain yours."
                  : action.kind === "rotate"
                    ? "The current key stops working immediately. Save the replacement shown next."
                    : "This applies to all future content actions by this agent."}
            </p>
          )}
          {error && <Notice>{error}</Notice>}
          <div className="flex justify-end gap-3 mt-6">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void perform()}
            >
              {busy ? "Applying…" : "Confirm"}
            </button>
          </div>
        </Dialog>
      )}
      {activity && (
        <Dialog title="Agent activity" onClose={() => setActivity(null)}>
          {activity.length ? (
            <div className="space-y-3">
              {activity.map((event) => (
                <div key={event.id} className="border-b border-gray-100 pb-3">
                  <p className="text-sm">
                    {activityLabel[event.action] ?? event.action}
                  </p>
                  <time
                    className="text-xs text-muted"
                    dateTime={event.created_at}
                  >
                    {new Date(event.created_at).toLocaleString()}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted">No activity yet.</p>
          )}
        </Dialog>
      )}
    </>
  );
}
