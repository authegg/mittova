import { useEffect, useRef, useState } from "react";
import { previewDoc } from "../lib/previewDoc";

/**
 * A template rendered as it will arrive, shrunk to a card.
 *
 * Rendered in a sandboxed iframe with no allowances at all: template HTML is
 * authored markup with images and inline styles, and even though the sanitiser
 * has already been over it, a preview is not a reason to run it in the
 * dashboard's own origin.
 *
 * srcdoc rather than a data: URL, because a data: URL is a separate origin that
 * some browsers refuse to size, and the content is laid out at full width and
 * scaled down so the proportions match a real mail client rather than a
 * reflowed narrow column.
 */
const RENDER_WIDTH = 680;

export default function TemplatePreview({ html }: { html: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / RENDER_WIDTH);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!html) {
    return (
      <div className="tpl-preview empty" ref={box}>
        <span className="small muted">Plain text only</span>
      </div>
    );
  }

  return (
    <div className="tpl-preview" ref={box}>
      <iframe
        title="Template preview"
        sandbox=""
        loading="lazy"
        scrolling="no"
        style={{
          width: RENDER_WIDTH,
          height: RENDER_WIDTH * 1.3,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
        srcDoc={previewDoc(html)}
      />
    </div>
  );
}
