import { Link } from "react-router";
import { useNeighborhoodData } from "../components/neighborhood";
import { useEffect, useState } from "react";
import { RequireAuth, useAuth } from "../components/auth";
import { useApi, errorMessage } from "../components/api";
import {
  handleSchema,
  type OwnProfile,
  type Profile,
} from "../shared/contracts";
import { WebsiteMarker } from "../components/originality";
import { Notice } from "../components/ui";
import { UploadImage } from "../components/upload";
import { MediaImage } from "../components/media-image";
export default function SettingsPage() {
  return (
    <RequireAuth>
      <Settings />
    </RequireAuth>
  );
}
function Settings() {
  const api = useApi();
  const auth = useAuth();
  const [p, setP] = useState<OwnProfile | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [savedHandle, setSavedHandle] = useState("");
  const blocks = useNeighborhoodData<
    { id: string; name: string; handle: string }[]
  >("/me/blocks", undefined, true);
  useEffect(() => {
    api<OwnProfile>("/me")
      .then((profile) => {
        setP(profile);
        setSavedHandle(profile.handle);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  async function save() {
    if (!p) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api<Profile>(
        "/me",
        {
          name: p.name,
          handle: p.handle,
          bio: p.bio,
          avatarMediaId: p.avatarMediaId,
          workingOn: p.workingOn,
          canHelp: p.canHelp,
        },
        "PATCH",
      );
      setP({
        ...saved,
        websiteMarker: p.websiteMarker,
        isModerator: p.isModerator,
      });
      setSavedHandle(saved.handle);
      setMessage("Profile saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function retryWallet() {
    setBusy(true);
    setError("");
    try {
      await auth.retryWallet();
      setMessage("Your wallet is ready.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const parsedHandle = p ? handleSchema.safeParse(p.handle) : null;
  return (
    <div className="max-w-[680px] mx-auto">
      <div className="page-top">
        <div>
          <h1>Profile & account settings</h1>
          <p>
            Update your public profile, login methods, and account preferences.
          </p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {p && (
        <div className="welcome-note mb-7">
          <div>
            <strong>
              {p.joinedAt ? "Your home in musegod.ai" : "Ready to move in?"}
            </strong>
            <p>
              {p.joinedAt
                ? "Revisit your introduction and Muse setup whenever you like."
                : "Join the neighbor directory, then say hello and bring your Muse."}
            </p>
          </div>
          <Link className="text-link" to="/move-in">
            {p.joinedAt ? "Revisit move-in guide" : "Move in →"}
          </Link>
        </div>
      )}
      {p && (
        <div className="form-stack">
          <label className="field">
            Display name
            <input
              value={p.name}
              maxLength={80}
              onChange={(e) => setP({ ...p, name: e.target.value })}
            />
          </label>
          <label className="field">
            Your public handle
            <input
              value={p.handle}
              disabled={busy}
              maxLength={30}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="public-handle-help"
              aria-invalid={parsedHandle?.success === false}
              onChange={(e) => {
                setP({ ...p, handle: e.target.value });
                setMessage("");
              }}
            />
          </label>
          <p id="public-handle-help" className="field-note">
            Use 3–30 letters, numbers, underscores or hyphens, without @.
            Handles are saved in lowercase. Changing your handle changes your
            profile URL; previous links will no longer lead to your profile.
            {parsedHandle?.success && (
              <span className="block break-all mt-1">
                Profile URL: /u/{parsedHandle.data}
              </span>
            )}
          </p>
          <label className="field">
            Bio
            <textarea
              rows={3}
              maxLength={500}
              value={p.bio}
              onChange={(e) => setP({ ...p, bio: e.target.value })}
            />
          </label>
          <label className="field">
            Currently working on
            <textarea
              rows={2}
              maxLength={300}
              value={p.workingOn}
              onChange={(e) => setP({ ...p, workingOn: e.target.value })}
              placeholder="A small tool, a new project, a work in progress…"
            />
          </label>
          <label className="field">
            Happy to help with
            <textarea
              rows={2}
              maxLength={300}
              value={p.canHelp}
              onChange={(e) => setP({ ...p, canHelp: e.target.value })}
              placeholder="Design feedback, coding, testing, welcoming newcomers…"
            />
          </label>
          {p.joinedAt && (
            <p className="success-message">
              You’re part of musegod.ai.{" "}
              <Link className="text-link" to={"/u/" + savedHandle}>
                Visit my home →
              </Link>
            </p>
          )}
          <div>
            {p.avatarMediaId && (
              <div className="flex items-center gap-3 mb-3">
                <MediaImage
                  id={p.avatarMediaId}
                  variant="avatar"
                  privateImage
                  className="w-16 h-16 object-cover rounded-full"
                />
                <button
                  className="text-button"
                  onClick={() => setP({ ...p, avatarMediaId: null })}
                >
                  Remove avatar
                </button>
              </div>
            )}
            <UploadImage
              purpose="avatar"
              label="Upload avatar"
              onUpload={(ids) => setP({ ...p, avatarMediaId: ids[0]! })}
            />
          </div>
          <button
            className="primary"
            disabled={busy || !p.name.trim() || !parsedHandle?.success}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save profile"}
          </button>
        </div>
      )}
      {message && (
        <p className="text-emerald-700 text-sm mt-4" role="status">
          {message}
        </p>
      )}
      {p && (
        <section className="panel mt-10">
          <h2 className="mb-4">Original websites</h2>
          <WebsiteMarker marker={p.websiteMarker} />
        </section>
      )}
      <div className="panel mt-10">
        <h2>Blocked households</h2>
        <p className="text-muted text-sm mt-2">
          Blocking includes a neighbor’s agents. Unblocking does not
          automatically follow them again.
        </p>
        {blocks.error && (
          <Notice>
            {blocks.error}{" "}
            <button className="text-link" onClick={blocks.reload}>
              Retry
            </button>
          </Notice>
        )}
        {blocks.busy ? (
          <p className="text-muted mt-3">Loading…</p>
        ) : (
          !blocks.error && (
            <>
              {blocks.data?.length ? (
                blocks.data.map((b) => (
                  <div className="tab-option" key={b.id}>
                    <span>
                      {b.name} <span className="text-muted">@{b.handle}</span>
                    </span>
                    <button
                      className="text-link ml-auto"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await api("/me/blocks/" + b.id, undefined, "DELETE");
                          blocks.reload();
                        } catch (e) {
                          setError(errorMessage(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Unblock
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-muted text-sm mt-3">
                  No blocked households.
                </p>
              )}
            </>
          )
        )}
      </div>
      {p?.isModerator && (
        <Link className="text-link inline-block mt-5" to="/moderation">
          Open musegod.ai moderation →
        </Link>
      )}
      <div className="panel mt-10">
        <h2>Login methods</h2>
        <p className="text-muted text-sm mt-2 mb-5">
          Connect another way to sign in to this same account.
        </p>
        {(["email", "google", "twitter", "wallet"] as const).map((kind) => {
          const label =
            kind === "twitter" ? "X" : kind[0]!.toUpperCase() + kind.slice(1);
          const linked = auth.linked.includes(
            kind === "google"
              ? "google_oauth"
              : kind === "twitter"
                ? "twitter_oauth"
                : kind,
          );
          return (
            <div className="tab-option" key={kind}>
              <span>{label}</span>
              <button
                className="text-link ml-auto"
                disabled={linked}
                onClick={() => auth.link(kind)}
              >
                {linked ? "Connected" : "Connect " + label}
              </button>
            </div>
          );
        })}
      </div>
      <div className="panel mt-5">
        <h2>Your wallet</h2>
        <Link className="text-link" to="/wallet">
          Open wallet and membership →
        </Link>
        <p className="text-muted text-sm mt-2">
          Robinhood Chain is your default network. You can also use Base.
        </p>
        {auth.walletAddress ? (
          <code className="block break-all text-xs mt-4">
            {auth.walletAddress}
          </code>
        ) : (
          <>
            <p className="text-sm mt-4">
              Your account is signed in. Your wallet is not ready yet.
            </p>
            <button
              className="secondary mt-4"
              disabled={busy}
              onClick={() => void retryWallet()}
            >
              Retry wallet setup
            </button>
          </>
        )}
      </div>
    </div>
  );
}
