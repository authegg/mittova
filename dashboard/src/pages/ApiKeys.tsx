import { useState, type FormEvent } from "react";
import { api, type ApiKey, type Mailbox } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  Sheet,
  TableSkeleton,
  absoluteTime,
  compactTime,
  relativeTime,
} from "../components/ui";
import Icon from "../components/Icon";

function CreateSheet({
  mailboxes,
  onClose,
  onCreated,
}: {
  mailboxes: Mailbox[];
  onClose: () => void;
  onCreated: (key: ApiKey) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"full" | "sending">("sending");
  const [restrict, setRestrict] = useState(mailboxes[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createApiKey(name, scope, scope === "sending" ? restrict : null));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Create API key"
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="new-key" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating" : "Create key"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="new-key" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Billing service"
            autoFocus
          />
          <span className="hint">Shown in the key list so you know what to revoke later.</span>
        </label>

        <label className="field">
          <span>Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as "full" | "sending")}>
            <option value="sending">Restricted — one mailbox only</option>
            <option value="full">Full — may send as any mailbox</option>
          </select>
          <span className="hint">
            Restricted keys are the safer default. A leaked full key can send as every address on
            the domain.
          </span>
        </label>

        {scope === "sending" && (
          <label className="field">
            <span>Mailbox</span>
            <select value={restrict} onChange={(e) => setRestrict(e.target.value)}>
              {mailboxes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.address}
                </option>
              ))}
            </select>
          </label>
        )}
      </form>
    </Sheet>
  );
}

function RevealSheet({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  return (
    <Sheet
      title="Key created"
      onClose={onClose}
      footer={
        <button className="primary" onClick={onClose}>
          I have stored it
        </button>
      }
    >
      <div className="stack">
        <div className="notice">
          This is the only time the key is shown. Only a SHA-256 hash is stored, so it cannot be
          recovered — create a new one if you lose it.
        </div>
        <label className="field">
          <span>{apiKey.name}</span>
          <div className="row">
            <input
              readOnly
              value={apiKey.plaintext ?? ""}
              className="mono"
              onFocus={(e) => e.target.select()}
            />
            <CopyButton value={apiKey.plaintext ?? ""} />
          </div>
        </label>

        <h3>Send an email with it</h3>
        {/* Origin, not a hardcoded host: this ships to anyone self-hosting. */}
        <pre className="body-plain">{`curl -X POST ${window.location.origin}/api/v1/emails \\
  -H "Authorization: Bearer ${apiKey.plaintext}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "someone@example.com",
    "subject": "Hello from Mittova",
    "text": "Sent through the API."
  }'`}</pre>
      </div>
    </Sheet>
  );
}

export default function ApiKeys({ mailboxes }: { mailboxes: Mailbox[] }) {
  const toast = useToast();
  const keys = useAsync(() => api.apiKeys(), []);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<ApiKey | null>(null);
  const [confirming, setConfirming] = useState<ApiKey | null>(null);

  const byId = new Map(mailboxes.map((m) => [m.id, m.address]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API keys</h1>
          <p>
            Bearer tokens for the programmatic send endpoint at{" "}
            <span className="mono">/api/v1/emails</span>. Separate from the dashboard password.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => setCreating(true)}
          disabled={mailboxes.length === 0}
        >
          <Icon name="plus" size={14} /> Create key
        </button>
      </div>

      <Card tight>
        {keys.loading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : (keys.data ?? []).length === 0 ? (
          <EmptyState
            icon="key"
            title="No API keys"
            body="Create a key to send mail from a script, a backend service, or a CI job without using the dashboard password."
            action={
              <button className="primary" onClick={() => setCreating(true)}>
                Create your first key
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 190 }}>Key</th>
                  <th style={{ width: 210 }}>Scope</th>
                  <th style={{ width: 130 }}>Last used</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {(keys.data ?? []).map((k) => (
                  <tr key={k.id}>
                    <td className="cell-strong">
                      {k.name}
                      <div className="small muted">created {compactTime(k.createdAt)}</div>
                    </td>
                    <td className="mono small muted">{k.preview}</td>
                    <td>
                      {k.scope === "full" ? (
                        <Badge tone="warn">any mailbox</Badge>
                      ) : (
                        <span className="mono small">
                          {k.restrictMailboxId
                            ? (byId.get(k.restrictMailboxId) ?? "deleted mailbox")
                            : "—"}
                        </span>
                      )}
                    </td>
                    <td className="small muted">
                      {k.lastUsedAt ? relativeTime(k.lastUsedAt) : "never"}
                    </td>
                    <td>
                      <button className="danger sm" onClick={() => setConfirming(k)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreateSheet
          mailboxes={mailboxes}
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setRevealed(k);
            keys.reload();
          }}
        />
      )}

      {revealed && <RevealSheet apiKey={revealed} onClose={() => setRevealed(null)} />}

      {confirming && (
        <Sheet
          title="Revoke this key"
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button
                className="danger"
                onClick={async () => {
                  await api.deleteApiKey(confirming.id);
                  setConfirming(null);
                  keys.reload();
                  toast("Key revoked");
                }}
              >
                Revoke {confirming.name}
              </button>
              <button onClick={() => setConfirming(null)}>Cancel</button>
            </>
          }
        >
          <p>
            Any service still presenting <span className="mono">{confirming.preview}</span> will
            start getting 401 responses immediately. This cannot be undone.
          </p>
        </Sheet>
      )}
    </>
  );
}
