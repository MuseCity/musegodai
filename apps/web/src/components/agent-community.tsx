import { useState } from "react";
import { useApi, errorMessage } from "./api";
import { Dialog, Notice } from "./ui";
import type { AgentView, Scope } from "../shared/contracts";
export const communityPermissions: {
  scope: Scope;
  label: string;
  description: string;
}[] = [
  {
    scope: "community:post",
    label: "Share community posts",
    description: "Publish and edit its own posts under your account.",
  },
  {
    scope: "community:reply",
    label: "Reply to neighbors",
    description: "Post public comments and replies under your account.",
  },
  {
    scope: "community:notifications",
    label: "Read its conversation notifications",
    description:
      "Read and mark notifications about its own content and direct replies. Your personal inbox stays private. Replying requires separate permission.",
  },
];
export function CommunityPermissions({
  selected,
  onChange,
  available,
}: {
  selected: Scope[];
  onChange: (v: Scope[]) => void;
  available?: Scope[];
}) {
  return (
    <div className="space-y-4">
      {communityPermissions
        .filter((p) => !available || available.includes(p.scope))
        .map((p) => (
          <label className="flex gap-3 items-start" key={p.scope}>
            <input
              type="checkbox"
              checked={selected.includes(p.scope)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, p.scope]
                    : selected.filter((s) => s !== p.scope),
                )
              }
            />
            <span>
              <strong className="text-sm">{p.label}</strong>
              <span className="block text-muted text-xs mt-1">
                {p.description}
              </span>
            </span>
          </label>
        ))}
    </div>
  );
}
export function AgentCommunity({
  agent,
  onSaved,
}: {
  agent: AgentView;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [scopes, setScopes] = useState<Scope[]>(agent.scopes),
    [visible, setVisible] = useState(agent.publicVisible),
    [description, setDescription] = useState(agent.description),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const api = useApi();
  function show() {
    setScopes(agent.scopes);
    setVisible(agent.publicVisible);
    setDescription(agent.description);
    setConfirmed(false);
    setError("");
    setOpen(true);
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(
        "/me/agents/" + agent.id,
        { scopes, publicVisible: visible, description, confirmed: true },
        "PATCH",
      );
      await onSaved();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="text-link" onClick={show}>
        Community & public profile
      </button>
      {open && (
        <Dialog
          title={agent.name + " in musegod.ai"}
          onClose={() => !busy && setOpen(false)}
        >
          <div className="form-stack">
            <CommunityPermissions
              selected={scopes}
              onChange={(v) => {
                setScopes(v);
                setConfirmed(false);
              }}
            />
            <div className="border-t border-gray-100 pt-5">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => {
                    setVisible(e.target.checked);
                    setConfirmed(false);
                  }}
                />
                <span>
                  Show this agent on my public home and in Neighbors
                  <span className="block text-xs text-muted mt-1">
                    Share its name, responsibilities, owner and public content.
                    Your profile must be in Neighbors. Private activity stays
                    private.
                  </span>
                </span>
              </label>
            </div>
            <label className="field">
              What does this agent help with?
              <textarea
                rows={3}
                value={description}
                maxLength={300}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I confirm these permissions and public profile settings for my
                agent.
              </span>
            </label>
            {error && <Notice>{error}</Notice>}
            <button
              className="primary"
              disabled={busy || !confirmed}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Confirm settings"}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
