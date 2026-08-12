import { useState, type FormEvent } from "react";
import { api, type Mailbox } from "../api";
import { useToast } from "../hooks";
import { Badge, Card, EmptyState, Sheet, absoluteTime, compactTime, Pager } from "../components/ui";
import { usePaged } from "../hooks-paging";
import Icon from "../components/Icon";

export default function Settings({
  mailboxes,
  domains,
  reload,
}: {
  mailboxes: Mailbox[];
  domains: string[];
  reload: () => void;
}) {
  const domain = domains[0] ?? "";
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const paged = usePaged(mailboxes);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [deleting, setDeleting] = useState<Mailbox | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mailboxes</h1>
          <p>
            Mailboxes on <span className="mono">{domain}</span> and the daily send cap that limits
            the damage if one is ever compromised.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New mailbox
        </button>
      </div>

      <div className="notice" style={{ marginBottom: 18 }}>
        A mailbox only receives once Cloudflare has an Email Routing rule pointing it at the{" "}
        <span className="mono">mittova</span> Worker. With a scoped{" "}
        <span className="mono">CF_API_TOKEN</span> secret set, Mittova creates and removes that rule
        for you and the Routing column reflects live Cloudflare state; without it, add the rule by
        hand or mail to the address is rejected with a 550.
      </div>

      <Card title="Mailboxes" tight>
        {mailboxes.length === 0 ? (
          <EmptyState
            icon="tray"
            title="No mailboxes"
            body="Create one to start receiving and sending mail on this domain."
            action={
              <button className="primary" onClick={() => setCreating(true)}>
                Create a mailbox
              </button>
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 250 }}>Address</th>
                    <th style={{ width: 110 }}>Routing</th>
                    <th style={{ width: 160 }}>24h usage</th>
                    <th>Lifetime</th>
                    <th style={{ width: 150 }} className="num">
                      Created
                    </th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((m) => {
                    const pct = Math.min(
                      100,
                      Math.round((m.sent24h / Math.max(1, m.dailySendLimit)) * 100),
                    );
                    return (
                      <tr key={m.id}>
                        <td className="mono small cell-strong truncate">{m.address}</td>
                        <td>
                          {m.routed === null ? (
                            <span className="small muted">unknown</span>
                          ) : m.routed ? (
                            <Badge tone="ok">receiving</Badge>
                          ) : (
                            <Badge tone="bad">no rule</Badge>
                          )}
                        </td>
                        <td>
                          <div className="small">
                            {m.sent24h} / {m.dailySendLimit}
                          </div>
                          <div
                            style={{
                              height: 3,
                              borderRadius: 2,
                              background: "var(--line)",
                              marginTop: 4,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${pct}%`,
                                height: "100%",
                                background: pct >= 100 ? "var(--bad-ink)" : "var(--ink-3)",
                              }}
                            />
                          </div>
                        </td>
                        <td className="small muted">
                          {m.received} received · {m.sent} sent
                        </td>
                        <td className="num small muted">{compactTime(m.createdAt)}</td>
                        <td>
                          <div className="row">
                            <button className="sm" onClick={() => setEditing(m)}>
                              Edit
                            </button>
                            <button className="danger sm" onClick={() => setDeleting(m)}>
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

      {creating && (
        <MailboxForm
          domains={domains}
          mailbox={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
            toast("Mailbox created. Add the routing rule next.");
          }}
        />
      )}

      {editing && (
        <MailboxForm
          domains={domains}
          mailbox={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            toast("Mailbox updated");
          }}
        />
      )}

      {deleting && (
        <Sheet
          title={`Delete ${deleting.address}`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button
                className="danger"
                onClick={async () => {
                  await api.deleteMailbox(deleting.id);
                  setDeleting(null);
                  reload();
                  toast("Mailbox deleted");
                }}
              >
                Delete mailbox and messages
              </button>
              <button onClick={() => setDeleting(null)}>Cancel</button>
            </>
          }
        >
          <div className="stack">
            <div className="notice bad">
              This deletes {deleting.received + deleting.sent} stored messages along with the
              mailbox. It cannot be undone.
            </div>
            <p>
              {deleting.routingRuleId ? (
                <>
                  Its Cloudflare routing rule is removed at the same time, so mail to{" "}
                  <span className="mono">{deleting.address}</span> stops being accepted rather than
                  bouncing.
                </>
              ) : (
                <>
                  This mailbox has no routing rule recorded. If one exists in Cloudflare, remove it
                  by hand, or mail to <span className="mono">{deleting.address}</span> will be
                  rejected with a 550.
                </>
              )}
            </p>
          </div>
        </Sheet>
      )}
    </>
  );
}

function MailboxForm({
  domains,
  mailbox,
  onClose,
  onSaved,
}: {
  domains: string[];
  mailbox: Mailbox | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [local, setLocal] = useState(mailbox?.address.split("@")[0] ?? "");
  const [domain, setDomain] = useState(mailbox?.address.split("@")[1] ?? domains[0] ?? "");
  const [name, setName] = useState(mailbox?.name ?? "");
  const [limit, setLimit] = useState(String(mailbox?.dailySendLimit ?? 200));
  const [replyTo, setReplyTo] = useState(mailbox?.replyTo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mailbox) {
        await api.updateMailbox(mailbox.id, { name, dailySendLimit: Number(limit), replyTo });
      } else {
        await api.createMailbox(local, name || local, Number(limit), domain, replyTo);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={mailbox ? `Edit ${mailbox.address}` : "New mailbox"}
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="mbx" type="submit" disabled={busy}>
            {busy ? "Saving" : mailbox ? "Save changes" : "Create mailbox"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="mbx" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}

        <label className="field">
          <span>Address</span>
          <div className="row">
            <input
              className="mono"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              disabled={Boolean(mailbox)}
              placeholder="support"
              autoFocus={!mailbox}
              required
            />
            {domains.length > 1 && !mailbox ? (
              <select
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                style={{ width: "auto" }}
                aria-label="Domain"
              >
                {domains.map((d) => (
                  <option key={d} value={d}>
                    @{d}
                  </option>
                ))}
              </select>
            ) : (
              <span className="mono muted" style={{ whiteSpace: "nowrap" }}>
                @{domain}
              </span>
            )}
          </div>
          {mailbox && <span className="hint">The address cannot be changed after creation.</span>}
        </label>

        <label className="field">
          <span>Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Support" />
          <span className="hint">Appears in the From header of mail sent from this mailbox.</span>
        </label>

        <label className="field">
          <span>
            Reply-To <span className="muted">optional</span>
          </span>
          <input
            className="mono"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder={mailbox?.address ?? "replies come back here"}
          />
          <span className="hint">
            Where replies should go instead of to this mailbox. Worth setting on a no-reply address
            so answers reach a staffed one. Applies to everything sent from here, including the API.
          </span>
        </label>

        <label className="field">
          <span>Daily send limit</span>
          <input
            type="number"
            min={0}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="mono"
          />
          <span className="hint">
            Outbound messages allowed in any rolling 24 hours. Set 0 for a receive-only mailbox such
            as a DMARC report sink.
          </span>
        </label>
      </form>
    </Sheet>
  );
}
