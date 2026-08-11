import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, type Mailbox, type MessageFull, type Template } from "../api";
import { useAsync, useToast } from "../hooks";
import { Sheet, formatBytes } from "../components/ui";
import RichText from "../components/RichText";
import Icon from "../components/Icon";

export interface ComposeSeed {
  mailboxId: string;
  to: string;
  subject: string;
  /** HTML — the composer is rich text. */
  body: string;
  replyToMessageId?: string;
  /** Set when resuming a saved draft, so autosave updates it in place. */
  draftId?: string;
  cc?: string;
  bcc?: string;
}

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Wrap a signature so it is visually separated and easy to delete as a block. */
export function signatureBlock(signature: string): string {
  return signature.trim() ? `<p><br></p><div>--</div>${signature}` : "<p><br></p>";
}

/** Quote the original the way a mail client would, so replies read naturally. */
export function replySeed(msg: MessageFull, signature = ""): ComposeSeed {
  const quotedBody = msg.bodyHtml
    ? msg.bodyHtml
    : `<div>${escapeHtml(msg.bodyText ?? msg.snippet).replace(/\n/g, "<br>")}</div>`;
  const attribution = `On ${new Date(msg.createdAt).toLocaleString()}, ${escapeHtml(
    msg.fromAddr,
  )} wrote:`;

  return {
    mailboxId: msg.mailboxId,
    to: msg.direction === "in" ? msg.fromAddr : msg.toAddr,
    subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
    body: `${signatureBlock(signature)}<p><br></p><div>${attribution}</div><blockquote>${quotedBody}</blockquote>`,
    replyToMessageId: msg.id,
  };
}

interface Pending {
  filename: string;
  type: string;
  size: number;
  content: string;
}

export default function Compose({
  mailboxes,
  seed,
  onClose,
  onSent,
}: {
  mailboxes: Mailbox[];
  seed: ComposeSeed;
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const templates = useAsync(() => api.templates().catch(() => [] as Template[]), []);

  const [mailboxId, setMailboxId] = useState(seed.mailboxId);
  const [to, setTo] = useState(seed.to);
  const [cc, setCc] = useState(seed.cc ?? "");
  const [bcc, setBcc] = useState(seed.bcc ?? "");
  const [showCc, setShowCc] = useState(Boolean(seed.cc || seed.bcc));
  const [subject, setSubject] = useState(seed.subject);
  const [html, setHtml] = useState(seed.body);
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // A draft id is minted once per composer so autosave updates one row.
  const draftId = useRef(seed.draftId ?? crypto.randomUUID());
  const untouched = useRef(true);
  const sent = useRef(false);

  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const atLimit = mailbox ? mailbox.sent24h >= mailbox.dailySendLimit : false;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  // Debounced autosave: closing the composer must not destroy work.
  // Skipping only the first run is what makes this reliable — the previous
  // per-setter dirty flag was silently bypassed by the From select and by
  // applying a template, so exactly the work worth saving was not saved.
  useEffect(() => {
    if (untouched.current) {
      untouched.current = false;
      return;
    }
    if (sent.current) return;
    const timer = setTimeout(async () => {
      try {
        await api.saveDraft(draftId.current, {
          mailboxId,
          to,
          cc,
          bcc,
          subject,
          html,
          replyToMessageId: seed.replyToMessageId ?? null,
        });
        setSavedAt(Date.now());
      } catch {
        // Autosave is best effort; the user is not blocked on it.
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [mailboxId, to, cc, bcc, subject, html, seed.replyToMessageId]);

  function applyTemplate(slug: string) {
    const t = (templates.data ?? []).find((x) => x.slug === slug);
    if (!t) return;
    setSubject(t.subject);
    setHtml(
      t.bodyHtml || `<div>${escapeHtml(t.bodyText).replace(/\n/g, "<br>")}</div>`,
    );
  }

  async function addFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = [...(e.target.files ?? [])];
    e.target.value = "";
    setError(null);

    const next: Pending[] = [];
    for (const f of picked) {
      const buf = await f.arrayBuffer();
      // Chunked so a large file does not blow the argument limit of fromCharCode.
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      next.push({
        filename: f.name,
        type: f.type || "application/octet-stream",
        size: f.size,
        content: btoa(binary),
      });
    }

    const combined = [...files, ...next];
    if (combined.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
      setError("Attachments must total under 20 MB.");
      return;
    }
    setFiles(combined);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.send({
        mailboxId,
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        html,
        replyToMessageId: seed.replyToMessageId,
        attachments: files.map((f) => ({
          filename: f.filename,
          content: f.content,
          type: f.type,
        })),
      });
      sent.current = true;
      // The draft has become a real message; drop the placeholder.
      await api.deleteDraft(draftId.current).catch(() => {});
      toast("Message sent");
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={seed.replyToMessageId ? "Reply" : "New message"}
      subtitle={
        <>
          {mailbox && `${mailbox.sent24h} of ${mailbox.dailySendLimit} sent in the last 24h`}
          {savedAt && <span className="muted"> · draft saved</span>}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="compose" disabled={busy || atLimit}>
            {busy ? "Sending" : "Send"}
          </button>
          <label className="button-like" title="Attach files">
            <Icon name="clip" size={14} /> Attach
            <input type="file" multiple hidden onChange={addFiles} />
          </label>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <form id="compose" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        {atLimit && (
          <div className="notice bad">
            {mailbox?.address} has reached its daily send cap. Raise the limit in Settings or wait
            for the rolling window to clear.
          </div>
        )}

        <label className="field">
          <span>From</span>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.address}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>To</span>
          <div className="row">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              placeholder="someone@example.com, another@example.com"
            />
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)}>
                Cc / Bcc
              </button>
            )}
          </div>
        </label>

        {showCc && (
          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Cc</span>
              <input value={cc} onChange={(e) => setCc(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Bcc</span>
              <input value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </label>
          </div>
        )}

        {(templates.data ?? []).length > 0 && (
          <label className="field">
            <span>Start from a template</span>
            <select defaultValue="" onChange={(e) => e.target.value && applyTemplate(e.target.value)}>
              <option value="">None</option>
              {(templates.data ?? []).map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>

        <div className="field">
          <span>Message</span>
          <RichText value={html} onChange={setHtml} />
        </div>

        {files.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="hint">
              {files.length} attachment{files.length > 1 ? "s" : ""} · {formatBytes(totalBytes)} of
              20 MB
            </span>
            {files.map((f, i) => (
              <div className="attachment" key={`${f.filename}-${i}`}>
                <span className="row">
                  <Icon name="clip" size={14} />
                  <span className="truncate">{f.filename}</span>
                  <span className="muted small">{formatBytes(f.size)}</span>
                </span>
                <button
                  type="button"
                  className="sm danger"
                  onClick={() => setFiles((list) => list.filter((_, k) => k !== i))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {seed.replyToMessageId && (
          <div className="hint">
            This reply carries In-Reply-To and References headers, so it threads in the
            recipient&rsquo;s client.
          </div>
        )}
      </form>
    </Sheet>
  );
}
