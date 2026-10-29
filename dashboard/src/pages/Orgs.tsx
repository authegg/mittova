import { useRef, useState, type FormEvent } from "react";
import { api, setActiveOrg, type Org } from "../api";
import { useAsync, useToast } from "../hooks";
import { Card, Confirm, EmptyState, Sheet, TableSkeleton, relativeTime } from "../components/ui";
import Icon from "../components/Icon";
import { toEmailPng } from "../lib/emailPng";

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
                          Details
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
          title={renaming.name}
          label="Name"
          hint="A label only. The identifier every row in this tenant references does not change."
          initial={renaming.name}
          submitLabel="Save"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            if (name !== renaming.name) {
              await api.updateOrg(renaming.id, { name });
              toast("Saved");
            }
            list.reload();
          }}
        >
          <LogoField
            org={renaming}
            onChange={(logoUrl) => {
              setRenaming({ ...renaming, logoUrl });
              list.reload();
            }}
          />
        </NameSheet>
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

/**
 * The logo mail templates show as {{logo_url}}. Whatever is picked is
 * converted to a PNG here, since that is all mail clients reliably display,
 * and it is saved straight away rather than with the name.
 */
function LogoField({ org, onChange }: { org: Org; onChange: (logoUrl: string | null) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const { logoUrl } = await api.setOrgLogo(org.id, await toEmailPng(file));
      onChange(logoUrl);
      toast("Logo saved");
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <span>Logo</span>
      {org.logoUrl ? (
        <div className="logo-preview">
          <img src={org.logoUrl} alt={`${org.name} logo`} />
        </div>
      ) : (
        <div className="hint">None yet. Invite emails show the organization's name instead.</div>
      )}
      <div className="row">
        <button
          type="button"
          className="sm"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          {busy ? "Uploading" : org.logoUrl ? "Replace" : "Upload logo"}
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
        {org.logoUrl && (
          <button
            type="button"
            className="sm"
            disabled={busy}
            onClick={async () => {
              await api.removeOrgLogo(org.id);
              onChange(null);
              toast("Logo removed");
            }}
          >
            Remove
          </button>
        )}
      </div>
      <span className="hint">
        PNG, JPG or SVG. Used in mail as <span className="mono">{"{{logo_url}}"}</span>, including
        the built-in invite. Mail already sent keeps the logo it went out with.
      </span>
    </div>
  );
}

/** Create and edit share a sheet; editing adds the logo below the name. */
function NameSheet({
  title,
  label,
  hint,
  initial,
  submitLabel,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  label: string;
  hint: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
  children?: React.ReactNode;
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
      {children && <div style={{ marginTop: 18 }}>{children}</div>}
    </Sheet>
  );
}
