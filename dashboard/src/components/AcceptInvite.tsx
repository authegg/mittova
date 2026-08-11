import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import Icon from "./Icon";

/**
 * Accepting an invite, which happens before there is any session.
 *
 * Rendered instead of the sign-in screen when the hash is /accept/<token>, so
 * it must not depend on anything the signed-in shell provides.
 *
 * The person chooses their own password here, which is the point: it is the
 * only arrangement where the password is never known to anyone else and never
 * travels over chat or email.
 */
export default function AcceptInvite({
  token,
  onAccepted,
}: {
  token: string;
  onAccepted: () => void;
}) {
  const [who, setWho] = useState<{ email: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .invitePreview(token)
      .then((w) => live && setWho(w))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite(token, password);
      // Accepting signs them in, so there is nothing left to type.
      onAccepted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="wordmark" style={{ marginBottom: 18 }}>
          <Icon name="mark" size={20} className="glyph" />
          Mittova
        </div>

        {loading ? (
          <div className="skeleton" style={{ height: 14, width: 200 }} />
        ) : !who ? (
          <>
            <h1>This invite is no longer valid</h1>
            <p className="small muted">
              {error ?? "It may have been used already, or it may have expired."} Ask whoever
              invited you for a new link.
            </p>
            <a className="btn" href="#/" onClick={() => window.location.reload()}>
              Go to sign in
            </a>
          </>
        ) : (
          <form className="stack" onSubmit={submit}>
            <div>
              <h1>Choose a password</h1>
              <p className="small muted">
                for <span className="mono">{who.email}</span>. Nobody else will know it, including
                whoever invited you.
              </p>
            </div>

            {error && <div className="notice bad">{error}</div>}

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
              <span className="hint">At least 12 characters, with mixed case and a digit.</span>
            </label>

            <label className="field">
              <span>Confirm</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>

            <button className="primary" type="submit" disabled={busy || !password}>
              {busy ? "Setting up" : "Set password and sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
