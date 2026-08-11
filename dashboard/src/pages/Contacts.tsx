import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAsync, useToast } from "../hooks";
import { Card, EmptyState, Sheet, TableSkeleton , Pager} from "../components/ui";
import { usePaged } from "../hooks-paging";
import Icon from "../components/Icon";

export default function Contacts({ onCompose }: { onCompose: (to: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const list = useAsync(() => api.contacts(q || undefined), [q]);
  const [creating, setCreating] = useState(false);
  const paged = usePaged(list.data ?? []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Contacts</h1>
          <p>An address book for the people you mail regularly, so you are not retyping addresses.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> Add contact
        </button>
      </div>

      <div className="toolbar">
        <div className="search grow">
          <Icon name="search" size={14} />
          <input
            placeholder="Search name, email or company"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search contacts"
          />
        </div>
      </div>

      <Card tight>
        {list.loading ? (
          <TableSkeleton rows={4} cols={4} />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            icon="roster"
            title={q ? "No matches" : "No contacts"}
            body={
              q
                ? "Nothing matches that search."
                : "Add the people you correspond with and you can start a message to them in one click."
            }
            action={
              q ? (
                <button onClick={() => setQ("")}>Clear search</button>
              ) : (
                <button className="primary" onClick={() => setCreating(true)}>
                  Add a contact
                </button>
              )
            }
          />
        ) : (
          <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 200 }}>Name</th>
                  <th style={{ width: 240 }}>Email</th>
                  <th>Company / notes</th>
                  <th style={{ width: 110 }} className="num">
                    Added
                  </th>
                  <th style={{ width: 130 }} />
                </tr>
              </thead>
              <tbody>
                {paged.slice.map((ct) => (
                  <tr key={ct.id}>
                    <td className="cell-strong">{ct.name || <span className="muted">—</span>}</td>
                    <td className="mono small">{ct.email}</td>
                    <td className="small muted truncate">
                      {[ct.company, ct.notes].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="num small muted">
                      {new Date(ct.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td>
                      <div className="row">
                        <button className="sm" onClick={() => onCompose(ct.email)}>
                          Email
                        </button>
                        <button
                          className="danger sm"
                          onClick={async () => {
                            await api.deleteContact(ct.id);
                            list.reload();
                            toast("Contact removed");
                          }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
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

      {creating && (
        <AddContact
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            list.reload();
            toast("Contact added");
          }}
        />
      )}
    </>
  );
}

function AddContact({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createContact({ email, name, company, notes });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Add contact"
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="new-contact" type="submit" disabled={busy}>
            {busy ? "Saving" : "Add contact"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="new-contact" className="stack" onSubmit={submit}>
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
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Company</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="field">
          <span>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </form>
    </Sheet>
  );
}
