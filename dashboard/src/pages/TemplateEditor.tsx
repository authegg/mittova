import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Template } from "../api";
import { useDismiss, useToast } from "../hooks";
import { Confirm } from "../components/ui";
import Icon from "../components/Icon";
import CodeEditor from "../components/CodeEditor";
import AddressPicker from "../components/AddressPicker";
import {
  DetailsPanel,
  HistoryPanel,
  TestEmailPanel,
  VariablesPanel,
} from "../components/TemplatePanels";
import { fillVariables, variablesIn } from "../lib/variables";
import { previewDoc } from "../lib/previewDoc";
import { formatHtml } from "../lib/formatHtml";

const STARTER = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:32px 12px">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;padding:32px">
        <tr>
          <td style="font-size:16px;line-height:1.6;color:#1a1917">
            <p style="margin:0 0 16px">Hello {{NAME}},</p>
            <p style="margin:0 0 24px">Write the message here.</p>
            <a href="{{ACTION_URL}}" style="display:inline-block;background:#1a1917;color:#ffffff;padding:11px 20px;border-radius:6px;text-decoration:none">Open</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

/**
 * The envelope above the preview: the headers, edited where they are read.
 *
 * From and Reply-To are defaults the template carries, not a binding — leaving
 * From blank means the send decides. Every row is labelled, including Subject:
 * a bare bold line under two labelled rows reads as a heading, not a field.
 */
function Envelope({
  addresses,
  from,
  onFrom,
  replyTo,
  onReplyTo,
  subject,
  onSubject,
}: {
  addresses: string[];
  from: string;
  onFrom: (v: string) => void;
  replyTo: string;
  onReplyTo: (v: string) => void;
  subject: string;
  onSubject: (v: string) => void;
}) {
  const [showReplyTo, setShowReplyTo] = useState(Boolean(replyTo));
  const unknown = from !== "" && !addresses.includes(from.toLowerCase());

  return (
    <div className="tpl-envelope">
      <div className="tpl-env-row">
        <span className="tpl-env-label">From</span>
        <AddressPicker
          value={from}
          onChange={onFrom}
          options={addresses}
          invalid={unknown}
          ariaLabel="From"
        />
        {!showReplyTo && (
          <button className="tpl-env-add" onClick={() => setShowReplyTo(true)}>
            Reply-To
          </button>
        )}
      </div>

      {unknown && (
        <div className="tpl-env-warn small">
          Not a mailbox on this account, so sending would fail.
        </div>
      )}

      {showReplyTo && (
        <div className="tpl-env-row">
          <span className="tpl-env-label">Reply-To</span>
          <AddressPicker
            value={replyTo}
            onChange={onReplyTo}
            options={addresses}
            ariaLabel="Reply-To"
            autoFocus
          />
          {replyTo === "" && (
            <button
              className="tpl-env-add"
              onClick={() => setShowReplyTo(false)}
              aria-label="Remove Reply-To"
            >
              Remove
            </button>
          )}
        </div>
      )}

      <div className="tpl-env-row subject">
        <span className="tpl-env-label">Subject</span>
        <input
          className="tpl-env-subject"
          value={subject}
          onChange={(e) => onSubject(e.target.value)}
          placeholder="Subject line"
          aria-label="Subject"
        />
      </div>
    </div>
  );
}

/**
 * The editable half of a template.
 *
 * One object rather than seven useState pairs, because the field list was
 * written out seven times — the states, the two baseline literals, the setters
 * after load, and the create and update payloads — and adding a field meant
 * finding all of them. The two baselines in particular had to stay key-for-key
 * identical to what `dirty` serialised, or the unsaved badge stuck on forever.
 */
interface Form {
  slug: string;
  name: string;
  subject: string;
  fromAddress: string;
  replyTo: string;
  bodyHtml: string;
  bodyText: string;
}

const BLANK: Form = {
  slug: "",
  name: "",
  subject: "",
  fromAddress: "",
  replyTo: "",
  bodyHtml: "",
  bodyText: "",
};

/** The editable fields of a stored template, and nothing else. */
function formOf(t: Template): Form {
  return {
    slug: t.slug,
    name: t.name,
    subject: t.subject,
    fromAddress: t.fromAddress ?? "",
    replyTo: t.replyTo ?? "",
    bodyHtml: t.bodyHtml ?? "",
    bodyText: t.bodyText,
  };
}

export default function TemplateEditor({
  id,
  navigate,
  mailboxes,
}: {
  id: string;
  navigate: (to: string) => void;
  /** Offered as senders; a template is not bound to one. */
  mailboxes: { id: string; address: string }[];
}) {
  const toast = useToast();
  const isNew = id === "new";

  const start: Form = isNew ? { ...BLANK, bodyHtml: STARTER } : BLANK;
  const [loading, setLoading] = useState(!isNew);
  const [loaded, setLoaded] = useState<Template | null>(null);
  const [form, setForm] = useState<Form>(start);
  const [baseline, setBaseline] = useState<Form>(start);
  const { slug, name, subject, fromAddress, replyTo, bodyHtml, bodyText } = form;
  /** Set one field, leaving the rest alone. */
  const set = useCallback(
    <K extends keyof Form>(key: K) =>
      (v: Form[K]) =>
        setForm((f) => ({ ...f, [key]: v })),
    [],
  );
  const [tab, setTab] = useState<"html" | "text">("html");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuWrap = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const [confirming, setConfirming] = useState(false);
  type Panel = "details" | "test" | "variables" | "history";
  const [panel, setPanel] = useState<Panel | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline]);

  useEffect(() => {
    if (isNew) return;
    let live = true;
    api
      .template(id)
      .then((t) => {
        if (!live) return;
        setLoaded(t);
        setForm(formOf(t));
        setBaseline(formOf(t));
      })
      .catch((e: Error) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) {
          toast("That template no longer exists", "bad");
          navigate("templates");
          return;
        }
        setError(e.message);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, isNew, navigate, toast]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useDismiss(menu, menuWrap, closeMenu);

  const addresses = mailboxes.map((m) => m.address);

  const variables = useMemo(
    () => variablesIn(subject, bodyHtml, bodyText),
    [subject, bodyHtml, bodyText],
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const made = await api.createTemplate({ ...form, name: name || slug });
        toast("Template created");
        navigate(`templates/${made.id}`);
      } else {
        // The slug is immutable, so it is not sent; everything else is.
        const { slug: _slug, ...patch } = form;
        await api.updateTemplate(id, patch);
        setBaseline(form);
        toast("Template saved");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    setMenu(false);
    setBusy(true);
    setError(null);
    try {
      const copy = await api.duplicateTemplate(id);
      toast(`Duplicated as ${copy.slug}`);
      navigate(`templates/${copy.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyHtml() {
    try {
      await navigator.clipboard.writeText(tab === "html" ? bodyHtml : bodyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast("Could not reach the clipboard", "bad");
    }
  }

  if (loading) {
    return (
      <div className="tpl-editor">
        <div className="tpl-bar">
          <div className="skeleton" style={{ width: 220, height: 14 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="tpl-editor">
      <header className="tpl-bar">
        <nav className="tpl-crumbs">
          <a href="#/templates">Templates</a>
          <span className="tpl-crumb-sep">/</span>
          {/* Edited in place: the name is a label, and sending you to a form
              field elsewhere to change a label is a detour. */}
          <input
            className="tpl-name"
            value={name}
            onChange={(e) => set("name")(e.target.value)}
            placeholder="Untitled template"
            aria-label="Template name"
            size={Math.max(12, Math.min(38, (name || "Untitled template").length))}
          />
          {isNew ? (
            <input
              className="tpl-slug mono"
              value={slug}
              onChange={(e) => set("slug")(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="order-receipt"
              aria-label="Slug"
              size={16}
            />
          ) : (
            <span
              className="tpl-slug mono muted"
              title="The slug is how the API refers to this template, so it cannot change"
            >
              {slug}
            </span>
          )}
          {dirty && <span className="badge warn">Unsaved</span>}
        </nav>

        <div className="row" style={{ gap: 8 }}>
          {!isNew && (
            <div className="navmenu" ref={menuWrap}>
              <button
                className="sm"
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label="Template actions"
                onClick={() => setMenu(!menu)}
              >
                <Icon name="sliders" size={14} />
              </button>
              {menu && (
                <div className="navmenu-panel wide right" role="menu">
                  {/* Things you do *with* the template, then things you do *to*
                      it, then the destructive one on its own. */}
                  <button
                    className="navmenu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setPanel("test");
                    }}
                  >
                    <Icon name="paper" size={14} />
                    <span className="navmenu-label">Test email</span>
                    <span className="navmenu-note">Send it to yourself</span>
                  </button>
                  <button
                    className="navmenu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setPanel("variables");
                    }}
                  >
                    <Icon name="code" size={14} />
                    <span className="navmenu-label">Variables</span>
                    <span className="navmenu-note">{variables.length || "none"}</span>
                  </button>
                  <button
                    className="navmenu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setPanel("history");
                    }}
                  >
                    <Icon name="history" size={14} />
                    <span className="navmenu-label">Version history</span>
                  </button>
                  <button
                    className="navmenu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setPanel("details");
                    }}
                  >
                    <Icon name="info" size={14} />
                    <span className="navmenu-label">View details</span>
                  </button>

                  <div className="navmenu-sep" />

                  <button className="navmenu-item" role="menuitem" onClick={duplicate}>
                    <Icon name="copy" size={14} />
                    <span className="navmenu-label">Duplicate</span>
                  </button>
                  <button
                    className="navmenu-item danger"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setConfirming(true);
                    }}
                  >
                    <Icon name="trash" size={14} />
                    <span className="navmenu-label">Delete</span>
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="primary sm" onClick={save} disabled={busy || (!dirty && !isNew)}>
            {busy ? "Saving" : isNew ? "Create template" : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </header>

      {error && <div className="notice bad tpl-error">{error}</div>}

      <div className="tpl-split">
        <section className="tpl-pane">
          <div className="tpl-pane-head">
            <button
              className={`tpl-tab${tab === "html" ? " on" : ""}`}
              onClick={() => setTab("html")}
            >
              HTML
            </button>
            <button
              className={`tpl-tab${tab === "text" ? " on" : ""}`}
              onClick={() => setTab("text")}
            >
              Plain text
            </button>
            <span className="grow" />
            {variables.length > 0 && (
              <span className="small muted" title={variables.join(", ")}>
                {variables.length} variable{variables.length === 1 ? "" : "s"}
              </span>
            )}
            {tab === "html" && (
              <button
                className="ghost sm icon-only"
                title="Reformat"
                aria-label="Reformat"
                onClick={() => set("bodyHtml")(formatHtml(bodyHtml))}
              >
                <Icon name="format" size={14} />
              </button>
            )}
            <button
              className="ghost sm icon-only"
              title="Copy to clipboard"
              aria-label="Copy to clipboard"
              onClick={copyHtml}
            >
              <Icon name={copied ? "check" : "copy"} size={14} />
            </button>
          </div>

          {tab === "html" ? (
            <CodeEditor
              value={bodyHtml}
              onChange={set("bodyHtml")}
              placeholder="<table>…</table>"
            />
          ) : (
            <textarea
              className="tpl-plain"
              value={bodyText}
              onChange={(e) => set("bodyText")(e.target.value)}
              placeholder="The fallback for clients that will not render HTML. Worth writing: some people read mail this way on purpose."
            />
          )}
        </section>

        <section className="tpl-pane preview">
          <Envelope
            addresses={addresses}
            from={fromAddress}
            onFrom={set("fromAddress")}
            replyTo={replyTo}
            onReplyTo={set("replyTo")}
            subject={subject}
            onSubject={set("subject")}
          />
          <PreviewFrame html={fillVariables(bodyHtml, values)} />
        </section>
      </div>

      {panel === "variables" && (
        <VariablesPanel
          variables={variables}
          values={values}
          onChange={setValues}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "details" && loaded && (
        <DetailsPanel
          template={{ ...loaded, slug, name, subject, fromAddress, replyTo }}
          variables={variables}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "test" && loaded && (
        <TestEmailPanel
          template={{ ...loaded, slug, fromAddress }}
          mailboxes={mailboxes}
          variables={variables}
          values={values}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "history" && loaded && (
        <HistoryPanel
          template={loaded}
          onRestored={() => window.location.reload()}
          onClose={() => setPanel(null)}
        />
      )}

      {confirming && (
        <Confirm
          title={`Delete ${slug}?`}
          body={
            <>
              This cannot be undone. Anything calling the send API with{" "}
              <span className="mono">template: "{slug}"</span> will start failing.
            </>
          }
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            try {
              await api.deleteTemplate(id);
              toast("Template deleted");
              navigate("templates");
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

/** Sandboxed with nothing granted: source being typed has passed no sanitiser. */
function PreviewFrame({ html }: { html: string }) {
  const [settled, setSettled] = useState(html);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setSettled(html), 220);
    return () => clearTimeout(t);
  }, [html]);

  return <iframe title="Preview" sandbox="" className="tpl-frame" srcDoc={previewDoc(settled)} />;
}
