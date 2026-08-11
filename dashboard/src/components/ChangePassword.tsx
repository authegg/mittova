import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Sheet } from "./ui";

/** Shown when an owner-assigned password is still in place. */
export default function ChangePassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Choose your own password"
      subtitle="Your current password was set by an administrator."
      onClose={onDone}
      footer={
        <>
          <button className="primary" form="chpw" type="submit" disabled={busy}>
            {busy ? "Saving" : "Set password"}
          </button>
          <button onClick={onDone}>Later</button>
        </>
      }
    >
      <form id="chpw" className="stack" onSubmit={submit}>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            autoFocus
          />
          <span className="hint">At least 12 characters, with mixed case and a digit.</span>
        </label>
        <label className="field">
          <span>Confirm</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
      </form>
    </Sheet>
  );
}
