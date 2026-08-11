/**
 * The document a mail body renders inside.
 *
 * Shared by the template gallery card, the editor's live pane and the received
 * message viewer: they are views of the same kind of thing, and when this lived
 * in each file a change to the base styling had to be made everywhere or the
 * views stopped agreeing about what the mail looks like.
 *
 * System fonts, not the dashboard's Geist — a recipient does not have it, and
 * the preview should not flatter the message with a font it will never render
 * in. Anything the mail styles itself still wins, since inline style beats this
 * sheet.
 *
 * The image rule is what keeps a body inside its pane. Senders routinely ship a
 * logo at its full asset size and leave the client to scale it: one arriving
 * here was 3404px wide, rendered at 3404px, and pushed the whole invoice off to
 * the right behind a horizontal scrollbar. height:auto keeps the aspect ratio
 * when a width/height attribute pair is overridden by the max-width.
 */
export function previewDoc(html: string): string {
  return `<!doctype html><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff;color:#1a1917;
      font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
    img{max-width:100%;height:auto}
  </style>${html}`;
}
