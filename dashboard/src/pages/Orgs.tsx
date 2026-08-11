import { useState, type FormEvent } from "react";
import { api, setActiveOrg, type Org } from "../api";
import { useAsync, useToast } from "../hooks";
import { Card, Confirm, EmptyState, Sheet, TableSkeleton, relativeTime } from "../components/ui";
import Icon from "../components/Icon";

/**
 * The clients this deployment serves.
 *
 * Platform administrators only. An org owner has exactly one org and would
 * learn nothing from a list, while the list itself is the client roster.
 */
export default function Orgs() {
  const toast = useToast();
  const list = useAsync(() => api.orgs(), []);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Org | null>(null);
  const [deleting, setDeleting] = useState<Org | null>(null);
  const orgs = list.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Organizations</h1>
          <p>
            One per client. Everything else — domains, mailboxes, people, templates — belongs to
            exactly one of these, and nothing is visible across them.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New organization
        </button>
      </div>

      {list.error && <div className="notice bad">{list.error}</div>}

      {list.loading && orgs.length === 0 ? (
        <Card tight>
          <TableSkeleton rows={3} cols={5} />
        </Card>
      ) : orgs.length === 0 ? (
        <Card>
          <EmptyState
            icon="globe"
            title="No organizations"
            body="Add one per client. A domain added later belongs to whichever organization you were viewing."
            action={
              <button className="primary" onClick={() => setCreating(true)}>
                New organization
              </button>
            }
          />
        </Card>
      ) : (
        <Card tight>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 220 }}>Organization</th>
                  <th>Domains</th>
                  <th style={{ width: 90 }} className="num">
                    Mailboxes
                  </th>
                  <th style={{ width: 70 }} className="num">
                    People
                  </th>
                  <th style={{ width: 110 }} className="num">
                    Daily cap
                  </th>
                  <th style={{ width: 90 }} className="num">
                    Added
                  </th>
                  <th className="actions" style={{ width: 300 }} />
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <div className="cell-strong truncate">{o.name}</div>
                      <div className="mono small muted truncate">{o.id}</div>
                    </td>
                    <td className="small muted truncate">
                      {o.domains.join(", ") || <span className="muted">none yet</span>}
                    </td>
                    <td className="num small">{o.mailboxes}</td>
                    <td className="num small">{o.users}</td>
                    <td className="num small muted">
                      {o.dailySendLimit > 0 ? `${o.dailySendLimit}/24h` : "unlimited"}
                    </td>
                    <td className="num small muted">{relativeTime(o.createdAt)}</td>
                    <td className="actions">
                      <div className="row">
                        <button
                          className="sm"
                          onClick={() => {
                            setActiveOrg(o.id);
                            window.location.hash = "/overview";
                            window.location.reload();
                          }}
                        >
                          Open
                        </button>
                        <button className="sm" onClick={() => setRenaming(o)}>
                          Rename
                        </button>
                        <button
                          className="sm"
                          title="Download everything belonging to this client"
                          onClick={() => {
                            // The export follows the selected tenant, so switch
                            // to it first rather than inventing a second path.
                            setActiveOrg(o.id);
                            window.location.href = api.exportUrl();
                          }}
                        >
                          Export
                        </button>
                        <button className="danger sm" onClick={() => setDeleting(o)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && (
        <NameSheet
          title="New organization"
          label="Name"
          hint="The client's name as you would say it. Domains and mailboxes are added to it afterwards."
          initial=""
          submitLabel="Create"
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            await api.createOrg(name);
            toast(`${name} created`);
            list.reload();
          }}
        />
      )}

      {renaming && (
        <NameSheet
          title={`Rename ${renaming.name}`}
          label="Name"
          hint="A label only. The identifier every row in this tenant references does not change."
          initial={renaming.name}
          submitLabel="Save"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await api.updateOrg(renaming.id, { name });
            toast("Renamed");
            list.reload();
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          body={
            <>
              This cannot be undone. It only works if the organization is empty — anything it still
              holds has to be removed first, and you will be told what.
            </>
          }
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const org = deleting;
            setDeleting(null);
            try {
              await api.deleteOrg(org.id);
              toast(`${org.name} deleted`);
              list.reload();
            } catch (err) {
              toast((err as Error).message, "bad");
            }
          }}
        />
      )}
    </>
  );
}

/** Create and rename differ only in their words, so they share a sheet. */
function NameSheet({
  title,
  label,
  hint,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  hint: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="org-name" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving" : submitLabel}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="org-name" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>{label}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          <span className="hint">{hint}</span>
        </label>
      </form>
    </Sheet>
  );
}
