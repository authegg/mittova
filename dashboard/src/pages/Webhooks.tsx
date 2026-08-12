import { useState, type FormEvent } from "react";
import { api, type Webhook } from "../api";
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
                  <th style={{ width: 150 }} />
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
                      </td>
                      <td>
                        <Badge tone={h.enabled ? "ok" : "neutral"}>
                          {h.enabled ? "active" : "paused"}
                        </Badge>
                      </td>
                      <td>
                        <div className="row">
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

      {creating && (
        <CreateHook
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            state.reload();
            toast("Endpoint added");
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

function CreateHook({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [url, setUrl] = useState("https://");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createWebhook(url, selected.length ? selected : ["*"]);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Add endpoint"
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="new-hook" type="submit" disabled={busy}>
            {busy ? "Adding" : "Add endpoint"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="new-hook" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>Endpoint URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} className="mono" autoFocus />
          <span className="hint">Must be https. Requests time out after 10 seconds.</span>
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
      </form>
    </Sheet>
  );
}
