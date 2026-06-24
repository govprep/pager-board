// Shared filter for pager message lines before they hit the board.

// Structured pager line patterns — any one match is sufficient.
const STRUCT_RE = /\s-\s|[A-Z]{2,}:|(\[[-\d.,]+\])/;
// Catches repeating garbage like 754]0754]0754]0... or @@@@@@@@
const REPEAT_RE = /(.{3,8})\1{3,}/;
// Catches bracketed-digit decode corruption like 7-72399[47]1[9]
const DECODE_NOISE_RE = /\d\[\d+\]\d*[\[\d]|\[\d+\]\d+\[/;
// End-of-transmission markers and standalone noise words
const NOISE_WORD_RE = /^\s*(STOP|NNTA|NTA)\s*$/i;
// STOP/NNTA embedded in a line, or explicit test pages.
// \bSTOP\b catches turnout-cancel pages like "ALERT- STOP - NO NEED TO ATTEND"
// while leaving longer words (STOPFORD ST, STOPPED) untouched.
const JUNK_RE = /\bNNTA\b|\bSTOP\b|\btest\s+(page|message|call|pager)\b/i;

export function isValidPagerLine(line: string): boolean {
  if (!line || line.length < 5) return false;
  // Must have at least one letter — pure digit/symbol strings are decode noise.
  if (!/[a-zA-Z]/.test(line)) return false;
  // Reject bracketed-digit corruption.
  if (DECODE_NOISE_RE.test(line)) return false;
  // Reject obvious repeating-pattern corruption.
  if (REPEAT_RE.test(line)) return false;
  // Must look like a structured pager line.
  if (!STRUCT_RE.test(line)) return false;
  // Reject end-of-transmission noise and test pages.
  if (NOISE_WORD_RE.test(line)) return false;
  if (JUNK_RE.test(line)) return false;
  // Ignore SES messages entirely.
  if (/\bTURNOUT:\s*SE[A-Z0-9]+|INC:\s*SE[A-Z0-9]+\s+[A-Z]{2,}|^SE[A-Z0-9]+\s+[A-Z]{2,}/i.test(line)) return false;
  return true;
}
