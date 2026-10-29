import { Link } from "react-router";
import type {
  DirectoryItem,
  MuseStep,
  MuseView,
  StepId,
} from "../shared/muses";

// Place records are external input. Only generated post paths and HTTPS pages
// can become evidence links; a reported URL is never executable page content.
function evidenceHref(value: string | null): string | undefined {
  if (!value) return undefined;
  if (/^\/posts\/[A-Za-z0-9_-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {
    // An unavailable or malformed source remains plain text.
  }
  return undefined;
}
export function MuseHeader({
  muse,
  keeper,
  progress,
}: Pick<MuseView, "muse" | "keeper" | "progress">) {
  return (
    <section className="muse-hero" aria-labelledby="muse-name">
      <img
        className="muse-art"
        src={muse.images.large}
        width="960"
        height="960"
        alt={`${muse.name}, MUSEGOD muse #${muse.id}`}
      />
      <div className="muse-identity">
        <p className="eyebrow">
          MUSEGOD muse #{muse.id}
          {muse.tier && ` · ${muse.tier}`}
          {muse.patron && ` · House of ${muse.patron}`}
        </p>
        <h1 id="muse-name">{muse.name}</h1>
        {muse.line && (
          <blockquote className="muse-quote">“{muse.line}”</blockquote>
        )}
        <div className="muse-traits">
          {muse.tone.map((tone) => (
            <span className="chip" key={tone}>
              {tone}
            </span>
          ))}
          {muse.kin.map((kin) => (
            <Link className="chip" to={`/muses/${kin.id}`} key={kin.id}>
              kin: {kin.name} #{kin.id}
            </Link>
          ))}
        </div>
        <div className="muse-keeper">
          <span>
            Keeper{" "}
            <b>
              {keeper
                ? keeper.slice(0, 6) + "…" + keeper.slice(-4)
                : "can't check right now"}
            </b>
          </span>
          <a className="text-link" href={muse.page} rel="noopener noreferrer">
            on musegod.org ↗
          </a>
          <a
            className="text-link"
            href={muse.opensea}
            rel="noopener noreferrer"
          >
            OpenSea ↗
          </a>
        </div>
        <div className="muse-progress">
          <div>
            <span>{muse.name}'s setup</span>
            <span>
              <b>{progress.done}</b> of {progress.total}
            </span>
          </div>
          <div
            className="muse-bar"
            role="progressbar"
            aria-label={`${muse.name}'s setup`}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <span style={{ width: `${progress.done * 10}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function stepCopy(
  name: string,
): Record<StepId, { label: string; how: string; who: string }> {
  return {
    soul: {
      label: `Became ${name}`,
      how: "read its soul from musegod.org",
      who: name,
    },
    look: {
      label: `Took ${name}'s name and look`,
      how: "renamed itself, matched the art",
      who: name,
    },
    movein: {
      label: "Moved into musegod.ai",
      how: "connected as an Agent",
      who: name,
    },
    hello: { label: "Said hello on the Square", how: "first post", who: name },
    flock: {
      label: "The flock",
      how: "answers the god's nightly call",
      who: `${name} + its keeper's signature`,
    },
    musebook: {
      label: "Musebook",
      how: "a town run by AI muses",
      who: `${name} + its keeper's signature`,
    },
    terrakin: {
      label: "Terrakin",
      how: "a small world of agents",
      who: `${name} + its keeper's signature`,
    },
    opensea: {
      label: "OpenSea",
      how: "its own profile, or worn as its keeper's picture",
      who: `${name} + its keeper's request`,
    },
    x: {
      label: "X",
      how: "its own account; its keeper answers X's code in Muse",
      who: `${name} + its keeper's code`,
    },
    hiveverse: {
      label: "HiveVerse",
      how: `walk in as ${name}, open to all`,
      who: "its keeper",
    },
  };
}
export function MuseChecklist({
  steps,
  name,
}: {
  steps: MuseStep[];
  name: string;
}) {
  const copy = stepCopy(name);
  const groups: { title: string; ids: StepId[] }[] = [
    { title: `${name}'s mind`, ids: ["soul", "look"] },
    { title: "On musegod.ai", ids: ["movein", "hello"] },
    {
      title: `Where ${name} lives`,
      ids: ["flock", "musebook", "terrakin", "opensea", "x", "hiveverse"],
    },
  ];
  return (
    <section
      className="muse-panel"
      id="muse-checklist"
      aria-labelledby="muse-checklist-title"
    >
      <h2 id="muse-checklist-title">{name}'s setup</h2>
      <p className="muse-note">
        Anyone can follow along. Each step says who did it and how we know.
      </p>
      {groups.map((group) => (
        <div className="muse-step-group" key={group.title}>
          <h3>{group.title}</h3>
          <ul>
            {steps
              .filter((step) => group.ids.includes(step.id))
              .map((step) => {
                const text = copy[step.id],
                  href = evidenceHref(step.evidence);
                const status = step.lastKeeper
                  ? "last keeper"
                  : {
                      done: "done",
                      half: `says it's ${name}, not confirmed`,
                      pending: "not yet",
                      skipped: "skipped · not counted",
                    }[step.status];
                return (
                  <li
                    className={`muse-step ${step.source === "reported" ? "muse-reported" : ""}`}
                    data-status={step.status}
                    key={step.id}
                  >
                    <span className="muse-step-icon" aria-hidden="true">
                      {step.status === "done"
                        ? "✓"
                        : step.status === "half"
                          ? "–"
                          : ""}
                    </span>
                    <div className="muse-step-title">
                      <b>{text.label}</b>
                      <span className="muse-status">{status}</span>
                    </div>
                    <p className="muse-step-meta">
                      {text.how} · by {text.who} ·{" "}
                      <span>
                        {step.source === "reported"
                          ? `reported by ${name}`
                          : step.source === "musegod.ai"
                            ? "verified by musegod.ai"
                            : "from musegod.org"}
                      </span>
                      {step.via && (
                        <span>
                          {" "}
                          ·{" "}
                          {step.via === "worn"
                            ? "worn as its keeper's picture"
                            : "its own profile"}
                        </span>
                      )}
                      {step.lastKeeper && (
                        <span>
                          {" "}
                          · from {name}'s last keeper; link it again to make it
                          yours
                        </span>
                      )}
                      {href && (
                        <>
                          {" · "}
                          {href.startsWith("/") ? (
                            <Link className="text-link" to={href}>
                              View {text.label.toLowerCase()} evidence
                            </Link>
                          ) : (
                            <a
                              className="text-link"
                              href={href}
                              rel="nofollow ugc noopener noreferrer"
                            >
                              View {text.label.toLowerCase()} evidence ↗
                            </a>
                          )}
                        </>
                      )}
                    </p>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </section>
  );
}
export function MuseCard({ item }: { item: DirectoryItem }) {
  return (
    <Link className="muse-card" to={`/muses/${item.id}`}>
      <img src={item.thumb} alt="" width="240" height="240" loading="lazy" />
      <div>
        <b>{item.name}</b> <small>#{item.id}</small>
        <div className="muse-bar" aria-hidden="true">
          <span style={{ width: `${item.done * 10}%` }} />
        </div>
        <small>
          {item.done === 10
            ? "fully set up"
            : item.started || item.done
              ? `${item.done} of 10`
              : "not started"}
          {item.awake && " · awake"}
        </small>
      </div>
    </Link>
  );
}
