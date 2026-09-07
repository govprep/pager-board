/** Only established browser push services may receive our signed notifications. */
export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    // URL normalizes explicit :443 away; reject it in the original authority too.
    const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
    if (url.protocol !== "https:" || !authority || authority.includes(":") || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname;
    return url.pathname.length > 1 && (
      host === "fcm.googleapis.com" || host === "android.googleapis.com" ||
      host === "updates.push.services.mozilla.com" || host === "web.push.apple.com" ||
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(host)
    );
  } catch { return false; }
}

export function isPushKey(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length !== Math.ceil(bytes * 8 / 6)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === bytes && decoded.toString("base64url") === unpadded &&
    (bytes !== 65 || decoded[0] === 4);
}

export function isIncidentNumber(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
