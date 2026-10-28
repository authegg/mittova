import { useState, type FormEvent } from "react";
import { activeOrg, api, type Webhook } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  Sheet,
  TableSkeleton,
  relativeTime,
} from "../components/ui";
import Icon from "../components/Icon";

const EVENTS = ["email.received", "email.sent", "email.delivery_failed"];

export default function Webhooks() {
  const toast = useToast();
  const state = useAsync(() => api.webhooks(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [inspecting, setInspecting] = useState<Webhook | null>(null);

  const hooks = state.data?.webhooks ?? [];
  const deliveries = state.data?.deliveries ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Webhooks</h1>
          <p>
            Mittova POSTs a JSON body to your endpoint whenever mail is received or sent, signed
            with HMAC-SHA256 in the <span className="mono">X-Mittova-Signature</span> header.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> Add endpoint
        </button>
      </div>

      <Card title="Endpoints" tight>
        {state.loading ? (
          <TableSkeleton rows={2} cols={4} />
        ) : hooks.length === 0 ? (
          <EmptyState
            icon="relay"
            title="No endpoints"
            body="Point Mittova at an HTTPS URL to get a callback the moment mail arrives, instead of polling this dashboard."
            action={
              <button className="primary" onClick={() => setCreating(true)}>
                Add an endpoint
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th style={{ width: 230 }}>Events</th>
                  <th style={{ width: 90 }}>State</th>
                  <th className="actions" style={{ width: 270 }} />
                </tr>
              </thead>
              <tbody>
                {hooks.map((h) => {
                  let types: string[] = ["*"];
                  try {
                    types = JSON.parse(h.eventTypes);
                  } catch {
                    /* stored value is malformed; fall back to all */
                  }
                  return (
                    <tr key={h.id}>
                      <td className="mono small truncate cell-strong">{h.url}</td>
                      <td className="small muted">
                        {types.includes("*") ? "all events" : types.join(", ")}
                        {h.addresses && (
                          <div className="truncate">{parseList(h.addresses).join(", ")}</div>
                        )}
                      </td>
                      <td>
                        <Badge tone={h.enabled ? "ok" : "neutral"}>
                          {h.enabled ? "active" : "paused"}
                        </Badge>
                      </td>
                      <td className="actions">
                        <div className="row">
                          <button className="sm" onClick={() => setEditing(h)}>
                            Edit
                          </button>
                          <button className="sm" onClick={() => setInspecting(h)}>
                            Secret
                          </button>
                          <button
                            className="sm"
                            onClick={async () => {
                              await api.updateWebhook(h.id, { enabled: !h.enabled });
                              state.reload();
                            }}
                          >
                            {h.enabled ? "Pause" : "Resume"}
                          </button>
                          <button
                            className="danger sm"
                            aria-label="Remove endpoint"
                            onClick={async () => {
                              await api.deleteWebhook(h.id);
                              state.reload();
                              toast("Endpoint removed");
                            }}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ height: 20 }} />

      <Card title="Recent deliveries" tight>
        {deliveries.length === 0 ? (
          <div className="empty small">
            No deliveries yet. They appear here as soon as an event fires.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Event</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th style={{ width: 90 }} className="num">
                    Duration
                  </th>
                  <th>Result</th>
                  <th style={{ width: 100 }} className="num">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const good = d.statusCode !== null && d.statusCode >= 200 && d.statusCode < 300;
                  return (
                    <tr key={d.id}>
                      <td className="mono small">{d.eventType}</td>
                      <td>
                        <Badge tone={good ? "ok" : "bad"}>{d.statusCode ?? "error"}</Badge>
                      </td>
                      <td className="num small muted">{d.durationMs ?? "—"} ms</td>
                      <td className="small muted truncate">{d.error ?? "delivered"}</td>
                      <td className="num small muted">{relativeTime(d.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(creating || editing) && (
        <HookSheet
          hook={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            toast(editing ? "Endpoint updated" : "Endpoint added");
            setCreating(false);
            setEditing(null);
            state.reload();
          }}
        />
      )}

      {inspecting && (
        <Sheet
          title="Signing secret"
          subtitle={inspecting.url}
          onClose={() => setInspecting(null)}
          footer={<button onClick={() => setInspecting(null)}>Close</button>}
        >
          <div className="stack">
            <div className="row">
              <input
                readOnly
                className="mono"
                value={inspecting.secret}
                onFocus={(e) => e.target.select()}
              />
              <CopyButton value={inspecting.secret} />
            </div>
            <h3>Verifying a request</h3>
            <pre className="body-plain">{`const expected = crypto
  .createHmac("sha256", "${inspecting.secret}")
  .update(rawRequestBody)
  .digest("hex");

// header arrives as: sha256=<hex>
const provided = req.headers["x-mittova-signature"].slice(7);
const valid = crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(provided),
);`}</pre>
            <div className="hint">
              Compute the HMAC over the raw request body before any JSON parsing — re-serialising
              changes the bytes and the signature will not match.
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}

function parseList(json: string | null | undefined): string[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function HookSheet({
  hook,
  onClose,
  onSaved,
}: {
  hook: Webhook | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(hook?.url ?? "https://");
  const [selected, setSelected] = useState<string[]>(() =>
    parseList(hook?.eventTypes).filter((t) => t !== "*"),
  );
  const [addresses, setAddresses] = useState<string[]>(() => parseList(hook?.addresses));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mailboxState = useAsync(() => api.mailboxes(), []);

  // Only the endpoint's own org: its webhook never hears another tenant's mail.
  const targetOrg = hook?.orgId || activeOrg();
  const choices = (mailboxState.data ?? []).filter((m) => m.orgId === targetOrg);
  // A listed address whose mailbox is gone can never fire; saving drops it.
  const kept = addresses.filter((a) => choices.some((m) => m.address === a));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const events = selected.length ? selected : ["*"];
    try {
      if (hook) await api.updateWebhook(hook.id, { eventTypes: events, addresses: kept });
      else await api.createWebhook(url, events, kept);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={hook ? "Edit endpoint" : "Add endpoint"}
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="new-hook" type="submit" disabled={busy}>
            {hook ? (busy ? "Saving" : "Save") : busy ? "Adding" : "Add endpoint"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="new-hook" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>Endpoint URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="mono"
            readOnly={Boolean(hook)}
            autoFocus={!hook}
          />
          <span className="hint">
            {hook
              ? "To point at a different URL, add a new endpoint and remove this one."
              : "Must be https. Requests time out after 10 seconds."}
          </span>
        </label>

        <div className="field">
          <span>Events</span>
          <div className="stack" style={{ gap: 6 }}>
            {EVENTS.map((ev) => (
              <label key={ev} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={selected.includes(ev)}
                  onChange={(e) =>
                    setSelected((s) => (e.target.checked ? [...s, ev] : s.filter((x) => x !== ev)))
                  }
                />
                <span className="mono small">{ev}</span>
              </label>
            ))}
          </div>
          <span className="hint">Select none to receive every event type.</span>
        </div>

        <div className="field">
          <span>Mailboxes</span>
          {mailboxState.loading ? (
            <span className="hint">Loading mailboxes…</span>
          ) : choices.length === 0 ? (
            <span className="hint">
              {targetOrg
                ? "This organization has no mailboxes yet."
                : "Choose an organization in the switcher to limit this to its mailboxes."}
            </span>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {choices.map((m) => (
                <label key={m.id} className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={addresses.includes(m.address)}
                    onChange={(e) =>
                      setAddresses((s) =>
                        e.target.checked ? [...s, m.address] : s.filter((x) => x !== m.address),
                      )
                    }
                  />
                  <span className="mono small">{m.address}</span>
                </label>
              ))}
            </div>
          )}
          <span className="hint">Select none to hear about mail to every mailbox.</span>
        </div>
      </form>
    </Sheet>
  );
}
