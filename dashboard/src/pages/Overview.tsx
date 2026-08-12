import { api } from "../api";
import { useAsync } from "../hooks";
import { Badge, Card, EmptyState, relativeTime, TableSkeleton } from "../components/ui";
import Icon from "../components/Icon";

type Day = { day: string; inbound: number; outbound: number };

function shortDay(iso?: string): string {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function ActivityChart({ series }: { series: Day[] }) {
  const peak = Math.max(1, ...series.map((d) => d.inbound + d.outbound));
  const totalIn = series.reduce((n, d) => n + d.inbound, 0);
  const totalOut = series.reduce((n, d) => n + d.outbound, 0);
  const busiest = series.reduce<Day | null>(
    (best, d) => (!best || d.inbound + d.outbound > best.inbound + best.outbound ? d : best),
    null,
  );
  const perDay = ((totalIn + totalOut) / Math.max(1, series.length)).toFixed(1);

  return (
    <div className="chart-wrap">
      <div className="chart-plot">
        {/* Quartile gridlines: without them a quiet week reads as a broken empty box. */}
        <div className="chart-grid" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="chart-yaxis" aria-hidden="true">
          <span>{peak}</span>
          <span>0</span>
        </div>

        <div
          className="chart"
          role="img"
          aria-label={`Message volume over the last ${series.length} days. ${totalIn} received, ${totalOut} sent.`}
        >
          {series.map((d) => {
            const total = d.inbound + d.outbound;
            return (
              <div
                className="chart-col"
                key={d.day}
                title={`${d.day} — ${d.inbound} received, ${d.outbound} sent`}
              >
                {d.outbound > 0 && (
                  <div
                    className="chart-bar out"
                    style={{ height: `${(d.outbound / peak) * 100}%` }}
                  />
                )}
                {d.inbound > 0 && (
                  <div
                    className="chart-bar in"
                    style={{ height: `${(d.inbound / peak) * 100}%` }}
                  />
                )}
                {total === 0 && (
                  <div className="chart-bar out" style={{ height: 2, opacity: 0.45 }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="chart-axis">
        <span>{shortDay(series[0]?.day)}</span>
        <span>{shortDay(series[series.length - 1]?.day)}</span>
      </div>

      <dl className="chart-stats">
        <div className="chart-stat">
          <dt>Busiest day</dt>
          <dd>
            {busiest && busiest.inbound + busiest.outbound > 0 ? shortDay(busiest.day) : "—"}
            {busiest && busiest.inbound + busiest.outbound > 0 && (
              <span className="small muted" style={{ fontWeight: 400 }}>
                {" "}
                · {busiest.inbound + busiest.outbound}
              </span>
            )}
          </dd>
        </div>
        <div className="chart-stat">
          <dt>Per day</dt>
          <dd>{perDay}</dd>
        </div>
        <div className="chart-stat">
          <dt>In / out</dt>
          <dd>
            {totalIn}{" "}
            <span className="muted" style={{ fontWeight: 400 }}>
              /
            </span>{" "}
            {totalOut}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function MailboxList({
  navigate,
  loading,
  boxes,
  canCreate,
}: {
  navigate: (to: string) => void;
  loading: boolean;
  boxes: {
    id: string;
    address: string;
    unread: number;
    received: number;
    sent: number;
    sent24h: number;
    dailySendLimit: number;
  }[];
  canCreate: boolean;
}) {
  if (loading) return <TableSkeleton rows={4} cols={2} />;
  if (boxes.length === 0) {
    return (
      <EmptyState
        icon="tray"
        title={canCreate ? "No mailboxes yet" : "No mailboxes assigned"}
        body={
          canCreate
            ? "Create one in Settings, then add a routing rule so Cloudflare delivers to it."
            : "Ask an owner to give you access to a mailbox and it will appear here."
        }
        action={
          canCreate ? (
            <button className="primary" onClick={() => navigate("settings")}>
              Open settings
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {boxes.map((m) => (
            <tr key={m.id} className="clickable" onClick={() => navigate("inbox")}>
              <td>
                <div className="cell-strong truncate">{m.address.split("@")[0]}</div>
                <div className="small muted">
                  {m.received} in · {m.sent} out
                </div>
              </td>
              <td className="num" style={{ width: 132, whiteSpace: "nowrap" }}>
                {m.unread > 0 ? (
                  <span className="badge info">{m.unread} new</span>
                ) : (
                  <span className="small muted">read</span>
                )}
                <div className="small muted" style={{ marginTop: 3 }}>
                  {m.sent24h}/{m.dailySendLimit} today
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Overview({
  navigate,
  isOwner,
  name,
  onOpenMessage,
}: {
  navigate: (to: string) => void;
  isOwner: boolean;
  name: string;
  onOpenMessage: (id: string) => void;
}) {
  const stats = useAsync(() => api.stats(14), []);
  const boxes = useAsync(() => api.mailboxes(), []);
  // Infrastructure health is an owner concern, and /domains is owner-only.
  const domain = useAsync(() => (isOwner ? api.domains() : Promise.resolve([])), [isOwner]);
  const queue = useAsync(
    () => (isOwner ? Promise.resolve(null) : api.messages({ needsReply: true, limit: 8 })),
    [isOwner],
  );

  if (stats.error) return <div className="notice bad">{stats.error}</div>;

  const t = stats.data?.totals;
  const authRate = t && t.authChecked > 0 ? Math.round((t.dmarcPass / t.authChecked) * 100) : null;

  const statuses = domain.data ?? [];
  const dns = statuses.reduce(
    (acc, d) => ({ ok: acc.ok + d.summary.ok, total: acc.total + d.summary.total }),
    { ok: 0, total: 0 },
  );
  const dnsHealthy = dns.total > 0 && dns.ok === dns.total;
  const checkedAt = statuses[0]?.checkedAt;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isOwner ? "Overview" : `Welcome back, ${name.split(" ")[0]}`}</h1>
          <p>
            {isOwner
              ? "Traffic across every mailbox on this domain, and the health of the DNS records that decide whether your mail reaches an inbox."
              : "What is waiting for you across the mailboxes you work."}
          </p>
        </div>
        <button className="primary" onClick={() => navigate(isOwner ? "emails" : "inbox")}>
          {isOwner ? "View all email" : "Open inbox"}
        </button>
      </div>

      <div className="metrics rise">
        {isOwner ? (
          <>
            <div className="metric">
              <div className="metric-label">Messages</div>
              <div className="metric-value">{t?.total ?? "—"}</div>
              <div className="metric-sub">
                {t ? `${t.inbound} received · ${t.outbound} sent` : "loading"}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">Unread</div>
              <div className="metric-value">{t?.unread ?? "—"}</div>
              <div className="metric-sub">across all mailboxes</div>
            </div>
            <div className="metric">
              <div className="metric-label">DMARC pass</div>
              <div className="metric-value">{authRate === null ? "—" : `${authRate}%`}</div>
              <div className="metric-sub">
                {t?.authChecked ? `of ${t.authChecked} checked` : "no inbound yet"}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">DNS health</div>
              <div className="metric-value">{dns.total ? `${dns.ok}/${dns.total}` : "—"}</div>
              <div className="metric-sub">
                {dnsHealthy ? "all records verified" : "needs attention"}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="metric">
              <div className="metric-label">Needs a reply</div>
              <div className="metric-value">{t?.needsReply ?? "—"}</div>
              <div className="metric-sub">conversations where they spoke last</div>
            </div>
            <div className="metric">
              <div className="metric-label">Unread</div>
              <div className="metric-value">{t?.unread ?? "—"}</div>
              <div className="metric-sub">not yet opened</div>
            </div>
            <div className="metric">
              <div className="metric-label">Received</div>
              <div className="metric-value">{t?.inbound ?? "—"}</div>
              <div className="metric-sub">in your mailboxes</div>
            </div>
            <div className="metric">
              <div className="metric-label">Replies sent</div>
              <div className="metric-value">{t?.outbound ?? "—"}</div>
              <div className="metric-sub">all time</div>
            </div>
          </>
        )}
      </div>

      <div className="grid-2">
        <Card
          title="Activity"
          action={
            <div className="legend">
              <span>
                <i style={{ background: "var(--ink)" }} />
                Received
              </span>
              <span>
                <i style={{ background: "var(--line-strong)" }} />
                Sent
              </span>
            </div>
          }
        >
          {stats.loading ? (
            <div className="skeleton" style={{ flex: 1, minHeight: 190 }} />
          ) : (
            <ActivityChart series={stats.data?.series ?? []} />
          )}
        </Card>

        <Card title={isOwner ? "Mailboxes" : "Your mailboxes"} tight>
          {/* Capped and scrolled: this sits beside the activity chart, and a
              deployment with twenty mailboxes stretched the row to several
              times the chart's height, leaving the chart stranded in white
              space at the top. */}
          <div className="panel-scroll">
            <MailboxList
              navigate={navigate}
              loading={boxes.loading}
              boxes={boxes.data ?? []}
              canCreate={isOwner}
            />
          </div>
        </Card>
      </div>

      <div style={{ height: 20 }} />

      {isOwner ? (
        <Card
          title="Domain authentication"
          action={
            <button className="sm" onClick={() => navigate("domains")}>
              Details
            </button>
          }
          tight
        >
          {domain.loading ? (
            <TableSkeleton rows={3} cols={3} />
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {statuses
                    .flatMap((d) => d.records)
                    .map((r) => (
                      <tr key={`${r.type}-${r.name}`}>
                        <td style={{ width: 44 }}>
                          <Icon
                            name={r.status === "ok" ? "check" : "alert"}
                            size={15}
                            className={r.status === "ok" ? "" : "muted"}
                          />
                        </td>
                        <td className="cell-strong">{r.purpose}</td>
                        <td className="mono small muted truncate" style={{ width: 300 }}>
                          {r.name}
                        </td>
                        <td style={{ width: 96 }}>
                          <span className={`badge ${r.status === "ok" ? "ok" : "bad"}`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {checkedAt && (
            <div className="small muted" style={{ padding: "10px 14px" }}>
              Resolved over public DNS {relativeTime(checkedAt)} — this is what receiving servers
              see, not what Cloudflare has stored.
            </div>
          )}
        </Card>
      ) : (
        <Card
          title="Waiting on you"
          action={
            <button className="sm" onClick={() => navigate("inbox")}>
              Open inbox
            </button>
          }
          tight
        >
          {queue.loading ? (
            <TableSkeleton rows={4} cols={3} />
          ) : (queue.data?.messages ?? []).length === 0 ? (
            <EmptyState
              icon="check"
              title="Nothing waiting"
              body="Every conversation in your mailboxes has had a reply. New mail will show up here."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 220 }}>From</th>
                    <th>Subject</th>
                    <th style={{ width: 110 }} className="num">
                      Waiting
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(queue.data?.messages ?? []).map((m) => (
                    <tr
                      key={m.id}
                      className={`clickable${m.seen ? "" : " unread"}`}
                      onClick={() => onOpenMessage(m.id)}
                    >
                      <td className="mono small truncate">{m.fromAddr}</td>
                      <td>
                        <div className="truncate cell-strong">{m.subject}</div>
                        <div className="truncate small muted">{m.snippet}</div>
                      </td>
                      <td className="num small muted">
                        <Badge tone={Date.now() - m.createdAt > 86_400_000 ? "warn" : "neutral"}>
                          {relativeTime(m.createdAt)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
