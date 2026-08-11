import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "../hooks";
import { api, activeOrg, setActiveOrg, type Org } from "../api";
import Icon from "./Icon";

/**
 * Tenant selector, shown only to platform administrators.
 *
 * Changing tenant reloads rather than re-fetching in place. Every page holds
 * data belonging to the previous org, and a reload is one line that cannot
 * leave a stale list behind, against a menu used a few times a day.
 */
export default function OrgSwitcher() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = activeOrg();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    api
      .orgs()
      .then(setOrgs)
      .catch(() => setOrgs([]));
  }, []);

  useDismiss(open, wrap, close);

  // Nothing to switch between until there is more than one tenant.
  if (!orgs || orgs.length < 2) return null;

  const active = orgs.find((o) => o.id === current);

  function choose(id: string) {
    setActiveOrg(id);
    window.location.reload();
  }

  return (
    <div className="orgs" ref={wrap}>
      <button
        className="org-trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch organization"
      >
        <Icon name="globe" size={13} />
        <span className="truncate">{active ? active.name : "All organizations"}</span>
        <span className="domain-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="org-menu" role="menu">
          <button
            className={`org-item${current === "" ? " on" : ""}`}
            role="menuitem"
            onClick={() => choose("")}
          >
            <span className="org-name">All organizations</span>
            <span className="small muted">Read across every tenant</span>
          </button>

          <div className="org-sep" />

          {orgs.map((o) => (
            <button
              key={o.id}
              className={`org-item${current === o.id ? " on" : ""}`}
              role="menuitem"
              onClick={() => choose(o.id)}
            >
              <span className="org-name">{o.name}</span>
              <span className="small muted">
                {o.domains.join(", ") || "no domain"} · {o.mailboxes} mailbox
                {o.mailboxes === 1 ? "" : "es"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
