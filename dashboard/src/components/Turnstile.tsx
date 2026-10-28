import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme: "light" | "dark" | "auto";
      size: "flexible" | "compact";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let script: Promise<TurnstileApi> | null = null;

/** Loaded on first use, so a deployment with Turnstile off never fetches it. */
function loadTurnstile(): Promise<TurnstileApi> {
  script ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject());
    s.onerror = () => {
      script = null;
      reject(new Error("Could not load the verification check."));
    };
    document.head.appendChild(s);
  });
  return script;
}

/**
 * The Turnstile widget. A token is single use, so a form remounts this (by
 * changing its key) after every failed submit to get a fresh one.
 */
export default function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Held in a ref so a parent re-render does not tear the widget down.
  const report = useRef(onToken);
  report.current = onToken;

  useEffect(() => {
    let id: string | null = null;
    let live = true;
    loadTurnstile()
      .then((ts) => {
        if (!live || !box.current) return;
        const pinned = document.documentElement.dataset.theme;
        id = ts.render(box.current, {
          sitekey: siteKey,
          theme: pinned === "light" || pinned === "dark" ? pinned : "auto",
          // flexible is 300px at the narrowest, wider than the card on a small phone.
          size: box.current.clientWidth < 300 ? "compact" : "flexible",
          callback: (t) => report.current(t),
          "expired-callback": () => report.current(null),
          "error-callback": () => report.current(null),
        });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey]);

  if (failed) {
    return (
      <div className="notice bad">
        The verification check could not load. Reload the page, or allow challenges.cloudflare.com.
      </div>
    );
  }
  return <div ref={box} className="turnstile" />;
}
