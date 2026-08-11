import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAsync, useToast } from "../hooks";
import { Badge, Card, EmptyState, Sheet, TableSkeleton, absoluteTime, compactTime , Pager} from "../components/ui";
import { usePaged } from "../hooks-paging";
import Icon from "../components/Icon";

const REASON_TONE = { bounce: "bad", complaint: "warn", manual: "neutral" } as const;

export default function Suppressions() {
  const toast = useToast();
  const list = useAsync(() => api.suppressions(), []);
  const [adding, setAdding] = useState(false);
  const paged = usePaged(list.data ?? []);

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

      <Card tight>
        {list.loading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : (list.data ?? []).length === 0 ? (
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
                  <th style={{ width: 120 }}>Reason</th>
                  <th>Detail</th>
                  <th style={{ width: 170 }} className="num">
                    Added
                  </th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {paged.slice.map((s) => (
                  <tr key={s.id}>
                    <td className="mono small cell-strong">{s.email}</td>
                    <td>
                      <Badge tone={REASON_TONE[s.reason]}>{s.reason}</Badge>
                    </td>
                    <td className="small muted truncate">{s.detail || "—"}</td>
                    <td className="num small muted">{compactTime(s.createdAt)}</td>
                    <td>
                      <button
                        className="sm"
                        onClick={async () => {
                          await api.deleteSuppression(s.id);
                          list.reload();
                          toast(`${s.email} unblocked`);
                        }}
                      >
                        Unblock
                      </button>
                    </td>
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
