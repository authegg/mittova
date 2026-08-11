import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "../hooks";
import Icon, { type IconName } from "./Icon";

export interface MenuItem {
  id: string;
  label: string;
  icon: IconName;
}

/**
 * The configuration half of the navigation, behind one menu.
 *
 * Reads as a tab when one of its pages is open, so the row still shows where
 * you are rather than going blank the moment you navigate into it.
 */
export default function SettingsMenu({ items, page }: { items: MenuItem[]; page: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const here = items.some((i) => i.id === page);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, wrap, close);

  // A hash change means navigation happened; the menu has served its purpose.
  useEffect(() => {
    function close() {
      setOpen(false);
    }
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="navmenu" ref={wrap}>
      <button
        className="navmenu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-current={here ? "page" : undefined}
        onClick={() => setOpen(!open)}
      >
        Settings
        <span className="domain-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="navmenu-panel" role="menu">
          {items.map((i) => (
            <a
              key={i.id}
              className={`navmenu-item${page === i.id ? " on" : ""}`}
              role="menuitem"
              href={`#/${i.id}`}
            >
              <Icon name={i.icon} size={14} />
              {i.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
