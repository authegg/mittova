import { useState, type FormEvent } from "react";
import { api, type DemoInfo } from "../api";
import Icon from "./Icon";

export default function Login({ demo, onAuthed }: { demo: DemoInfo | null; onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(demo?.password ?? "");
  /**
   * The demo opens straight into administrator mode with the password filled
   * in. Its seeded users cannot be signed into at all — their password hashes
   * are placeholders matching no credential — so presenting an email field
   * first would offer a visitor nothing but a form that always refuses.
   */
  const [adminMode, setAdminMode] = useState(demo !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(adminMode ? undefined : email, password);
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <div className="wordmark">
          <Icon name="mark" size={18} className="glyph" />
          Mittova
        </div>
        <p className="lede">Your domain, your mailbox, your data.</p>

        {demo && (
          <div className="notice demo-notice">
            <p>
              <strong>Live demo.</strong> Resets hourly, sending is disabled, and all the data is
              fabricated.
            </p>
            <p>
              The password is <code>{demo.password || "published on mittova.com"}</code> and the
              email field stays empty.
            </p>
          </div>
        )}

        <form className="card" onSubmit={submit}>
          <div className="card-body stack">
            {error && <div className="notice bad">{error}</div>}

            {!adminMode && (
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  className="mono"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                />
              </label>
            )}

            <label className="field">
              <span>{adminMode ? "Administrator password" : "Password"}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus={adminMode}
              />
            </label>

            <button className="primary" type="submit" disabled={busy || !password}>
              {busy ? "Signing in" : "Sign in"}
            </button>

            <button
              type="button"
              className="ghost"
              onClick={() => {
                setAdminMode((v) => !v);
                setError(null);
              }}
            >
              {adminMode ? "Sign in with an email instead" : "Use the administrator password"}
            </button>
          </div>
        </form>

        <p className="hint" style={{ marginTop: 14 }}>
          Sessions last seven days. Programmatic access uses API keys, not these credentials.
        </p>
      </div>
    </main>
  );
}
