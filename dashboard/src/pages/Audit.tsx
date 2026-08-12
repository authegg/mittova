import { api } from "../api";
import { useAsync, useToast } from "../hooks";
import {
  Badge,
  Card,
  EmptyState,
  TableSkeleton,
  absoluteTime,
  compactTime,
  formatBytes,
  relativeTime,
  Pager,
} from "../components/ui";
import { usePaged } from "../hooks-paging";

const TONE: Record<string, "bad" | "warn" | "neutral"> = {
  "mailbox.delete": "bad",
  "user.delete": "bad",
  "apikey.revoke": "warn",
  "apikey.create": "warn",
  "user.update": "warn",
  "user.mailboxes": "warn",
};

export default function Audit() {
  const toast = useToast();
  const log = useAsync(() => api.audit(), []);
  const backups = useAsync(() => api.backups(), []);
  const entries = log.data ?? [];
  const paged = usePaged(entries);
  const files = backups.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <p>
            Every action that changed access or destroyed data, and the nightly backups. Reads are
            deliberately not logged — a trail nobody can scan is worse than none.
          </p>
        </div>
        <button
          onClick={async () => {
            try {
              const r = await api.runBackup();
              toast(`Backup written (${formatBytes(r.bytes)})`);
              backups.reload();
            } catch (err) {
              toast((err as Error).message, "bad");
            }
          }}
        >
          Back up now
        </button>
      </div>

      <div className="notice" style={{ marginBottom: 16 }}>
        A backup contains password hashes, API key hashes and webhook signing secrets — it has to,
        or restoring would lock everyone out. Treat the file as a credential and keep the R2 bucket
        private.
      </div>

      <Card title="Backups" tight>
        {backups.loading ? (
          <TableSkeleton rows={3} cols={3} />
        ) : files.length === 0 ? (
          <EmptyState
            icon="copy"
            title="No backups yet"
            body="A backup runs nightly on the Worker's cron trigger. You can also take one now."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Object</th>
                  <th style={{ width: 110 }} className="num">
                    Size
                  </th>
                  <th style={{ width: 180 }} className="num">
                    Taken
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((b) => (
                  <tr key={b.key}>
                    <td className="mono small truncate">{b.key}</td>
                    <td className="num small muted">{formatBytes(b.size)}</td>
                    <td className="num small muted">{relativeTime(Date.parse(b.uploaded))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ height: 20 }} />

      <Card title="Activity" tight>
        {log.loading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon="pulse"
            title="Nothing recorded yet"
            body="Creating a mailbox, changing a user, or revoking a key will show up here."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>Action</th>
                    <th style={{ width: 230 }}>Actor</th>
                    <th>Target</th>
                    <th style={{ width: 180 }} className="num">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Badge tone={TONE[e.action] ?? "neutral"}>{e.action}</Badge>
                      </td>
                      <td className="mono small truncate">{e.actorEmail}</td>
                      <td className="truncate">
                        <span className="cell-strong">{e.target || "—"}</span>
                        {e.detail && <span className="small muted"> · {e.detail}</span>}
                      </td>
                      <td className="num small muted">{compactTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={paged.page}
              pageCount={paged.pageCount}
              total={paged.total}
              shown={paged.slice.length}
              onPage={paged.setPage}
            />
          </>
        )}
      </Card>
    </>
  );
}
