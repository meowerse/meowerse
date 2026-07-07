import { useState } from "react";

/**
 * Avatar with a guaranteed fallback. The Telegram photo (served from the auth
 * host `/avatar/<id>`) can 404 (hash changed after a photo update), be hidden
 * (privacy), or be absent (bot-deeplink login) — so a bad/missing URL degrades
 * to the display-name initial in a circle, never a broken image.
 *
 * Two safeguards work together (spec §10): this initials fallback + the CSP
 * `img-src` allowlist in public/_headers (without which the <img> is blocked).
 */
export function Avatar({ url, name, size = "md" }: {
  url: string | null | undefined;
  name: string | null | undefined;
  size?: "sm" | "md" | "lg";
}) {
  const [broken, setBroken] = useState(false);
  const label = (name ?? "").trim();
  const initial = (label[0] ?? "?").toUpperCase();
  const showImg = !!url && !broken;
  return (
    <span
      className={`mw-avatar mw-avatar--${size}`}
      aria-label={label || "avatar"}
      style={{ overflow: "hidden", flex: "none" }}
    >
      {showImg ? (
        <img
          src={url ?? undefined}
          alt=""
          width="100%"
          height="100%"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={() => setBroken(true)}
        />
      ) : (
        <span aria-hidden="true" className="mono" data-case="preserve">{initial}</span>
      )}
    </span>
  );
}
