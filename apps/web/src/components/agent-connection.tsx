import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Link } from "react-router";
import { useApi, errorMessage } from "./api";
import { Notice } from "./ui";
import { agentConnectionPrompt } from "../shared/agent-connection";
import type {
  AgentConnectionCreated,
  AgentConnectionStatus,
} from "../shared/contracts";

export function AgentConnection({
  onDirty,
  onBusy,
  onConnected,
}: {
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
  onConnected?: () => Promise<void>;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [connection, setConnection] = useState<AgentConnectionStatus | null>(
    null,
  );
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const current = useRef<AgentConnectionStatus | null>(null);
  const statusRequest = useRef(0);
  const notified = useRef("");
  const recover = useCallback(async () => {
    const records = await api<{ id: string; status: string }[]>(
      "/me/agent-registrations",
    );
    const pending = records.find((record) => record.status === "approved");
    if (pending || current.current) {
      const result = await api<AgentConnectionStatus>(
        "/me/agent-connections/" +
          (pending?.id ?? current.current!.connectionId),
      );
      current.current = result;
      setConnection(result);
    }
    setLoading(false);
  }, [api]);
  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    const record = current.current;
    if (!record) {
      await recover();
      return;
    }
    const result = await api<AgentConnectionStatus>(
      "/me/agent-connections/" + record.connectionId,
    );
    if (
      request !== statusRequest.current ||
      current.current?.connectionId !== record.connectionId
    )
      return;
    current.current = result;
    setConnection(result);
    if (
      ["connected", "paused", "revoked", "expired", "cancelled"].includes(
        result.status,
      )
    ) {
      setPrompt("");
      setCopyError("");
      onDirty?.(false);
    }
    if (
      result.status === "connected" &&
      notified.current !== result.connectionId
    ) {
      notified.current = result.connectionId;
      await onConnected?.();
    }
  }, [api, onDirty, onConnected, recover]);
  useEffect(() => {
    let active = true;
    void api<{ id: string; status: string }[]>("/me/agent-registrations")
      .then(async (records) => {
        const pending = records.find((record) => record.status === "approved");
        if (pending) {
          const result = await api<AgentConnectionStatus>(
            "/me/agent-connections/" + pending.id,
          );
          if (active) {
            current.current = result;
            setConnection(result);
            setName(result.name);
          }
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const waiting =
    !!connection &&
    ["waiting", "awaiting_verification"].includes(connection.status);
  useEffect(() => {
    if (!waiting || error || busy) return;
    const check = () => {
      if (document.visibilityState === "visible")
        void refresh().catch((e) => setError(errorMessage(e)));
    };
    const timer = window.setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [waiting, error, busy, refresh]);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError("");
      onDirty?.(false);
    } catch {
      setCopied(false);
      setCopyError(
        "Copy failed. Select the connection prompt below and copy it manually.",
      );
    }
  }
  async function generate() {
    if (busy || loading) return;
    setBusy(true);
    statusRequest.current++;
    onBusy?.(true);
    setError("");
    try {
      if (
        current.current &&
        ["waiting", "expired"].includes(current.current.status)
      ) {
        await api(
          "/me/agent-registrations/" + current.current.connectionId,
          undefined,
          "DELETE",
        );
      }
      const result = await api<AgentConnectionCreated>(
        "/me/agent-connections",
        { name: name.trim() || "My Agent" },
      );
      const record: AgentConnectionStatus = {
        connectionId: result.connectionId,
        expiresAt: result.expiresAt,
        name: name.trim() || "My Agent",
        status: "waiting",
        agentId: null,
      };
      current.current = record;
      setConnection(record);
      const text = agentConnectionPrompt(location.origin, result.otp);
      setPrompt(text);
      setCopied(false);
      onDirty?.(true);
      await copy(text);
    } catch (e) {
      setError(errorMessage(e));
      setPrompt("");
      // Secret issuance is not replayable; inspect pending state before another attempt.
      try {
        await recover();
      } catch {
        setLoading(true);
      }
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <div className="panel agent-connection">
      <p className="text-muted mb-4">
        Generate a connection prompt, then paste it into the AI Agent you
        already use.
      </p>
      {!waiting && connection?.status !== "connected" && (
        <label className="field mb-4">
          Agent name <span className="text-muted text-xs">(optional)</span>
          <input
            maxLength={80}
            value={name}
            placeholder="My Agent"
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              onDirty?.(!!e.target.value);
            }}
          />
        </label>
      )}
      {connection && (
        <p className="font-semibold mb-3" role="status">
          {connection.status === "connected"
            ? `${connection.name} is connected.`
            : connection.status === "awaiting_verification"
              ? "Paired — waiting for your Agent to verify the connection."
              : connection.status === "waiting"
                ? "Waiting for your Agent to connect."
                : connection.status === "expired"
                  ? "The connection code has expired."
                  : connection.status === "paused"
                    ? "This Agent is paused."
                    : connection.status === "revoked"
                      ? "This Agent’s access has ended."
                      : "This connection was cancelled."}
        </p>
      )}
      {prompt && (
        <>
          <textarea
            className="secret w-full"
            rows={8}
            readOnly
            spellCheck={false}
            aria-label="Agent connection prompt"
            value={prompt}
          />
          <button
            type="button"
            className="secondary mt-3"
            disabled={busy}
            onClick={() => void copy(prompt)}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied
              ? "Copied — paste into your Agent"
              : "Copy connection prompt"}
          </button>
        </>
      )}
      {connection?.status === "waiting" && (
        <p className="text-xs text-muted mt-3">
          Valid until {new Date(connection.expiresAt).toLocaleTimeString()}. The
          code is shown once and can be redeemed once.
          {!prompt && " Generate a new prompt if you no longer have it."}
        </p>
      )}
      {!prompt &&
        connection?.status !== "connected" &&
        connection?.status !== "awaiting_verification" && (
          <button
            type="button"
            className="primary"
            disabled={busy || loading}
            onClick={() => void generate()}
          >
            <Copy size={16} />
            {busy
              ? "Generating…"
              : loading
                ? "Loading connection…"
                : connection
                  ? "Generate and copy a new prompt"
                  : "Generate and copy connection prompt"}
          </button>
        )}
      {connection?.status === "connected" && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            current.current = null;
            setConnection(null);
            setName("");
            setCopied(false);
            setCopyError("");
          }}
        >
          Connect another Agent
        </button>
      )}
      <p className="text-sm text-muted mt-4">
        Generating a code authorizes this Agent to create and publish creations,
        post and reply under your account. You can pause or revoke access in{" "}
        <Link className="text-link" to="/me/agents">
          My agents
        </Link>
        .
      </p>
      {connection?.status === "awaiting_verification" && (
        <p className="text-xs text-muted mt-3">
          Ask your Agent to finish verification using its saved credential. If
          the credential response was lost, replace its key in My agents.
        </p>
      )}
      {(error || copyError) && <Notice>{error || copyError}</Notice>}
      {(waiting || error) && (
        <button
          type="button"
          className="text-link mt-3"
          disabled={busy}
          onClick={async () => {
            setError("");
            try {
              await refresh();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Refresh connection
        </button>
      )}
    </div>
  );
}
