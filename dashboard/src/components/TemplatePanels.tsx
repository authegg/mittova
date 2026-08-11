import { useState } from "react";
import { api, type Template, type TemplateVersion } from "../api";
import { useAsync, useToast } from "../hooks";
import { Sheet, absoluteTime, relativeTime } from "./ui";

/**
 * The variables this template uses, and what to show them as while previewing.
 *
 * Preview values are deliberately not saved: they are scaffolding for looking
 * at the thing, not part of it, and persisting them would invite someone to
 * mistake sample data for a default and ship "Hello Test User" to a customer.
 */
export function VariablesPanel({
  variables,
  values,
  onChange,
  onClose,
}: {
  variables: string[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Variables"
      onClose={onClose}
      footer={
        <>
          <button className="primary" onClick={onClose}>
            Done
          </button>
          <button onClick={() => onChange({})}>Clear values</button>
        </>
      }
    >
      {variables.length === 0 ? (
        <p className="small muted">
          No placeholders yet. Write <span className="mono">{"{{NAME}}"}</span> anywhere in the
          subject or body and it will appear here, and can be filled at send time.
        </p>
      ) : (
        <div className="stack">
          <p className="small muted">
            Found in the subject and body. Fill any in to see the preview with real-looking
            content; the values are for looking only and are not saved with the template.
          </p>
          {variables.map((v) => (
            <label className="field" key={v}>
              <span className="mono">{`{{${v}}}`}</span>
              <input
                value={values[v] ?? ""}
                onChange={(e) => onChange({ ...values, [v]: e.target.value })}
                placeholder={`example ${v.toLowerCase().replace(/_/g, " ")}`}
              />
            </label>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** Facts about the template, including the ones a caller needs to send it. */
export function DetailsPanel({
  template,
  variables,
  onClose,
}: {
  template: Template;
  variables: string[];
  onClose: () => void;
}) {
  const snippet = `POST /api/v1/emails
Authorization: Bearer mv_live_…

${JSON.stringify(
  {
    to: ["someone@example.com"],
    template: template.slug,
    ...(variables.length
      ? { variables: Object.fromEntries(variables.map((v) => [v, "…"])) }
      : {}),
  },
  null,
  2,
)}`;

  return (
    <Sheet
      title="Details"
      onClose={onClose}
      footer={
        <button className="primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>Slug</dt>
          <dd className="mono">{template.slug}</dd>
          <dt>Id</dt>
          <dd className="mono small">{template.id}</dd>
          <dt>Default sender</dt>
          <dd className="mono small">{template.fromAddress || "chosen at send time"}</dd>
          <dt>Reply-To</dt>
          <dd className="mono small">{template.replyTo || "the sending mailbox"}</dd>
          <dt>Variables</dt>
          <dd className="mono small">{variables.join(", ") || "none"}</dd>
          <dt>Created</dt>
          <dd className="small">{absoluteTime(template.createdAt)}</dd>
          <dt>Updated</dt>
          <dd className="small">{absoluteTime(template.updatedAt)}</dd>
        </dl>

        <div>
          <h3>Sending it</h3>
          <p className="small muted">The slug is how the API refers to this template.</p>
          <pre className="body-plain">{snippet}</pre>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Send the template to a real address.
 *
 * Sends through the ordinary send path rather than a preview-only shortcut, so
 * what arrives is what a recipient would get — including the sanitiser, the
 * DKIM signature and the suppression list.
 */
export function TestEmailPanel({
  template,
  mailboxes,
  variables,
  values,
  onClose,
}: {
  template: Template;
  mailboxes: { id: string; address: string }[];
  variables: string[];
  values: Record<string, string>;
  onClose: () => void;
}) {
  const toast = useToast();
  // Nothing preselected. A test send is a deliberate act, and defaulting the
  // sender to whichever mailbox happened to be first invites sending as one
  // nobody chose.
  const [mailboxId, setMailboxId] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.send({
        mailboxId,
        to,
        // Deliberately no subject: the template has one, and an empty string
        // would win over it rather than falling through.
        template: template.slug,
        // Unfilled placeholders stay visible in the delivered mail rather than
        // rendering as blanks, so a missing one is obvious in the inbox.
        variables: Object.fromEntries(variables.map((v) => [v, values[v] || `{{${v}}}`])),
      });
      toast(`Sent to ${to}`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Send a test"
      onClose={onClose}
      footer={
        <>
          <button className="primary" onClick={send} disabled={busy || !to || !mailboxId}>
            {busy ? "Sending" : "Send test"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="stack">
        {error && <div className="notice bad">{error}</div>}

        <label className="field">
          <span>From</span>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            <option value="">Choose a mailbox…</option>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>To</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="you@example.com"
            autoFocus
          />
          <span className="hint">
            A real send: it counts against the mailbox's daily limit and appears in the log.
          </span>
        </label>

        {variables.length > 0 && (
          <div className="notice">
            {Object.keys(values).length
              ? "Uses the values from the Variables panel."
              : "No variable values set, so placeholders will arrive as written."}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Previous states, newest first, each restorable. */
export function HistoryPanel({
  template,
  onRestored,
  onClose,
}: {
  template: Template;
  onRestored: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const list = useAsync(() => api.templateVersions(template.id), [template.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versions = list.data;

  async function restore(v: TemplateVersion) {
    setBusy(v.id);
    setError(null);
    try {
      await api.restoreTemplateVersion(template.id, v.id);
      toast("Restored");
      onRestored();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      title="Version history"
      onClose={onClose}
      footer={
        <button className="primary" onClick={onClose}>
          Close
        </button>
      }
    >
      {(error ?? list.error) && <div className="notice bad">{error ?? list.error}</div>}

      {list.loading ? (
        <div className="skeleton" style={{ height: 14, width: 200 }} />
      ) : (versions ?? []).length === 0 ? (
        <p className="small muted">
          No history yet. Each save records what the template was beforehand, so this fills up as
          you edit.
        </p>
      ) : (
        <ol className="versions">
          {(versions ?? []).map((v) => (
            <li key={v.id}>
              <div className="versions-when">
                <span className="cell-strong small">{relativeTime(v.createdAt)}</span>
                <span className="small muted">{absoluteTime(v.createdAt)}</span>
              </div>
              <div className="versions-what small muted truncate">
                {v.subject || "(no subject)"} · saved over by {v.actorEmail || "someone"}
              </div>
              <button className="sm" onClick={() => restore(v)} disabled={busy !== null}>
                {busy === v.id ? "Restoring" : "Restore"}
              </button>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
