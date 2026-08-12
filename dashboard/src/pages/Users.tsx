import { useState, type FormEvent } from "react";
import { activeOrg, api, type Mailbox, type User } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  Sheet,
  TableSkeleton,
  absoluteTime,
  relativeTime,
} from "../components/ui";
import Icon from "../components/Icon";

/** Meets the server's rule: 12+ chars, mixed case, a digit. */
function suggestPassword(): string {
  const sets = [
    "abcdefghijkmnopqrstuvwxyz",
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "23456789",
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  ];
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const chars = [
    sets[0][bytes[0] % sets[0].length],
    sets[1][bytes[1] % sets[1].length],
    sets[2][bytes[2] % sets[2].length],
    ...[...bytes.slice(3)].map((b) => sets[3][b % sets[3].length]),
  ];
  return chars.join("");
}

/** How many addresses a row shows before it starts counting instead. */
const SHOWN_MAILBOXES = 2;

/**
 * The mailboxes column.
 *
 * Listing every address made wide rows say less, not more: six addresses at
 * this width truncate mid-word, so the row ends up showing an arbitrary prefix
 * of an arbitrary subset. What the column is for is a sense of how much access
 * an account has, and "two of these, and four more" carries that. The full list
 * is one hover away and the editor shows it properly.
 */
function MailboxCell({
  user,
  addressById,
  loaded,
}: {
  user: User;
  addressById: Map<string, string>;
  /** False until the mailbox list arrives; ids cannot be resolved before then. */
  loaded: boolean;
}) {
  if (user.role === "owner") return <>all mailboxes</>;
  if (user.mailboxIds.length === 0) return <>none assigned</>;
  // The mailboxes arrive on their own request, so for a moment that list is
  // empty while the users have already rendered. Resolving against it then
  // turns every row into "?, ?", which reads as data loss rather than as
  // loading. The count is known from the user record and is true throughout.
  if (!loaded) return <>{user.mailboxIds.length} assigned</>;

  // Sorted so the two on show are stable between renders rather than whichever
  // the assignment happened to be written in.
  const names = user.mailboxIds.map((id) => addressById.get(id) ?? "?").sort();
  const shown = names.slice(0, SHOWN_MAILBOXES);
  const rest = names.length - shown.length;

  return (
    <span title={rest > 0 ? names.join(", ") : undefined}>
      {shown.join(", ")}
      {rest > 0 && <span className="more">+{rest} more</span>}
    </span>
  );
}

function UserForm({
  user,
  mailboxes,
  viewingOrgId,
  onClose,
  onSaved,
}: {
  user: User | null;
  mailboxes: Mailbox[];
  /** The tenant in the switcher; empty when viewing every tenant at once. */
  viewingOrgId: string;
  onClose: () => void;
  onSaved: (created?: { email: string; inviteToken: string | null; password: string }) => void;
}) {
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [role, setRole] = useState<"owner" | "member">(user?.role ?? "member");
  const [password, setPassword] = useState("");
  /**
   * Invite by default. Setting a password means someone has to transmit it,
   * and the safest channel for that is usually none.
   */
  const [byInvite, setByInvite] = useState(true);
  const [assigned, setAssigned] = useState<string[]>(user?.mailboxIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The tenant that bounds this account: its own when editing, the one in view
   * when creating. Offering anything outside it was the confusing part, and on
   * "All organizations" the flat list mixed every tenant's addresses together
   * with nothing to tell them apart.
   */
  const targetOrg = user?.orgId || viewingOrgId;
  const choices = targetOrg ? mailboxes.filter((m) => m.orgId === targetOrg) : [];

  /** Grouped by domain, because a tenant with three domains is still a wall of
   *  addresses otherwise, and the domain is the part that disambiguates. */
  const byDomain = [
    ...choices
      .reduce((acc, m) => {
        const domain = m.address.split("@")[1] ?? "";
        (acc.get(domain) ?? acc.set(domain, []).get(domain)!).push(m);
        return acc;
      }, new Map<string, Mailbox[]>())
      .entries(),
  ].sort(([a], [b]) => a.localeCompare(b));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await api.updateUser(user.id, {
          name,
          role,
          mailboxIds: assigned,
          ...(password ? { password } : {}),
        });
        onSaved();
      } else {
        const made = await api.createUser({
          email,
          name,
          role,
          mailboxIds: assigned,
          ...(byInvite ? {} : { password }),
        });
        onSaved({ email, inviteToken: made.inviteToken, password });
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={user ? `Edit ${user.email}` : "New user"}
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="user-form" type="submit" disabled={busy}>
            {busy ? "Saving" : user ? "Save changes" : "Create user"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <form id="user-form" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            className="mono"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={Boolean(user)}
            required
            autoFocus={!user}
          />
          <span className="hint">
            Their sign-in identity. It does not have to be an address on this domain.
          </span>
        </label>

        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as "owner" | "member")}>
            <option value="member">Member — only the mailboxes you assign</option>
            <option value="owner">Owner — full access, can manage users</option>
          </select>
        </label>

        {!user && (
          <div className="field">
            <span>How they get in</span>
            <div className="stack" style={{ gap: 6 }}>
              <label className="row" style={{ gap: 8 }}>
                <input
                  type="radio"
                  style={{ width: "auto" }}
                  checked={byInvite}
                  onChange={() => setByInvite(true)}
                />
                <span className="small">
                  Send them an invite link — they choose their own password
                </span>
              </label>
              <label className="row" style={{ gap: 8 }}>
                <input
                  type="radio"
                  style={{ width: "auto" }}
                  checked={!byInvite}
                  onChange={() => setByInvite(false)}
                />
                <span className="small">Set a password now</span>
              </label>
            </div>
            <span className="hint">
              An invite means nobody has to send a password over chat or email. The link works once
              and expires in seven days.
            </span>
          </div>
        )}

        {(user || !byInvite) && (
          <label className="field">
            <span>{user ? "Reset password" : "Password"}</span>
            <div className="row">
              <input
                className="mono"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={user ? "Leave blank to keep the current password" : ""}
                required={!user}
              />
              <button type="button" onClick={() => setPassword(suggestPassword())}>
                Generate
              </button>
            </div>
            <span className="hint">
              At least 12 characters with mixed case and a digit. They are prompted to change it on
              first sign-in.
            </span>
          </label>
        )}

        <div className="field">
          <span>Mailboxes</span>
          {role === "owner" ? (
            <div className="notice">Owners can already see every mailbox.</div>
          ) : !targetOrg ? (
            // Creating from the all-orgs view has no tenant to put the account
            // in, and the server refuses it. Saying so beats listing every
            // tenant's mailboxes for a form that cannot be submitted.
            <div className="notice">
              Choose an organization in the switcher above to create a user in it.
            </div>
          ) : choices.length === 0 ? (
            <div className="hint">This organization has no mailboxes yet.</div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <div className="hint">
                An account can only be given mailboxes from its own organization.
              </div>
              {byDomain.map(([domain, boxes]) => (
                <div key={domain} className="stack" style={{ gap: 6 }}>
                  <div className="picker-group">{domain}</div>
                  {boxes.map((m) => (
                    <label key={m.id} className="row" style={{ gap: 8 }}>
                      <input
                        type="checkbox"
                        style={{ width: "auto" }}
                        checked={assigned.includes(m.id)}
                        onChange={(e) =>
                          setAssigned((a) =>
                            e.target.checked ? [...a, m.id] : a.filter((x) => x !== m.id),
                          )
                        }
                      />
                      <span className="mono small">{m.address.split("@")[0]}</span>
                      <span className="mono small muted">@{domain}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </form>
    </Sheet>
  );
}

/** The page someone opens to accept, which lives outside the signed-in app. */
function inviteUrl(token: string): string {
  return `${window.location.origin}/#/accept/${token}`;
}

export default function Users({ mailboxes }: { mailboxes: Mailbox[] }) {
  const toast = useToast();
  const list = useAsync(() => api.users(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [handoff, setHandoff] = useState<{
    email: string;
    inviteToken: string | null;
    password: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const addressById = new Map(mailboxes.map((m) => [m.id, m.address]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>
            People who can sign in. Members see only the mailboxes you assign them; owners see
            everything and can manage accounts.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New user
        </button>
      </div>

      <Card tight>
        {list.loading ? (
          <TableSkeleton rows={3} cols={5} />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            icon="people"
            title="No user accounts"
            body="Right now the dashboard is reachable only with the administrator password. Create a user to give someone their own sign-in scoped to specific mailboxes."
            action={
              <button className="primary" onClick={() => setCreating(true)}>
                Create the first user
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 250 }}>User</th>
                  <th style={{ width: 110 }}>Role</th>
                  <th>Mailboxes</th>
                  <th style={{ width: 130 }}>Last sign-in</th>
                  {/* Edit 42 + Invite 52 + Disable 63 + delete 33, three 8px gaps,
                      28px of cell padding = 242. table-layout is fixed and cells
                      clip, so a short column silently eats the leftmost button. */}
                  <th className="actions" style={{ width: 250 }} />
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="cell-strong truncate">{u.name}</div>
                      <div className="mono small muted truncate">{u.email}</div>
                    </td>
                    <td>
                      <Badge tone={u.role === "owner" ? "info" : "neutral"}>{u.role}</Badge>
                      {u.disabled === 1 && (
                        <div style={{ marginTop: 3 }}>
                          <Badge tone="bad">disabled</Badge>
                        </div>
                      )}
                    </td>
                    <td className="small muted truncate">
                      <MailboxCell
                        user={u}
                        addressById={addressById}
                        loaded={mailboxes.length > 0}
                      />
                    </td>
                    <td className="small muted">
                      {u.lastLoginAt ? relativeTime(u.lastLoginAt) : "never"}
                    </td>
                    <td className="actions">
                      <div className="row">
                        <button className="sm" onClick={() => setEditing(u)}>
                          Edit
                        </button>
                        <button
                          className="sm"
                          title="Issue a fresh invite link"
                          onClick={async () => {
                            try {
                              const { inviteToken, email } = await api.reinvite(u.id);
                              setHandoff({ email, inviteToken, password: "" });
                            } catch (err) {
                              toast((err as Error).message, "bad");
                            }
                          }}
                        >
                          Invite
                        </button>
                        <button
                          className="sm"
                          onClick={async () => {
                            await api.updateUser(u.id, { disabled: u.disabled === 0 });
                            list.reload();
                            toast(u.disabled === 0 ? "Account disabled" : "Account enabled");
                          }}
                        >
                          {u.disabled === 0 ? "Disable" : "Enable"}
                        </button>
                        <button className="danger sm" onClick={() => setDeleting(u)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ height: 18 }} />
      <div className="notice">
        The <span className="mono">ADMIN_PASSWORD</span> secret remains a break-glass owner login
        that works even with no user rows, so the dashboard cannot lock you out. Sign in with it by
        leaving the email field empty.
      </div>

      {(creating || editing) && (
        <UserForm
          user={editing}
          mailboxes={mailboxes}
          viewingOrgId={activeOrg()}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(created) => {
            setCreating(false);
            setEditing(null);
            list.reload();
            if (created) setHandoff(created);
            else toast("User updated");
          }}
        />
      )}

      {handoff && (
        <Sheet
          title={handoff.inviteToken ? "Invite ready" : "User created"}
          onClose={() => setHandoff(null)}
          footer={
            <button className="primary" onClick={() => setHandoff(null)}>
              Done
            </button>
          }
        >
          <div className="stack">
            {handoff.inviteToken ? (
              <>
                <div className="notice">
                  Send them this link. It works once, expires in seven days, and they choose their
                  own password — so no password is transmitted by anyone.
                </div>
                <label className="field">
                  <span>Email</span>
                  <input readOnly className="mono" value={handoff.email} />
                </label>
                <label className="field">
                  <span>Invite link</span>
                  <div className="row">
                    <input
                      readOnly
                      className="mono"
                      value={inviteUrl(handoff.inviteToken)}
                      onFocus={(e) => e.target.select()}
                    />
                    <CopyButton value={inviteUrl(handoff.inviteToken)} />
                  </div>
                  <span className="hint">
                    Not recoverable from here. If it is lost, issue a new one from the row's Invite
                    button.
                  </span>
                </label>
              </>
            ) : (
              <>
                <div className="notice">
                  Hand these over through a channel you trust. The password is not recoverable from
                  here — you can only set a new one.
                </div>
                <label className="field">
                  <span>Email</span>
                  <input readOnly className="mono" value={handoff.email} />
                </label>
                <label className="field">
                  <span>Temporary password</span>
                  <div className="row">
                    <input
                      readOnly
                      className="mono"
                      value={handoff.password}
                      onFocus={(e) => e.target.select()}
                    />
                    <CopyButton value={handoff.password} />
                  </div>
                </label>
              </>
            )}
          </div>
        </Sheet>
      )}

      {deleting && (
        <Sheet
          title={`Delete ${deleting.email}`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button
                className="danger"
                onClick={async () => {
                  try {
                    await api.deleteUser(deleting.id);
                    setDeleting(null);
                    list.reload();
                    toast("User deleted");
                  } catch (err) {
                    toast((err as Error).message, "bad");
                  }
                }}
              >
                Delete user
              </button>
              <button onClick={() => setDeleting(null)}>Cancel</button>
            </>
          }
        >
          <p>
            Their sessions stop working immediately. Mailboxes and messages are untouched — only the
            sign-in and its assignments are removed. Created {absoluteTime(deleting.createdAt)}.
          </p>
        </Sheet>
      )}
    </>
  );
}
