import { useState } from "react";
import { api, type Attachment, type MessageEvent, type MessageFull, type ThreadEntry } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  CopyButton,
  Sheet,
  absoluteTime,
  formatBytes,
  relativeTime,
  verdictTone,
} from "../components/ui";
import Icon from "../components/Icon";
import { previewDoc } from "../lib/previewDoc";

type Tab = "rendered" | "plain" | "source" | "headers";

const EVENT_LABEL: Record<string, string> = {
  "email.received": "Received",
  "email.sent": "Sent",
  "email.queued": "Queued",
  "email.delivery_failed": "Delivery failed",
  "email.rejected": "Rejected",
};

function Timeline({ events, message }: { events: MessageEvent[]; message: MessageFull }) {
  // Every message has at least its creation; synthesise one if no event rows exist
  // (messages stored before the events table existed).
  const items =
    events.length > 0
      ? events
      : [
          {
            id: "synthetic",
            type: message.direction === "in" ? "email.received" : "email.sent",
            detail: null,
            createdAt: message.createdAt,
          },
        ];

  return (
    <div className="timeline">
      {items.map((e) => (
        <div className="timeline-item" key={e.id}>
          <div className="timeline-node" />
          <div>
            <div className="spread">
              <strong style={{ fontWeight: 550 }}>{EVENT_LABEL[e.type] ?? e.type}</strong>
              <time className="small muted">{absoluteTime(e.createdAt)}</time>
            </div>
            {e.detail && <div className="small muted mono">{e.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Source({ id }: { id: string }) {
  const raw = useAsync(
    () => fetch(`/api/messages/${id}/raw`, { credentials: "same-origin" }).then((r) => r.text()),
    [id],
  );
  if (raw.loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (raw.error) return <div className="notice bad">{raw.error}</div>;
  return <pre className="body-plain">{raw.data}</pre>;
}

export default function MessageSheet({
  id,
  onClose,
  onReply,
  onChanged,
  onOpenOther,
}: {
  id: string;
  onClose: () => void;
  onReply: (m: MessageFull) => void;
  onChanged: () => void;
  onOpenOther: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("rendered");
  const toast = useToast();
  const state = useAsync(() => api.message(id), [id]);

  if (state.loading) {
    return (
      <Sheet title="Loading" onClose={onClose}>
        <div className="stack">
          <div className="skeleton" style={{ height: 20, width: "60%" }} />
          <div className="skeleton" style={{ height: 12, width: "40%" }} />
          <div className="skeleton" style={{ height: 300 }} />
        </div>
      </Sheet>
    );
  }
  if (state.error || !state.data) {
    return (
      <Sheet title="Message" onClose={onClose}>
        <div className="notice bad">{state.error ?? "Not found."}</div>
      </Sheet>
    );
  }

  const { message, attachments, events, thread, assignable } = state.data as {
    message: MessageFull;
    assignable: { id: string; name: string; email: string }[];
    attachments: Attachment[];
    events: MessageEvent[];
    thread: ThreadEntry[];
  };

  const hasHtml = Boolean(message.bodyHtml);
  const tabs: Tab[] = hasHtml ? ["rendered", "plain", "source", "headers"] : ["plain", "source", "headers"];
  const activeTab = tabs.includes(tab) ? tab : tabs[0];

  return (
    <Sheet
      title={message.subject}
      subtitle={
        <>
          {message.direction === "in" ? "from" : "to"}{" "}
          <span className="mono">
            {message.direction === "in" ? message.fromAddr : message.toAddr}
          </span>{" "}
          · {relativeTime(message.createdAt)}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="primary" onClick={() => onReply(message)}>
            <Icon name="reply" size={14} /> Reply
          </button>
          <button
            onClick={async () => {
              await api.markUnread(message.id);
              onChanged();
              toast("Marked unread");
            }}
          >
            Mark unread
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="danger"
            onClick={async () => {
              await api.deleteMessage(message.id);
              onChanged();
              onClose();
              toast("Message deleted");
            }}
          >
            <Icon name="trash" size={14} /> Delete
          </button>
        </>
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>From</dt>
          <dd className="mono">
            {message.fromName ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr}
          </dd>
          <dt>To</dt>
          <dd className="mono">{message.toAddr}</dd>
          {message.ccAddr && (
            <>
              <dt>Cc</dt>
              <dd className="mono">{message.ccAddr}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>{absoluteTime(message.createdAt)}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(message.size)}</dd>
          {message.rfcMessageId && (
            <>
              <dt>Message-ID</dt>
              <dd className="mono small">{message.rfcMessageId}</dd>
            </>
          )}
        </dl>

        {message.direction === "in" && assignable.length > 0 && (
          <label className="field">
            <span>Assigned to</span>
            <select
              value={message.assignedToUserId ?? ""}
              onChange={async (e) => {
                await api.assign(message.id, e.target.value || null);
                state.reload();
                onChanged();
                toast(e.target.value ? "Assigned" : "Assignment cleared");
              }}
            >
              <option value="">Unassigned</option>
              {assignable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </label>
        )}

        {message.direction === "in" && (
          <div className="row">
            <Badge tone={verdictTone(message.spf)}>SPF {message.spf ?? "n/a"}</Badge>
            <Badge tone={verdictTone(message.dkim)}>DKIM {message.dkim ?? "n/a"}</Badge>
            <Badge tone={verdictTone(message.dmarc)}>DMARC {message.dmarc ?? "n/a"}</Badge>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <h3>Attachments</h3>
            {attachments.map((a) => (
              <div className="attachment" key={a.id}>
                <span className="row">
                  <Icon name="clip" size={14} />
                  <span>{a.filename}</span>
                  <span className="muted small">{formatBytes(a.size)}</span>
                </span>
                <a href={`/api/attachments/${a.id}`} download>
                  <button className="sm">Download</button>
                </a>
              </div>
            ))}
          </div>
        )}

        <div className="spread">
          <h3>Body</h3>
          <div className="segmented">
            {tabs.map((t) => (
              <button key={t} aria-pressed={activeTab === t} onClick={() => setTab(t)}>
                {t === "rendered" ? "HTML" : t === "plain" ? "Text" : t === "source" ? "Source" : "Headers"}
              </button>
            ))}
          </div>
        </div>

        {activeTab === "rendered" && (
          // sandbox="" blocks scripts, forms and same-origin access: remote mail
          // must never be able to reach the dashboard it is displayed in. This
          // is the containment, and it is why inbound HTML is stored as sent
          // rather than sanitised.
          //
          // previewDoc supplies the surrounding document. Handing srcDoc a bare
          // fragment left the body with no doctype, Times New Roman and no
          // constraint on images, so mail rendered nothing like it does in a
          // real client and an oversized logo escaped the pane.
          <iframe
            className="body-frame"
            title="Message body"
            sandbox=""
            srcDoc={previewDoc(message.bodyHtml ?? "")}
          />
        )}
        {activeTab === "plain" && (
          <pre className="body-plain">{message.bodyText || "(no plain text part)"}</pre>
        )}
        {activeTab === "source" &&
          (message.rawKey ? (
            <Source id={message.id} />
          ) : (
            <div className="notice">
              Raw MIME is stored for received mail only. This message was composed here.
            </div>
          ))}
        {activeTab === "headers" && (
          <dl className="kv">
            <dt>Message-ID</dt>
            <dd className="mono small">{message.rfcMessageId ?? "—"}</dd>
            <dt>In-Reply-To</dt>
            <dd className="mono small">{message.inReplyTo ?? "—"}</dd>
            <dt>References</dt>
            <dd className="mono small">{message.msgReferences ?? "—"}</dd>
            <dt>Thread</dt>
            <dd className="mono small">{message.threadId}</dd>
          </dl>
        )}

        <div className="spread">
          <h3>Timeline</h3>
          {message.rfcMessageId && <CopyButton value={message.rfcMessageId} label="Copy ID" />}
        </div>
        <Timeline events={events} message={message} />

        {thread.length > 1 && (
          <>
            <h3>Conversation ({thread.length})</h3>
            <div className="card" style={{ overflow: "hidden" }}>
              <table>
                <tbody>
                  {thread.map((t) => (
                    <tr
                      key={t.id}
                      className="clickable"
                      onClick={() => t.id !== message.id && onOpenOther(t.id)}
                      style={{ opacity: t.id === message.id ? 1 : 0.72 }}
                    >
                      <td style={{ width: 52 }}>
                        <Badge tone={t.direction === "in" ? "info" : "neutral"}>
                          {t.direction}
                        </Badge>
                      </td>
                      <td>
                        <div className="cell-strong truncate">{t.snippet || t.subject}</div>
                        <div className="small muted mono">{t.fromAddr}</div>
                      </td>
                      <td className="num small muted" style={{ width: 84 }}>
                        {relativeTime(t.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
