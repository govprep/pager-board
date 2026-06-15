// Shared filter for pager message lines before they hit the board.

const STRUCT_RE = /\s-\s|[A-Z]{2,}:|(\[[-\d.,]+\])/;
// Catches repeating garbage like 754]0754]0754]0... or @@@@@@@@
const REPEAT_RE = /(.{3,8})\1{3,}/;

export function isValidPagerLine(line: string): boolean {
  if (!line || line.length < 5) return false;
  // Must have at least one letter — pure digit/symbol strings are decode noise.
  if (!/[a-zA-Z]/.test(line)) return false;
  // Reject obvious repeating-pattern corruption.
  if (REPEAT_RE.test(line)) return false;
  // Must look like a structured pager line.
  if (!STRUCT_RE.test(line)) return false;
  // Reject test pages.
  if (/\btest\s+(page|message|call|pager)\b/i.test(line)) return false;
  return true;
}
