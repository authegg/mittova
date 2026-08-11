import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Draft, type Mailbox, type MessageSummary } from "../api";
import { useAsync, usePoll } from "../hooks";
import { Badge, Card, EmptyState, TableSkeleton, relativeTime, verdictTone } from "../components/ui";
import Icon from "../components/Icon";

export default function Emails({
  mailboxes,
  mode,
  onOpen,
  onCompose,
  onResumeDraft,
}: {
  mailboxes: Mailbox[];
  mode: "all" | "inbox";
  onOpen: (id: string) => void;
  onCompose: () => void;
  onResumeDraft: (draft: Draft) => void;
}) {
  const [q, setQ] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [direction, setDirection] = useState(mode === "inbox" ? "in" : "");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [assigned, setAssigned] = useState<"" | "me" | "none">("");
  const [view, setView] = useState<"" | "archived" | "starred">("");

  // One piece of paging state instead of two kept in sync by an extra effect.
  const [more, setMore] = useState<{ rows: MessageSummary[]; cursor: number | null }>({
    rows: [],
    cursor: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);

  // The filter set is written once and reused for the query, the deps and the
  // reset key, so adding a filter cannot be half-applied.
  const filters = {
    q,
    mailboxId,
    direction,
    unread: unreadOnly,
    assigned: assigned || undefined,
    view: view || undefined,
    limit: 50,
  };
  const filterKey = JSON.stringify(filters);

  const list = useAsync(() => api.messages(filters), [filterKey]);
  const drafts = useAsync(() => api.drafts().catch(() => [] as Draft[]), []);
  usePoll(list.reload);

  // Reset paging when the filters change. Keying this on list.data instead
  // would also fire on the 20s poll, discarding pages already loaded.
  useEffect(() => {
    setMore({ rows: [], cursor: null });
  }, [filterKey]);

  useEffect(() => setFlags({}), [filterKey]);

  const cursor = more.rows.length ? more.cursor : (list.data?.nextBefore ?? null);

  const [flags, setFlags] = useState<Record<string, { archived?: number; starred?: number }>>({});

  /** Optimistic: reloading 50 joined rows to toggle one bit is wasteful. */
  const flag = useCallback(async (id: string, patch: { archived?: boolean; starred?: boolean }) => {
    const numeric = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, v ? 1 : 0]),
    ) as { archived?: number; starred?: number };
    setFlags((prev) => ({ ...prev, [id]: { ...prev[id], ...numeric } }));
    try {
      await api.flag(id, patch);
    } catch {
      setFlags((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  // Dedupe with a Set, memoised: a poll refreshes page one and new mail shifts
  // the boundary, so a message can appear in both the fresh page and an older
  // one. The previous findIndex form was O(n^2) on every render.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [...(list.data?.messages ?? []), ...more.rows]
      .filter((m) => !seen.has(m.id) && seen.add(m.id))
      .map((m) => (flags[m.id] ? { ...m, ...flags[m.id] } : m));
  }, [list.data, more.rows, flags]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.messages({ ...filters, before: cursor });
      setMore((prev) => ({ rows: [...prev.rows, ...page.messages], cursor: page.nextBefore }));
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, filterKey]);
  const filtersActive = Boolean(
    q || mailboxId || unreadOnly || assigned || (mode === "all" && direction),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{mode === "inbox" ? "Inbox" : "Email"}</h1>
          <p>
            {mode === "inbox"
              ? "Everything Cloudflare Email Routing has delivered into a Mittova mailbox."
              : "Every message this account has sent or received, newest first."}
          </p>
        </div>
        <button
          className="primary"
          onClick={onCompose}
          disabled={mailboxes.length === 0}
          title={
            mailboxes.length === 0
              ? "You have no mailbox assigned, so there is no address to send from."
              : undefined
          }
        >
          <Icon name="plus" size={14} /> Compose
        </button>
      </div>

      <div className="toolbar">
        <div className="search grow">
          <Icon name="search" size={14} />
          <input
            placeholder="Search subject, sender, recipient or body"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search messages"
          />
        </div>

        <select
          value={mailboxId}
          onChange={(e) => setMailboxId(e.target.value)}
          style={{ width: "auto" }}
          aria-label="Filter by mailbox"
        >
          <option value="">All mailboxes</option>
          {mailboxes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.address}
            </option>
          ))}
        </select>

        {mode === "all" && (
          <div className="segmented">
            {[
              ["", "All"],
              ["in", "Received"],
              ["out", "Sent"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={direction === value}
                onClick={() => setDirection(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
          {unreadOnly ? "Unread only" : "All states"}
        </button>

        <select
          value={view}
          onChange={(e) => setView(e.target.value as "" | "archived" | "starred")}
          style={{ width: "auto" }}
          aria-label="Filter by view"
        >
          <option value="">Inbox</option>
          <option value="starred">Starred</option>
          <option value="archived">Archived</option>
        </select>

        <select
          value={assigned}
          onChange={(e) => setAssigned(e.target.value as "" | "me" | "none")}
          style={{ width: "auto" }}
          aria-label="Filter by assignment"
        >
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
      </div>

      {(drafts.data ?? []).length > 0 && (
        <div style={{ marginBottom: 16 }}>
        <Card
          title="Unsent drafts"
          action={<span className="small muted">{(drafts.data ?? []).length}</span>}
          tight
        >
          <div className="table-wrap">
            <table>
              <tbody>
                {(drafts.data ?? []).map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => onResumeDraft(d)}>
                    <td className="mono small truncate" style={{ width: 220 }}>
                      {d.toAddr || "(no recipient)"}
                    </td>
                    <td className="truncate cell-strong">{d.subject || "(no subject)"}</td>
                    <td className="num small muted" style={{ width: 110 }}>
                      {relativeTime(d.updatedAt)}
                    </td>
                    <td style={{ width: 90 }}>
                      <button
                        className="danger sm"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await api.deleteDraft(d.id);
                          drafts.reload();
                        }}
                      >
                        Discard
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        </div>
      )}

      <section className="card">
        {list.error && <div className="card-body"><div className="notice bad">{list.error}</div></div>}

        {list.loading && rows.length === 0 ? (
          <TableSkeleton rows={8} cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={mailboxes.length === 0 ? "block" : mode === "inbox" ? "tray" : "paper"}
            title={
              mailboxes.length === 0
                ? "No mailbox assigned to you"
                : filtersActive
                  ? "Nothing matches those filters"
                  : "No messages yet"
            }
            body={
              mailboxes.length === 0
                ? "Your account has no mailbox yet, so there is nothing to read and no address to send from. An owner can assign one under Users."
                : filtersActive
                  ? "Try a broader search, or clear the mailbox and state filters."
                  : "Send a test message to one of your mailboxes and it will appear here within a few seconds."
            }
            action={
              mailboxes.length === 0 ? undefined : filtersActive ? (
                <button
                  onClick={() => {
                    setQ("");
                    setMailboxId("");
                    setUnreadOnly(false);
                    setAssigned("");
                    setView("");
                    if (mode === "all") setDirection("");
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <button className="primary" onClick={onCompose}>
                  Compose a message
                </button>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 72 }}>Dir</th>
                  <th style={{ width: 190 }}>{mode === "inbox" ? "From" : "Correspondent"}</th>
                  <th>Subject</th>
                  <th style={{ width: 186 }}>Auth</th>
                  <th style={{ width: 92 }} className="num">
                    When
                  </th>
                  <th style={{ width: 78 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr
                    key={m.id}
                    className={`clickable${m.seen ? "" : " unread"}`}
                    onClick={() => onOpen(m.id)}
                  >
                    <td>
                      <Badge tone={m.direction === "in" ? "info" : "neutral"}>
                        {m.direction === "in" ? "in" : "out"}
                      </Badge>
                    </td>
                    <td className="truncate mono small">
                      {m.direction === "in" ? m.fromAddr : m.toAddr}
                    </td>
                    <td>
                      <div className="truncate cell-strong">{m.subject}</div>
                      <div className="truncate small muted">{m.snippet}</div>
                    </td>
                    <td>
                      {m.direction === "in" ? (
                        <div className="row" style={{ gap: 4 }}>
                          <Badge tone={verdictTone(m.spf)}>spf</Badge>
                          <Badge tone={verdictTone(m.dkim)}>dkim</Badge>
                          <Badge tone={verdictTone(m.dmarc)}>dmarc</Badge>
                        </div>
                      ) : (
                        <span className="small muted">signed by Cloudflare</span>
                      )}
                    </td>
                    <td className="num small muted">
                      <time dateTime={new Date(m.createdAt).toISOString()}>
                        {relativeTime(m.createdAt)}
                      </time>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 2 }}>
                        <button
                          className="ghost sm icon-only"
                          aria-label={m.starred ? "Unstar" : "Star"}
                          aria-pressed={Boolean(m.starred)}
                          title={m.starred ? "Unstar" : "Star"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void flag(m.id, { starred: !m.starred });
                          }}
                        >
                          <Icon name={m.starred ? "star-filled" : "star"} size={14} />
                        </button>
                        <button
                          className="ghost sm icon-only"
                          aria-label={m.archived ? "Move back to inbox" : "Archive"}
                          title={m.archived ? "Move back to inbox" : "Archive"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void flag(m.id, { archived: !m.archived });
                          }}
                        >
                          <Icon name="archive" size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cursor && rows.length > 0 && (
          <div style={{ padding: 14, borderTop: "1px solid var(--line)", textAlign: "center" }}>
            <button onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading" : "Load older messages"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
