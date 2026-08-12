import { useCallback, useEffect, useState } from "react";
import { api, type Mailbox, type Me, type MessageFull, type SessionUser } from "./api";
import { useAsync, usePoll, useRoute, ToastProvider } from "./hooks";
import Icon, { type IconName } from "./components/Icon";
import { EmptyState } from "./components/ui";
import Login from "./components/Login";
import ChangePassword from "./components/ChangePassword";
import AcceptInvite from "./components/AcceptInvite";
import Profile from "./components/Profile";
import OrgSwitcher from "./components/OrgSwitcher";
import SettingsMenu from "./components/SettingsMenu";

import Overview from "./pages/Overview";
import Emails from "./pages/Emails";
import Domains from "./pages/Domains";
import ApiKeys from "./pages/ApiKeys";
import Webhooks from "./pages/Webhooks";
import Templates from "./pages/Templates";
import TemplateEditor from "./pages/TemplateEditor";
import Contacts from "./pages/Contacts";
import Suppressions from "./pages/Suppressions";
import Settings from "./pages/Settings";
import Users from "./pages/Users";
import Orgs from "./pages/Orgs";
import Audit from "./pages/Audit";
import MessageSheet from "./pages/MessageSheet";
import Compose, { replySeed, signatureBlock, type ComposeSeed } from "./pages/Compose";

interface Tab {
  id: string;
  label: string;
  icon: IconName;
  /** Account administration — hidden from members. */
  ownerOnly?: boolean;
  /** Crosses the tenant boundary — hidden from everyone inside one org. */
  platformOnly?: boolean;
  /**
   * Lives under the Settings menu rather than in the top row.
   *
   * Twelve tabs never fitted; the row was scrolling sideways with the scrollbar
   * hidden, so the overflow read as a truncated word rather than as something
   * you could reach. The split is by how often a page is opened: the surfaces
   * mail actually moves through stay in the row, and what you configure once
   * moves behind a menu.
   */
  inSettings?: boolean;
}

const TABS: Tab[] = [
  { id: "overview", label: "Overview", icon: "pulse" },
  { id: "inbox", label: "Inbox", icon: "tray" },
  { id: "emails", label: "Email", icon: "paper" },
  { id: "domains", label: "Domain", icon: "globe", ownerOnly: true },
  // Labelled Mailboxes because that is what the page lists. Calling it Settings
  // while a Settings menu sits beside it would be two different things wearing
  // one name.
  { id: "settings", label: "Mailboxes", icon: "sliders", ownerOnly: true },

  { id: "users", label: "Users", icon: "people", ownerOnly: true, inSettings: true },
  { id: "contacts", label: "Contacts", icon: "roster", ownerOnly: true, inSettings: true },
  { id: "templates", label: "Templates", icon: "stencil", ownerOnly: true, inSettings: true },
  { id: "keys", label: "API keys", icon: "key", ownerOnly: true, inSettings: true },
  { id: "webhooks", label: "Webhooks", icon: "relay", ownerOnly: true, inSettings: true },
  { id: "suppressions", label: "Suppressions", icon: "block", ownerOnly: true, inSettings: true },
  { id: "audit", label: "Audit", icon: "copy", ownerOnly: true, inSettings: true },
  // Platform administrators only: the list is the client roster.
  { id: "orgs", label: "Organizations", icon: "globe", platformOnly: true, inSettings: true },
];

function Shell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [me, setMe] = useState<SessionUser | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [route, navigate] = useRoute();

  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeSeed | null>(null);

  // One place to apply a session, used on mount and after signing in.
  const applySession = useCallback((m: Me) => {
    setAuthed(m.authed);
    setDomains(m.domains);
    setMe(m.user);
    if (m.user?.mustChangePassword) setShowChangePassword(true);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(applySession)
      .catch(() => setAuthed(false));
  }, [applySession]);

  const boxes = useAsync(() => (authed ? api.mailboxes() : Promise.resolve([])), [authed]);
  usePoll(boxes.reload, 30_000);

  const mailboxes: Mailbox[] = boxes.data ?? [];
  const unread = mailboxes.reduce((n, m) => n + m.unread, 0);

  const startCompose = useCallback(
    (to = "") => {
      if (mailboxes.length === 0) return;
      setCompose({
        mailboxId: mailboxes[0].id,
        to,
        subject: "",
        body: signatureBlock(me?.signature ?? ""),
      });
    },
    [mailboxes, me],
  );

  // Route is "emails" or "emails?mailbox=<id>"; strip the query for matching.
  const path = route.split("?")[0];
  // Sections may own sub-routes: templates/<id> is a full-page editor rather
  // than a sheet over the gallery.
  const [page, ...sub] = path.split("/");
  const isOwner = me?.role !== "member";
  const visible = TABS.filter(
    (t) => (isOwner || !t.ownerOnly) && (me?.isPlatformAdmin || !t.platformOnly),
  );
  const tabs = visible.filter((t) => !t.inSettings);
  const settingsItems = visible.filter((t) => t.inSettings);

  if (authed === null) {
    return (
      <div className="gate">
        <div className="skeleton" style={{ width: 220, height: 14 }} />
      </div>
    );
  }
  if (!authed) {
    // Accepting an invite happens before there is a session, so it is checked
    // before the sign-in screen rather than routed inside the shell.
    if (page === "accept" && sub[0]) {
      return (
        <AcceptInvite
          token={sub[0]}
          onAccepted={() => {
            window.location.hash = "/overview";
            api.me().then(applySession);
          }}
        />
      );
    }
    return <Login onAuthed={() => api.me().then(applySession)} />;
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          <span className="wordmark">
            <Icon name="mark" size={18} className="glyph" />
            Mittova
          </span>

          {/* The menu sits outside nav.tabs: that element scrolls sideways on
              narrow screens, and a scroll container clips an absolutely
              positioned panel to its own height. */}
          <div className="nav-wrap">
            <nav className="tabs" aria-label="Sections">
              {tabs.map((t) => (
                <a key={t.id} href={`#/${t.id}`} aria-current={page === t.id ? "page" : undefined}>
                  {t.label}
                  {t.id === "inbox" && unread > 0 && <span className="tab-count">{unread}</span>}
                </a>
              ))}
            </nav>
            <SettingsMenu items={settingsItems} page={page} />
          </div>

          <div className="row" style={{ gap: 10, flex: "none" }}>
            {me?.isPlatformAdmin && <OrgSwitcher />}
            {me && (
              <button
                className="identity"
                onClick={() => setShowProfile(true)}
                title={`Signed in as ${me.email} — open profile`}
              >
                <span className="avatar" aria-hidden="true">
                  {(me.name || me.email).slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate">{me.name}</span>
              </button>
            )}
            <button
              className="ghost sm"
              onClick={async () => {
                await api.logout();
                setMe(null);
                setAuthed(false);
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="page" id="content">
        {page === "overview" && (
          <Overview
            navigate={navigate}
            isOwner={isOwner}
            name={me?.name ?? "there"}
            onOpenMessage={setOpenMessage}
          />
        )}

        {(page === "emails" || page === "inbox") && (
          <Emails
            key={page}
            mailboxes={mailboxes}
            mode={page === "inbox" ? "inbox" : "all"}
            onOpen={setOpenMessage}
            onCompose={() => startCompose()}
            onResumeDraft={(d) =>
              setCompose({
                draftId: d.id,
                mailboxId: d.mailboxId,
                to: d.toAddr,
                cc: d.ccAddr,
                bcc: d.bccAddr,
                subject: d.subject,
                body: d.bodyHtml,
                replyToMessageId: d.replyToMessageId ?? undefined,
              })
            }
          />
        )}

        {isOwner && page === "domains" && <Domains />}
        {isOwner && page === "users" && <Users mailboxes={mailboxes} />}
        {isOwner && page === "keys" && <ApiKeys mailboxes={mailboxes} />}
        {isOwner && page === "webhooks" && <Webhooks />}
        {isOwner &&
          page === "templates" &&
          (sub.length > 0 ? (
            <TemplateEditor id={sub[0]} navigate={navigate} mailboxes={mailboxes} />
          ) : (
            <Templates />
          ))}
        {isOwner && page === "contacts" && <Contacts onCompose={startCompose} />}
        {isOwner && page === "suppressions" && <Suppressions />}
        {isOwner && page === "audit" && <Audit />}
        {me?.isPlatformAdmin && page === "orgs" && <Orgs />}
        {isOwner && page === "settings" && (
          <Settings mailboxes={mailboxes} domains={domains} reload={boxes.reload} />
        )}

        {!isOwner && TABS.some((t) => t.id === page && t.ownerOnly) && (
          <EmptyState
            icon="block"
            title="Not available on your account"
            body="This section is limited to owners. Ask an owner if you need access."
            action={
              <button className="primary" onClick={() => navigate("inbox")}>
                Back to inbox
              </button>
            }
          />
        )}

        {!TABS.some((t) => t.id === page) && (
          <EmptyState
            icon="alert"
            title="That page does not exist"
            body={`No section is registered at "${page}".`}
            action={
              <button className="primary" onClick={() => navigate("overview")}>
                Back to overview
              </button>
            }
          />
        )}
      </main>

      {openMessage && (
        <MessageSheet
          id={openMessage}
          onClose={() => setOpenMessage(null)}
          onChanged={boxes.reload}
          onOpenOther={setOpenMessage}
          onReply={(m: MessageFull) => {
            setOpenMessage(null);
            setCompose(replySeed(m, me?.signature ?? ""));
          }}
        />
      )}

      {showProfile && me && (
        <Profile
          me={me}
          onClose={() => setShowProfile(false)}
          onSaved={() => {
            setShowProfile(false);
            api.me().then((m) => setMe(m.user));
          }}
        />
      )}

      {showChangePassword && (
        <ChangePassword
          onDone={() => {
            setShowChangePassword(false);
            api.me().then((m) => setMe(m.user));
          }}
        />
      )}

      {compose && (
        <Compose
          mailboxes={mailboxes}
          seed={compose}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null);
            boxes.reload();
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
