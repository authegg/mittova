import { useCallback, useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";

/**
 * Rich text editor over contenteditable.
 *
 * Uses document.execCommand. It is deprecated, but it is implemented in every
 * browser, and the alternative — hand-rolling Range/Selection surgery for bold,
 * lists and links — is a large amount of fragile code for a composer that only
 * needs a handful of email-safe constructs. The server sanitises whatever comes
 * out, so browser quirks in the emitted markup are a formatting problem, never
 * a security one.
 */

interface Tool {
  id: string;
  cmd: string;
  arg?: string;
  icon: IconName;
  label: string;
  shortcut?: string;
}

const GROUPS: Tool[][] = [
  [
    { id: "bold", cmd: "bold", icon: "bold", label: "Bold", shortcut: "⌘B" },
    { id: "italic", cmd: "italic", icon: "italic", label: "Italic", shortcut: "⌘I" },
    { id: "underline", cmd: "underline", icon: "underline", label: "Underline", shortcut: "⌘U" },
    { id: "strikeThrough", cmd: "strikeThrough", icon: "strike", label: "Strikethrough" },
  ],
  [
    {
      id: "insertUnorderedList",
      cmd: "insertUnorderedList",
      icon: "list-bullet",
      label: "Bulleted list",
    },
    {
      id: "insertOrderedList",
      cmd: "insertOrderedList",
      icon: "list-number",
      label: "Numbered list",
    },
    { id: "blockquote", cmd: "formatBlock", arg: "blockquote", icon: "quote", label: "Quote" },
    { id: "pre", cmd: "formatBlock", arg: "pre", icon: "code", label: "Code block" },
  ],
];

export default function RichText({
  value,
  onChange,
  ariaLabel = "Message body",
  minHeight = 240,
  placeholder = "Write your message…",
}: {
  value: string;
  onChange: (html: string) => void;
  ariaLabel?: string;
  minHeight?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [inLink, setInLink] = useState(false);

  // Emit <p> instead of <div> for Enter, so the markup matches what the
  // sanitiser and mail clients expect. Must be set before the first edit.
  useEffect(() => {
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      /* not supported everywhere; the sanitiser copes with divs too */
    }
  }, []);

  // Only write into the DOM when the incoming value diverges, otherwise React
  // resets the caret to the start on every keystroke.
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== value) el.innerHTML = value;
  }, [value]);

  const sync = useCallback(() => {
    onChange(ref.current?.innerHTML ?? "");
  }, [onChange]);

  const refreshActive = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const t of GROUPS.flat()) {
      try {
        next[t.id] = t.arg
          ? document.queryCommandValue("formatBlock").toLowerCase() === t.arg
          : document.queryCommandState(t.cmd);
      } catch {
        next[t.id] = false;
      }
    }
    setActive(next);

    const sel = window.getSelection();
    const node = sel?.anchorNode;
    setInLink(
      Boolean(node && (node.parentElement?.closest("a") ?? null)),
    );
  }, []);

  function run(tool: Tool) {
    ref.current?.focus();
    // Toggle a block format off by returning it to a paragraph.
    if (tool.arg && active[tool.id]) {
      document.execCommand("formatBlock", false, "p");
    } else {
      document.execCommand(tool.cmd, false, tool.arg);
    }
    sync();
    refreshActive();
  }

  function toggleLink() {
    ref.current?.focus();
    if (inLink) {
      document.execCommand("unlink");
      sync();
      refreshActive();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      window.alert("Select the text you want to turn into a link first.");
      return;
    }
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      window.alert("Links must start with http://, https:// or mailto:");
      return;
    }
    document.execCommand("createLink", false, url);
    sync();
    refreshActive();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "k") {
      e.preventDefault();
      toggleLink();
      return;
    }
    if (["b", "i", "u"].includes(key)) {
      // The browser handles these natively; just keep our state in sync.
      requestAnimationFrame(refreshActive);
    }
  }

  const isEmpty = !value || value === "<br>" || value === "<p><br></p>";

  return (
    <div className="editor">
      <div className="editor-bar" role="toolbar" aria-label="Formatting">
        {GROUPS.map((group, gi) => (
          <div className="editor-group" key={gi}>
            {group.map((t) => (
              <button
                key={t.id}
                type="button"
                className="ghost sm icon-only"
                aria-label={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
                aria-pressed={Boolean(active[t.id])}
                title={t.shortcut ? `${t.label}  ${t.shortcut}` : t.label}
                // mousedown, not click: click blurs the editor and loses the selection.
                onMouseDown={(e) => {
                  e.preventDefault();
                  run(t);
                }}
              >
                <Icon name={t.icon} size={15} />
              </button>
            ))}
          </div>
        ))}

        <div className="editor-group">
          <button
            type="button"
            className="ghost sm icon-only"
            aria-label={inLink ? "Remove link" : "Insert link (⌘K)"}
            aria-pressed={inLink}
            title={inLink ? "Remove link" : "Insert link  ⌘K"}
            onMouseDown={(e) => {
              e.preventDefault();
              toggleLink();
            }}
          >
            <Icon name={inLink ? "unlink" : "link"} size={15} />
          </button>
          <button
            type="button"
            className="ghost sm icon-only"
            aria-label="Clear formatting"
            title="Clear formatting"
            onMouseDown={(e) => {
              e.preventDefault();
              ref.current?.focus();
              document.execCommand("removeFormat");
              document.execCommand("unlink");
              sync();
              refreshActive();
            }}
          >
            <Icon name="clear-format" size={15} />
          </button>
        </div>
      </div>

      <div
        ref={ref}
        className={`editor-body${isEmpty ? " is-empty" : ""}`}
        style={{ minHeight }}
        data-placeholder={placeholder}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        onInput={sync}
        onKeyDown={onKeyDown}
        onKeyUp={refreshActive}
        onMouseUp={refreshActive}
        onFocus={refreshActive}
        onBlur={() => setActive({})}
        onPaste={(e) => {
          // Paste as plain text: pasted Word/web markup is the main source of
          // mail that renders badly, and the server would strip most of it.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, text);
          sync();
        }}
      />
    </div>
  );
}
