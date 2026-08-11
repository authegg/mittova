import { api } from "../api";
import { useAsync, useToast } from "../hooks";
import { Card, EmptyState, TableSkeleton, relativeTime } from "../components/ui";
import TemplatePreview from "../components/TemplatePreview";
import Icon from "../components/Icon";

export default function Templates() {
  const toast = useToast();
  const list = useAsync(() => api.templates(true), []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Templates</h1>
          <p>
            Reusable subject and body pairs with <span className="mono">{"{{variable}}"}</span>{" "}
            placeholders, usable from the composer or by passing{" "}
            <span className="mono">template</span> to the send API.
          </p>
        </div>
        <a className="btn primary" href="#/templates/new">
          <Icon name="plus" size={14} /> New template
        </a>
      </div>

      {list.loading ? (
        <Card tight>
          <TableSkeleton rows={3} cols={3} />
        </Card>
      ) : (list.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon="stencil"
            title="No templates"
            body="Save a message you send often — a receipt, a password reset, an onboarding note — and fill in the details at send time."
            action={
              <a className="btn primary" href="#/templates/new">
                Create a template
              </a>
            }
          />
        </Card>
      ) : (
        /* A gallery rather than a table: a template is recognised by its shape
           long before its slug is read, and a row of text hides the one thing
           that distinguishes them. */
        <div className="tpl-grid">
          {(list.data ?? []).map((t) => (
            <article key={t.id} className="tpl-card">
              <a className="tpl-thumb" href={`#/templates/${t.id}`} title={`Edit ${t.slug}`}>
                <TemplatePreview html={t.previewHtml ?? null} />
              </a>

              <div className="tpl-meta">
                <div className="tpl-titles">
                  <div className="cell-strong truncate">{t.name}</div>
                  <div className="mono small muted truncate">{t.slug}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <a className="btn sm" href={`#/templates/${t.id}`}>
                    Edit
                  </a>
                  <button
                    className="danger sm"
                    onClick={async () => {
                      await api.deleteTemplate(t.id);
                      list.reload();
                      toast("Template deleted");
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>

              <div className="tpl-sub small muted truncate">
                {t.subject || <span className="muted">(no subject)</span>}
                <span className="tpl-when"> · {relativeTime(t.updatedAt)}</span>
              </div>
            </article>
          ))}
        </div>
      )}

    </>
  );
}
