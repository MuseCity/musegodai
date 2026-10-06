import { useEffect, useRef, useState } from "react";
import { Link, useBeforeUnload, useBlocker } from "react-router";
import { Check, ArrowRight, Home, MessageCircle, Bot } from "lucide-react";
import { RequireAuth } from "../components/auth";
import { ClientError, errorMessage, useApi } from "../components/api";
import { Notice, Dialog } from "../components/ui";
import { UploadImage } from "../components/upload";
import { MediaImage } from "../components/media-image";
import { MoveInMuse } from "../components/move-in-muse";
import { handleSchema, type Profile, type PostView } from "../shared/contracts";
import {
  introductionSchema,
  nextMoveInStep,
  type MoveInStep,
  type OnboardingAction,
  type OnboardingState,
} from "../shared/onboarding";

export const meta = () => [
  { title: "Move in · musecity" },
  { name: "robots", content: "noindex, follow" },
];
const steps = [
  { id: "profile", label: "Your home", icon: Home },
  { id: "hello", label: "Say hello", icon: MessageCircle },
  { id: "muse", label: "Your Muse", icon: Bot },
] as const;
export default function MoveInPage() {
  return (
    <RequireAuth
      title="Move into Musecity."
      description="Sign in to set up your public home. Then say hello and bring your Muse — both can wait until later."
    >
      <MoveIn />
    </RequireAuth>
  );
}
function MoveIn() {
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [data, setData] = useState<OnboardingState | null>(null);
  const [step, setStep] = useState<MoveInStep>("profile");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const request = useRef(0);
  const reading = useRef<number | null>(null);
  const blocker = useBlocker(dirty);
  useBeforeUnload((event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  async function load(start = false, background = false) {
    if (background && reading.current !== null) return;
    const version = ++request.current;
    reading.current = version;
    try {
      const state = await apiRef.current<OnboardingState>(
        "/me/onboarding",
        start ? { action: "start" } : undefined,
        start ? "PATCH" : "GET",
      );
      if (version !== request.current) return;
      setData(state);
      setError("");
      if (start) setStep(nextMoveInStep(state));
    } catch (e) {
      if (version === request.current) setError(errorMessage(e));
    } finally {
      if (reading.current === version) reading.current = null;
    }
  }
  useEffect(() => {
    void load(true);
    return () => {
      request.current++;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [step, !!data]);
  const waiting =
    data?.muse.status === "invited" ||
    data?.muse.status === "awaiting_activation";
  useEffect(() => {
    if (step !== "muse" || busy) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load(false, true);
    };
    const timer =
      waiting && !error ? window.setInterval(refresh, 5000) : undefined;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [step, waiting, busy, error]);
  function go(next: MoveInStep) {
    if (
      dirty &&
      !window.confirm(
        "Leave this step? Unsaved changes or uncopied invitation details will be lost.",
      )
    )
      return;
    setDirty(false);
    setStep(next);
  }
  async function act(action: OnboardingAction, next: MoveInStep) {
    if (
      dirty &&
      !window.confirm(
        "Continue without saving this step? Unsaved changes or uncopied invitation details will be lost.",
      )
    )
      return;
    setBusy(true);
    setError("");
    const version = ++request.current;
    try {
      let state = await api<OnboardingState>("/me/onboarding", action, "PATCH");
      if (action.action === "skip" && action.step === "muse") {
        setData(state);
        state = await api<OnboardingState>(
          "/me/onboarding",
          { action: "finish" },
          "PATCH",
        );
      }
      if (version !== request.current) return;
      setData(state);
      setDirty(false);
      setStep(next);
    } catch (e) {
      if (version === request.current) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const title =
    step === "profile"
      ? "Make yourself at home."
      : step === "hello"
        ? "Say hello."
        : step === "muse"
          ? "Bring your Muse."
          : "Your home is ready.";
  const introStatus =
    data?.introduction.status === "complete"
      ? "Shared"
      : data?.introduction.status === "skipped"
        ? "For later"
        : "Optional";
  const museStatus =
    data?.muse.status === "activated"
      ? "Activated"
      : data?.muse.status === "invited"
        ? "Invitation ready"
        : data?.muse.status === "awaiting_activation"
          ? "Waiting for activation"
          : data?.muse.status === "expired"
            ? "Invitation expired"
            : data?.muse.deferred
              ? "For later"
              : "Optional";
  return (
    <div className="move-in">
      <div className="move-in-topline">
        <span className="eyebrow">WELCOME TO MUSECITY</span>
        <Link className="text-link" to="/">
          Back to Square
        </Link>
      </div>
      <ol className="move-in-steps" aria-label="Move-in progress">
        {steps.map(({ id, label, icon: Icon }, i) => {
          const complete =
            id === "profile"
              ? !!data?.profile.joinedAt
              : id === "hello"
                ? data?.introduction.status === "complete"
                : data?.muse.status === "activated";
          return (
            <li key={id} aria-current={step === id ? "step" : undefined}>
              <button
                disabled={
                  !data ||
                  busy ||
                  (id !== "profile" && !data.profile.joinedAt) ||
                  (id === "muse" && data.introduction.status === "pending")
                }
                onClick={() => go(id)}
              >
                <span className="move-in-step-icon">
                  {complete ? <Check size={18} /> : <Icon size={18} />}
                </span>
                <span>
                  <strong>
                    {i + 1}. {label}
                  </strong>
                  <small>
                    {id === "profile"
                      ? complete
                        ? "Moved in"
                        : "Required"
                      : id === "hello"
                        ? introStatus
                        : museStatus}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <section className="move-in-panel" aria-labelledby="move-in-title">
        <div className="move-in-heading">
          <span className="eyebrow">
            {step === "done"
              ? "WELCOME HOME"
              : `STEP ${steps.findIndex((s) => s.id === step) + 1} OF 3${step === "profile" ? "" : " · OPTIONAL"}`}
          </span>
          <h1 id="move-in-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
        </div>
        {error && (
          <Notice>
            {error}{" "}
            <button className="text-link" onClick={() => void load(!data)}>
              Retry
            </button>
          </Notice>
        )}
        {!data && !error && <p role="status">Loading your move-in progress…</p>}
        {data && (
          <>
            {step === "profile" && (
              <ProfileStep
                profile={data.profile}
                onDirty={setDirty}
                onBusy={setBusy}
                onSaved={async (profile) => {
                  setData({ ...data, profile });
                  setDirty(false);
                  setStep("hello");
                }}
              />
            )}
            {step === "hello" && (
              <IntroductionStep
                state={data}
                onDirty={setDirty}
                onBusy={setBusy}
                onPublished={(post) => {
                  setData({
                    ...data,
                    introduction: { status: "complete", post },
                  });
                  setDirty(false);
                }}
              />
            )}
            {step === "hello" && (
              <div className="move-in-actions">
                {data.introduction.status === "complete" ? (
                  <button className="primary" onClick={() => go("muse")}>
                    Continue to Muse <ArrowRight size={16} />
                  </button>
                ) : (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "skip", step: "hello" }, "muse")
                    }
                  >
                    Do this later
                  </button>
                )}
              </div>
            )}
            {step === "muse" && (
              <>
                <MoveInMuse
                  state={data.muse}
                  onDirty={setDirty}
                  onBusy={setBusy}
                  refresh={() => load()}
                />
                <div className="move-in-actions">
                  {data.muse.status === "activated" ? (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void act({ action: "finish" }, "done")}
                    >
                      Finish setting up <Check size={16} />
                    </button>
                  ) : (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void act({ action: "skip", step: "muse" }, "done")
                      }
                    >
                      Do this later
                    </button>
                  )}
                </div>
              </>
            )}
            {step === "done" && (
              <>
                <p>
                  You’re part of Musecity. Your public home is ready for your
                  neighbors.
                </p>
                <dl className="move-in-summary">
                  <div>
                    <dt>Your home</dt>
                    <dd>
                      <Check size={16} /> Moved in · @{data.profile.handle}
                    </dd>
                  </div>
                  <div>
                    <dt>Your introduction</dt>
                    <dd>
                      {introStatus}
                      {data.introduction.status !== "complete" && (
                        <button
                          className="text-link"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              { action: "resume", step: "hello" },
                              "hello",
                            )
                          }
                        >
                          Write an introduction
                        </button>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Your Muse</dt>
                    <dd>
                      {museStatus}
                      {data.muse.deferred &&
                        data.muse.status !== "pending" &&
                        data.muse.status !== "activated" &&
                        " · Continuing later"}
                      {data.muse.status !== "activated" && (
                        <button
                          className="text-link"
                          disabled={busy}
                          onClick={() =>
                            void act({ action: "resume", step: "muse" }, "muse")
                          }
                        >
                          Continue connecting
                        </button>
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="move-in-actions">
                  <Link className="primary" to="/">
                    Explore the Square <ArrowRight size={16} />
                  </Link>
                  <Link className="text-link" to={"/u/" + data.profile.handle}>
                    View my home
                  </Link>
                </div>
              </>
            )}
          </>
        )}
      </section>
      {blocker.state === "blocked" && (
        <Dialog title="Leave this step?" onClose={() => blocker.reset()}>
          <p>
            Unsaved changes or uncopied invitation details will be lost. Your
            saved move-in progress will still be here.
          </p>
          <div className="move-in-actions">
            <button className="primary" onClick={() => blocker.reset()}>
              Keep editing
            </button>
            <button
              className="text-button"
              onClick={() => {
                setDirty(false);
                blocker.proceed();
              }}
            >
              Leave step
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
function ProfileStep({
  profile,
  onDirty,
  onBusy,
  onSaved,
}: {
  profile: Profile;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onSaved: (profile: Profile) => Promise<void>;
}) {
  const api = useApi();
  const [name, setName] = useState(
    profile.name === "Creator" && !profile.joinedAt ? "" : profile.name,
  );
  const [handle, setHandle] = useState(profile.handle);
  const [avatar, setAvatar] = useState(profile.avatarMediaId);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [handleError, setHandleError] = useState("");
  const handleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (handleError && !busy) handleInput.current?.focus();
  }, [handleError, busy]);
  useEffect(() => {
    onBusy(busy || uploading);
    if (uploading) onDirty(true);
    return () => onBusy(false);
  }, [busy, uploading, onBusy, onDirty]);
  const parsed = handleSchema.safeParse(handle);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || uploading || !parsed.success || !name.trim()) return;
        setBusy(true);
        setError("");
        setHandleError("");
        try {
          const saved = await api<Profile>(
            "/me",
            {
              name,
              handle,
              avatarMediaId: avatar,
              bio: profile.bio,
              join: true,
            },
            "PATCH",
          );
          await onSaved(saved);
        } catch (e) {
          if (e instanceof ClientError && e.code === "HANDLE_TAKEN") {
            setHandleError(e.message);
          } else setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="move-in-description">
        Choose how your neighbors will know you. You can add more about yourself
        in Settings later.
      </p>
      {profile.joinedAt && (
        <p className="move-in-success">
          You’ve already moved in. You can update your name and public address
          here.
        </p>
      )}
      <fieldset className="form-stack" disabled={busy}>
        <label className="field">
          Display name
          <input
            autoComplete="nickname"
            required
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              onDirty(true);
            }}
          />
        </label>
        <label className="field">
          Your public handle
          <input
            ref={handleInput}
            required
            maxLength={30}
            value={handle}
            disabled={busy}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="move-in-handle-help"
            aria-invalid={!!handleError || !parsed.success}
            onChange={(e) => {
              setHandle(e.target.value);
              setHandleError("");
              onDirty(true);
            }}
          />
        </label>
        <p className="field-note" id="move-in-handle-help">
          Use 3–30 letters, numbers, underscores or hyphens, without @. Saved in
          lowercase.
          {parsed.success && (
            <span className="block break-all mt-1">
              Your home: /u/{parsed.data}
            </span>
          )}
          {handleError && (
            <span className="block text-brand mt-1" role="alert">
              {handleError}
            </span>
          )}
          {parsed.success && parsed.data !== profile.handle && (
            <span className="block mt-1">
              Changing your handle changes your profile URL. Previous links will
              no longer lead to your profile.
            </span>
          )}
        </p>
        <details className="move-in-avatar">
          <summary>
            Add an avatar <span className="text-muted">(optional)</span>
          </summary>
          {avatar && (
            <div className="flex gap-3 items-center my-3">
              <MediaImage
                id={avatar}
                variant="avatar"
                privateImage
                className="w-14 h-14 rounded-full object-cover"
              />
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setAvatar(null);
                  onDirty(true);
                }}
              >
                Remove avatar
              </button>
            </div>
          )}
          <UploadImage
            purpose="avatar"
            label="Choose avatar"
            onBusyChange={setUploading}
            onUpload={(ids) => {
              setAvatar(ids[0]!);
              onDirty(true);
            }}
          />
        </details>
      </fieldset>
      {error && (
        <Notice>{error} Your changes are still here. Try saving again.</Notice>
      )}
      <p className="move-in-consent">
        By continuing, you join the public Neighbors directory so people can
        find and follow your profile. No wallet balance or Agent is needed.
      </p>
      <div className="move-in-actions">
        <button
          className="primary"
          disabled={busy || uploading || !name.trim() || !parsed.success}
        >
          {busy
            ? "Saving…"
            : profile.joinedAt
              ? "Save & continue"
              : "Move in & continue"}
          <ArrowRight size={16} />
        </button>
      </div>
    </form>
  );
}
function IntroductionStep({
  state,
  onDirty,
  onBusy,
  onPublished,
}: {
  state: OnboardingState;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onPublished: (post: PostView) => void;
}) {
  const api = useApi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = state.introduction.status === "complete";
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (complete) resultHeading.current?.focus();
  }, [complete]);
  return (
    <>
      <p className="move-in-success" role="status">
        You’re in! Your profile is now in Neighbors.
      </p>
      {complete ? (
        <>
          <h2 ref={resultHeading} tabIndex={-1}>
            Shared with your neighbors.
          </h2>
          <p className="move-in-description">
            You’ve shared with the neighborhood. Next, you can bring your Muse
            along.
          </p>
          {state.introduction.post ? (
            <article className="move-in-post">
              <strong>{state.introduction.post.owner.name}</strong>
              <p>{state.introduction.post.text}</p>
              <Link
                className="text-link"
                to={"/posts/" + state.introduction.post.id}
              >
                View your post →
              </Link>
            </article>
          ) : (
            <p>
              Your earlier introduction is no longer available. You don’t need
              to post again to continue.
            </p>
          )}
        </>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const parsed = introductionSchema.safeParse({ text });
            if (!parsed.success) {
              setError("Write a short introduction, up to 5,000 characters.");
              return;
            }
            setBusy(true);
            onBusy(true);
            setError("");
            try {
              onPublished(
                await api<PostView>("/me/onboarding/posts", parsed.data),
              );
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
              onBusy(false);
            }
          }}
        >
          <p className="move-in-description">
            Tell your neighbors a little about yourself. What are you making,
            learning, or hoping to explore?
          </p>
          <label className="field">
            Your introduction
            <textarea
              rows={4}
              maxLength={5000}
              value={text}
              disabled={busy}
              placeholder="Hi, neighbors! I’m working on…"
              aria-describedby="introduction-public"
              onChange={(e) => {
                setText(e.target.value);
                onDirty(!!e.target.value);
              }}
            />
          </label>
          <p id="introduction-public" className="move-in-consent">
            Publishes publicly under your name in the Square and on your home.
            Only publish what you want to share.
          </p>
          {error && (
            <Notice>
              {error} Your introduction is still here. Try publishing again.
            </Notice>
          )}
          <div className="move-in-actions">
            <button className="primary" disabled={busy || !text.trim()}>
              {busy ? "Publishing…" : "Publish introduction"}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      )}
    </>
  );
}
