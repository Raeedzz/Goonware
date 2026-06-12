import { useEffect, useState } from "react";
import { AuthorDot } from "./HistoryView";

/**
 * Real profile photo for a commit author, derived from the commit
 * email alone (no API tokens): GitHub noreply addresses map straight
 * to the user's GitHub avatar; anything else tries Gravatar by
 * SHA-256 hash with `d=404` so misses error out. The initial-letter
 * AuthorDot renders underneath and stays visible until a photo
 * actually paints over it, so loading and lookup failure both
 * degrade to the offline-friendly dot.
 */

/** `12345+user@users.noreply.github.com` (current) or
    `user@users.noreply.github.com` (pre-2017). */
function githubAvatarUrl(email: string, px: number): string | null {
  const m = email.match(/^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i);
  if (!m) return null;
  return m[1]
    ? `https://avatars.githubusercontent.com/u/${m[1]}?s=${px}`
    : `https://github.com/${m[2]}.png?size=${px}`;
}

async function gravatarUrl(email: string, px: number): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://www.gravatar.com/avatar/${hash}?s=${px}&d=404`;
}

export function AuthorAvatar({
  name,
  email,
  size = 32,
}: {
  name: string;
  email: string;
  size?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    const px = size * 2; // retina
    const github = githubAvatarUrl(email, px);
    if (github) {
      setSrc(github);
      return;
    }
    void gravatarUrl(email, px).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [email, size]);

  return (
    <span
      title={name}
      style={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <AuthorDot name={name} size={size} />
      {src && !failed && (
        <img
          src={src}
          alt=""
          aria-hidden
          onError={() => setFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: size,
            height: size,
            borderRadius: "var(--radius-pill)",
            objectFit: "cover",
          }}
        />
      )}
    </span>
  );
}
