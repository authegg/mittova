import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/* --------------------------------------------------------------- router --- */

/**
 * Hash routing. Deliberately hand-rolled: the app has ten flat routes and no
 * nested layouts, so a router dependency would cost more than it earns.
 */
export function useRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, "") || "overview";
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((to: string) => {
    window.location.hash = `/${to}`;
  }, []);

  return [route, navigate];
}

/* --------------------------------------------------------------- toasts --- */

interface Toast {
  id: number;
  message: string;
  tone: "neutral" | "bad";
}

const ToastContext = createContext<(message: string, tone?: "neutral" | "bad") => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: "neutral" | "bad" = "neutral") => {
    const id = Date.now() + Math.round(performance.now());
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone === "bad" ? " bad" : ""}`}>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------------------------------------------------------------- async --- */

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Fetch-on-mount with a manual reload handle. `deps` re-runs the loader. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    loader()
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

/** Poll while the tab is visible — inbound mail arrives out of band. */
export function usePoll(fn: () => void, intervalMs = 20_000) {
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") fn();
    };
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);
}

/**
 * Close a popover on an outside click or Escape.
 *
 * Written once because it had been written four times — in the org switcher,
 * the settings menu, the address picker and the template menu — and the copies
 * had drifted: two handled Escape, one handled it only while the input had
 * focus, and the newest handled it not at all. A shared hook makes every
 * popover behave the same by construction.
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}
