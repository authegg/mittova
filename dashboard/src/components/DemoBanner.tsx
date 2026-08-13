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
/**
 * Why every DNS record on the demo reads as missing.
 *
 * Shown on both the Overview and the Domain page, from here rather than from
 * each of them: it is the same explanation about the same panel, and written
 * twice it had already drifted into two wordings before it shipped.
 */
export function DemoDnsNotice() {
  return (
    <div className="notice demo-dns-notice">
      Every record below is missing, and that is correct: the demo&rsquo;s domains are fabricated{" "}
      <code>.example</code> names that have no DNS and never will. This panel reports what public
      DNS actually returns, so there is nothing for it to find. On your own deployment it is where
      your MX, SPF, DKIM and DMARC records are verified, and where a domain is onboarded for
      sending.
    </div>
  );
}

export default function DemoBanner({ demo }: { demo: DemoInfo }) {
  return (
    <div className="demo-banner" role="status">
      <p>
        <strong>This is a live demo.</strong> Everything resets on the hour, sending is disabled,
        and every message, address and organization here is fabricated.
      </p>
      {demo.password && (
        <p>
          To sign back in, the password is <code>{demo.password}</code> with an empty email field.
        </p>
      )}
    </div>
  );
}
