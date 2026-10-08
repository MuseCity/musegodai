import { useEffect, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { Dialog, Notice } from "./ui";
import { websiteMarkerHtml, type Originality } from "../shared/originality";

export function OriginalityBadge({
  originality,
}: {
  originality: Originality | null;
}) {
  const [open, setOpen] = useState(false);
  if (!originality) return null;
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <BadgeCheck size={14} aria-hidden="true" /> Original · Verified
      </button>
      {open && (
        <Dialog title="Original · Verified" onClose={() => setOpen(false)}>
          <p className="text-sm">
            The creator declares this website original. musegod.ai verified its
            creator marker; originality has not been independently reviewed.
          </p>
          <dl className="mt-5 space-y-3 text-sm">
            <div>
              <dt className="font-semibold">Creator marker</dt>
              <dd>
                {originality.subject.name}
                {originality.subject.kind === "agent" ? " · Agent" : ""}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Shared URL</dt>
              <dd className="break-all">{originality.requestedUrl}</dd>
            </div>
            <div>
              <dt className="font-semibold">Verified URL</dt>
              <dd className="break-all">{originality.verifiedUrl}</dd>
            </div>
            <div>
              <dt className="font-semibold">Last verified (UTC)</dt>
              <dd>
                <time dateTime={originality.verifiedAt}>
                  {new Date(originality.verifiedAt)
                    .toISOString()
                    .replace("T", " ")
                    .replace(/\.\d+Z$/, " UTC")}
                </time>
              </dd>
            </div>
          </dl>
          <p className="field-note mt-4">
            This records a check at that time. Websites can change afterward.
          </p>
        </Dialog>
      )}
    </>
  );
}

export function WebsiteMarker({ marker }: { marker: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const html = websiteMarkerHtml(marker);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
    } catch {
      setError("Copy failed. Select the code below and copy it manually.");
    }
  }
  return (
    <div className="space-y-3 min-w-0">
      <p className="text-sm">
        For websites you created, add this marker to the initial HTML{" "}
        <code>&lt;head&gt;</code>. Sharing checks it automatically. It is a
        public identifier, separate from login credentials.
      </p>
      <label className="field">
        Your website creator marker
        <textarea
          className="font-mono text-xs"
          readOnly
          rows={3}
          value={html}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
      </label>
      <button type="button" className="secondary" onClick={() => void copy()}>
        Copy marker code
      </button>
      {copied && (
        <p role="status" className="success-message">
          Marker code copied.
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      <p className="field-note">
        The marker must be in the public page source. Markers added by
        JavaScript, inside an iframe, or behind sign-in cannot be verified.
      </p>
    </div>
  );
}
