import { useState, type FormEvent } from "react";
import { api, activeOrg, type Suppression } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  Card,
  Confirm,
  EmptyState,
  Sheet,
  TableSkeleton,
  absoluteTime,
  compactTime,
  Pager,
} from "../components/ui";
import { usePaged } from "../hooks-paging";
import Icon from "../components/Icon";

const REASON_TONE = { bounce: "bad", complaint: "warn", manual: "neutral" } as const;

const REASON_TEXT = {
  bounce: "The receiving server rejected mail to this address as undeliverable.",
  complaint: "The recipient marked mail from this sender as spam.",
  manual: "Blocked by hand.",
} as const;

export default function Suppressions({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const toast = useToast();
  const list = useAsync(() => api.suppressions(), []);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Suppression | null>(null);
  const [q, setQ] = useState("");

  // Only the all-orgs view mixes tenants, so only there is the org worth a column.
  const acrossOrgs = isPlatformAdmin && !activeOrg();
  const orgs = useAsync(() => (acrossOrgs ? api.orgs() : Promise.resolve([])), [acrossOrgs]);
  const orgName = new Map((orgs.data ?? []).map((o) => [o.id, o.name]));

  // Filtered here rather than by the API: the list is one tenant's blocks, not a mailbox.
  const needle = q.trim().toLowerCase();
  const rows = (list.data ?? []).filter(
    (s) =>
      !needle || s.email.toLowerCase().includes(needle) || s.detail.toLowerCase().includes(needle),
  );
  const paged = usePaged(rows);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Suppressions</h1>
          <p>
            Addresses Mittova refuses to send to. Sending to a known bounce or complaint is what
            destroys a domain&rsquo;s reputation, so these are blocked before the message reaches
            Cloudflare.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Block address
        </button>
      </div>

      {(list.data ?? []).length > 0 && (
        <div className="toolbar">
          <div className="search grow">
            <Icon name="search" size={14} />
            <input
              placeholder="Search address or detail"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search suppressions"
            />
          </div>
        </div>
      )}

      <Card tight>
        {list.loading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : rows.length === 0 && needle ? (
          <EmptyState
            icon="block"
            title="No matches"
            body="Nothing matches that search."
            action={<button onClick={() => setQ("")}>Clear search</button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="block"
            title="Nothing suppressed"
            body="Addresses land here automatically when Cloudflare reports a hard bounce, or you can block one by hand."
            action={
              <button className="primary" onClick={() => setAdding(true)}>
                Block an address
              </button>
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 280 }}>Address</th>
                    {acrossOrgs && <th style={{ width: 160 }}>Organization</th>}
                    <th style={{ width: 120 }}>Reason</th>
                    <th>Detail</th>
                    <th style={{ width: 170 }} className="num">
                      Added
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((s) => (
                    <tr
                      key={s.id}
                      className="clickable"
                      tabIndex={0}
                      aria-label={`${s.email}, ${s.reason}. Open details`}
                      onClick={() => setOpen(s)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpen(s);
                        }
                      }}
                    >
                      <td className="mono small cell-strong truncate">{s.email}</td>
                      {acrossOrgs && (
                        <td className="small truncate">{orgName.get(s.orgId) ?? "—"}</td>
                      )}
                      <td>
                        <Badge tone={REASON_TONE[s.reason]}>{s.reason}</Badge>
                      </td>
                      <td className="small muted truncate">{s.detail || "—"}</td>
                      <td className="num small muted">{compactTime(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={paged.page}
              pageCount={paged.pageCount}
              total={paged.total}
              shown={paged.slice.length}
              onPage={paged.setPage}
            />
          </>
        )}
      </Card>

      {open && (
        <SuppressionSheet
          suppression={open}
          orgName={acrossOrgs ? orgName.get(open.orgId) : undefined}
          onClose={() => setOpen(null)}
          onUnblocked={() => {
            setOpen(null);
            list.reload();
            toast(`${open.email} unblocked`);
          }}
        />
      )}

      {adding && (
        <AddSuppression
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            list.reload();
            toast("Address blocked");
          }}
        />
      )}
    </>
  );
}

function SuppressionSheet({
  suppression: s,
  orgName,
  onClose,
  onUnblocked,
}: {
  suppression: Suppression;
  orgName?: string;
  onClose: () => void;
  onUnblocked: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function unblock() {
    setConfirming(false);
    setBusy(true);
    try {
      await api.deleteSuppression(s.id);
      onUnblocked();
    } catch (err) {
      toast((err as Error).message, "bad");
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={s.email}
      subtitle={<Badge tone={REASON_TONE[s.reason]}>{s.reason}</Badge>}
      onClose={onClose}
      footer={
        <>
          <button
            className="danger"
            disabled={busy}
            // A manual block is cheap to redo; a bounce or complaint is evidence
            // that mailing the address again costs the domain reputation.
            onClick={() => (s.reason === "manual" ? unblock() : setConfirming(true))}
          >
            {busy ? "Unblocking" : "Unblock"}
          </button>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(s.email);
              toast("Address copied");
            }}
          >
            Copy address
          </button>
        </>
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>Reason</dt>
          <dd>{REASON_TEXT[s.reason]}</dd>
          {orgName && (
            <>
              <dt>Organization</dt>
              <dd>{orgName}</dd>
            </>
          )}
          <dt>Added</dt>
          <dd>{absoluteTime(s.createdAt)}</dd>
        </dl>
        <div className="field">
          <span>Detail</span>
          <pre className="body-plain">{s.detail || "No detail was recorded."}</pre>
        </div>
      </div>

      {confirming && (
        <Confirm
          title={`Unblock ${s.email}?`}
          body={
            s.reason === "bounce"
              ? "This address bounced. Mailing it again will likely bounce again, and repeated bounces hurt the sending domain's reputation."
              : "This recipient reported mail as spam. Mailing them again risks another complaint, which hurts the sending domain's reputation."
          }
          confirmLabel="Unblock"
          onCancel={() => setConfirming(false)}
          onConfirm={unblock}
        />
      )}
    </Sheet>
  );
}

function AddSuppression({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("manual");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createSuppression(email, reason, detail);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Block an address"
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="new-supp" type="submit" disabled={busy}>
            {busy ? "Blocking" : "Block address"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="new-supp" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            className="mono"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="manual">Manual block</option>
            <option value="bounce">Hard bounce</option>
            <option value="complaint">Spam complaint</option>
          </select>
        </label>
        <label className="field">
          <span>Detail</span>
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Mailbox does not exist"
          />
        </label>
      </form>
    </Sheet>
  );
}
