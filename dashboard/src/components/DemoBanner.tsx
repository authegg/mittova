import type { DemoInfo } from "../api";

/**
 * The standing notice on demo.mittova.com.
 *
 * Rendered only when `/api/auth/me` reports a demo, so it cannot appear on a
 * deployment holding real mail. Three things a visitor has to know before they
 * touch anything, and all three are stated plainly rather than softened: what
 * they do here will not last, nothing they write will reach anybody, and none of
 * the mail they are reading is real.
 *
 * Not dismissible. A visitor who closes it and then wonders why their work
 * vanished on the hour has been failed by the interface, and the whole point of
 * the demo is that nothing about it should be surprising.
 */
export default function DemoBanner({ demo }: { demo: DemoInfo }) {
  return (
    <div className="demo-banner" role="status">
      <p>
        <strong>This is a live demo.</strong> Everything resets on the hour, sending is disabled,
        and every message, address and organization here is fabricated.
      </p>
      {demo.password && (
        <p className="demo-banner-credentials">
          To sign back in, the password is <code>{demo.password}</code> with an empty email field.
        </p>
      )}
    </div>
  );
}
