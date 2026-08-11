import { useState, type FormEvent } from "react";
import { api, type SessionUser } from "../api";
import { useToast } from "../hooks";
import { Badge, Sheet } from "./ui";
import RichText from "./RichText";
import ThemeToggle from "./ThemeToggle";

export default function Profile({
  me,
  onClose,
  onSaved,
}: {
  me: SessionUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [signature, setSignature] = useState(me.signature ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!me.isRootAdmin) await api.saveSignature(signature);
      if (password) await api.changePassword(password);
      toast("Profile saved");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Your profile"
      subtitle={me.email}
      onClose={onClose}
      footer={
        <>
          <button className="primary" form="profile" type="submit" disabled={busy}>
            {busy ? "Saving" : "Save"}
          </button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <form id="profile" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}

        <dl className="kv">
          <dt>Name</dt>
          <dd>{me.name}</dd>
          <dt>Role</dt>
          <dd>
            <Badge tone={me.role === "owner" ? "info" : "neutral"}>{me.role}</Badge>
          </dd>
          <dt>Mailboxes</dt>
          <dd>{me.mailboxCount === null ? "all mailboxes" : `${me.mailboxCount} assigned`}</dd>
        </dl>

        <ThemeToggle />

        {me.isRootAdmin ? (
          <div className="notice">
            You are signed in with the break-glass administrator password. It has no profile —
            signatures and password changes belong to real user accounts, and this one is changed
            with <span className="mono">wrangler secret put ADMIN_PASSWORD</span>.
          </div>
        ) : (
          <>
            <div className="field">
              <span>Signature</span>
              <RichText
                value={signature}
                onChange={setSignature}
                ariaLabel="Email signature"
                minHeight={120}
              />
              <span className="hint">
                Added below the cursor when you compose or reply, so you can edit or delete it
                per message.
              </span>
            </div>

            <label className="field">
              <span>New password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="Leave blank to keep your current password"
              />
              <span className="hint">At least 12 characters, with mixed case and a digit.</span>
            </label>

            {password && (
              <label className="field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}
          </>
        )}
      </form>
    </Sheet>
  );
}
