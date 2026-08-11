import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type DomainStatus, type RecordCheck } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  Sheet,
  TableSkeleton,
  absoluteTime,
} from "../components/ui";
import Icon from "../components/Icon";

const SERVICE_LABEL: Record<RecordCheck["service"], string> = {
  routing: "Receiving mail",
  sending: "Sending mail",
  policy: "Policy",
};

/**
 * `:account` is a Cloudflare placeholder their dashboard resolves against
 * whoever is signed in, so the link works without us knowing the account id.
 */
function cloudflareEmailUrl(domain: string): string {
  return `https://dash.cloudflare.com/?to=/:account/${domain}/email/routing`;
}

function RecordRow({ record }: { record: RecordCheck }) {
  const present = record.found.length > 0;
  return (
    <tr>
      <td className="mono small" style={{ width: 52 }}>
        {record.type}
      </td>
      <td style={{ width: 240 }}>
        <div className="mono small cell-strong truncate" title={record.name}>
          {record.name}
        </div>
        <div className="small muted">{record.purpose}</div>
      </td>
      <td>
        {present ? (
          <div className="row" style={{ gap: 6 }}>
            <code className="record-value" title={record.found.join("\n")}>
              {record.found.join("  ·  ")}
            </code>
            <CopyButton value={record.found.join("\n")} />
          </div>
        ) : (
          <span className="small muted">
            Not published yet. Cloudflare writes it when the service is enabled. Expected{" "}
            <span className="mono">{record.expected}</span>
          </span>
        )}
      </td>
      <td style={{ width: 88 }}>
        <Badge tone={record.status === "ok" ? "ok" : record.status === "missing" ? "bad" : "warn"}>
          {record.status}
        </Badge>
      </td>
    </tr>
  );
}

function DomainPanel({
  status,
  open,
  onToggle,
  onRemove,
}: {
  status: DomainStatus;
  open: boolean;
  onToggle: () => void;
  onRemove: (domain: string) => void;
}) {
  const { ok, total, healthy } = status.summary;

  return (
    <section className="card domain">
      {/* Collapsed by default: seven records per domain is a wall of text when
          all you want to know is whether the domain is healthy. */}
      <button className="domain-head" onClick={onToggle} aria-expanded={open}>
        <span className={`domain-chevron${open ? " open" : ""}`} aria-hidden="true" />
        <span className="domain-name mono">{status.domain}</span>
        <Badge tone={healthy ? "ok" : "bad"}>
          {ok}/{total} records
        </Badge>
        {!status.zoneId && <Badge tone="warn">zone not found</Badge>}
        <span className="grow" />
        <span className="small muted">{open ? "Hide" : "Details"}</span>
      </button>

      {open && (
        <div className="domain-body stack">
          {!healthy && (
            <div className="notice bad">
              {total - ok} record{total - ok > 1 ? "s are" : " is"} not published. Enable Email
              Routing and Email Sending for this domain and Cloudflare adds them for you.{" "}
              <a href={cloudflareEmailUrl(status.domain)} target="_blank" rel="noreferrer">
                Open in Cloudflare
              </a>
            </div>
          )}

          {(["routing", "sending", "policy"] as const).map((service) => {
            const records = status.records.filter((r) => r.service === service);
            if (records.length === 0) return null;
            return (
              <div key={service} className="stack" style={{ gap: 6 }}>
                <h3>{SERVICE_LABEL[service]}</h3>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {records.map((r) => (
                        <RecordRow key={`${r.type}-${r.name}`} record={r} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          <div className="spread">
            <span className="small muted">
              Checked {absoluteTime(status.checkedAt)} over public DNS
              {status.zoneId ? " · routing rules automated" : ""}
            </span>
            <button className="danger sm" onClick={() => onRemove(status.domain)}>
              Remove domain
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface AddResult {
  domain: string;
  zoneId: string;
  sending: { configured: boolean; error?: string };
  receiving: boolean;
}

function AddDomain({ onClose, onAdded }: { onClose: () => void; onAdded: (r: AddResult) => void }) {
  const [domain, setDomain] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.addDomain(domain, zoneId));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Add a domain"
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="add-domain" type="submit" disabled={busy}>
            {busy ? "Adding" : "Add domain"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="add-domain" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}

        <label className="field">
          <span>Domain</span>
          <input
            className="mono"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
            autoFocus
            required
          />
          <span className="hint">Must already use Cloudflare DNS.</span>
        </label>

        <label className="field">
          <span>
            Cloudflare zone id <span className="muted">optional</span>
          </span>
          <input
            className="mono"
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            placeholder="found automatically"
          />
          <span className="hint">
            Only needed if your API token cannot see the zone. It is on the domain&rsquo;s overview
            page in Cloudflare, right-hand column.
          </span>
        </label>

        <div className="hint">Mittova will tell you what is left to do once it is added.</div>
      </form>
    </Sheet>
  );
}

/** What happened, and what is left for the operator to do. */
function AddOutcome({
  result,
  onClose,
  onVerified,
}: {
  result: AddResult;
  onClose: () => void;
  onVerified: () => void;
}) {
  const sendingOk = Boolean(result.zoneId) && result.sending.configured && !result.sending.error;
  const [receiving, setReceiving] = useState(result.receiving);
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const status = await api.checkDomain(result.domain);
      const on = status.records
        .filter((r) => r.service === "routing")
        .every((r) => r.status === "ok");
      setReceiving(on);
      if (on) onVerified();
    } catch {
      // Leave the step as it was; the operator can try again.
    } finally {
      setChecking(false);
    }
  }, [result.domain, onVerified]);

  // Turning on Email Routing happens in the Cloudflare dashboard, in another
  // tab. Coming back to this one is the signal that it may now be done, so the
  // checklist catches up on its own rather than lying until it is dismissed.
  useEffect(() => {
    if (receiving) return;
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [receiving, recheck]);

  return (
    <Sheet
      title={`${result.domain} added`}
      onClose={onClose}
      footer={
        <button className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <ol className="steps">
        <li className="done">
          <strong>Domain added</strong>
          <span>Mailboxes can now be created on {result.domain}.</span>
        </li>

        <li className={sendingOk ? "done" : "todo"}>
          <strong>Sending</strong>
          {sendingOk ? (
            <span>
              Onboarded automatically. Cloudflare wrote the SPF, DKIM, DMARC and bounce records.
            </span>
          ) : !result.zoneId ? (
            <span>
              Skipped: Mittova could not find a Cloudflare zone for {result.domain}. Give the zone
              id, or widen the API token to cover this zone, and sending onboards automatically.
            </span>
          ) : (
            <span>Could not onboard: {result.sending.error}</span>
          )}
        </li>

        <li className={receiving ? "done" : "todo"}>
          <strong>Receiving</strong>
          {receiving ? (
            <span>Email Routing is on. Mail to {result.domain} reaches Mittova.</span>
          ) : (
            <span>
              Turn on Email Routing in Cloudflare. This is the one step that cannot be automated —
              the enable endpoint rejects scoped API tokens.{" "}
              <a href={cloudflareEmailUrl(result.domain)} target="_blank" rel="noreferrer">
                Open Email Routing for {result.domain}
              </a>
              <span className="row" style={{ marginTop: 10 }}>
                <button className="sm" onClick={() => void recheck()} disabled={checking}>
                  {checking ? "Checking" : "Check again"}
                </button>
                <span className="small muted">Rechecked automatically when you come back.</span>
              </span>
            </span>
          )}
        </li>
      </ol>

      {!receiving && (
        <div className="notice" style={{ marginTop: 16 }}>
          Until receiving is on, mail to this domain will not reach Mittova. DNS can take a minute
          to publish after you enable it.
        </div>
      )}
    </Sheet>
  );
}

export default function Domains() {
  const toast = useToast();
  // Cached results are fine on mount, but Re-check DNS has to bypass the cache,
  // otherwise the button appears to do nothing right after enabling a service.
  const bypassCache = useRef(false);
  const state = useAsync(() => {
    const fresh = bypassCache.current;
    bypassCache.current = false;
    return api.domains(fresh);
  }, []);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<AddResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const domains = state.data ?? [];

  function recheck() {
    bypassCache.current = true;
    state.reload();
  }

  async function remove(domain: string) {
    try {
      await api.removeDomain(domain);
      toast(`${domain} removed`);
      state.reload();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{domains.length > 1 ? "Domains" : "Domain"}</h1>
          <p>
            Resolved over public DNS, so this is what receiving mail servers actually see rather
            than what Cloudflare has stored.
          </p>
        </div>
        <div className="row">
          <button onClick={recheck} disabled={state.loading}>
            {state.loading ? "Checking" : "Re-check DNS"}
          </button>
          <button className="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add domain
          </button>
        </div>
      </div>

      {state.error && <div className="notice bad">{state.error}</div>}

      {state.loading && domains.length === 0 ? (
        <Card tight>
          <TableSkeleton rows={5} cols={4} />
        </Card>
      ) : domains.length === 0 ? (
        <Card>
          <EmptyState
            icon="globe"
            title="No domains configured"
            body="Add a domain to start creating mailboxes on it."
            action={
              <button className="primary" onClick={() => setAdding(true)}>
                Add a domain
              </button>
            }
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {domains.map((d) => (
            <DomainPanel
              key={d.domain}
              status={d}
              open={open === d.domain}
              onToggle={() => setOpen(open === d.domain ? null : d.domain)}
              onRemove={remove}
            />
          ))}
        </div>
      )}

      {adding && (
        <AddDomain
          onClose={() => setAdding(false)}
          onAdded={(r) => {
            setAdding(false);
            setOutcome(r);
            recheck();
          }}
        />
      )}

      {outcome && (
        <AddOutcome result={outcome} onClose={() => setOutcome(null)} onVerified={recheck} />
      )}
    </>
  );
}
