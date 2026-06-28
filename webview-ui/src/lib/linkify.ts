export interface LinkRule {
  pattern: string;
  url: string;
}

export type Segment = { text: string } | { text: string; url: string };

const MAX_MATCHES = 200;

interface Candidate {
  start: number;
  end: number;
  url: string;
  ruleIndex: number;
}

function substitute(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\d+)/g, (_, d: string) => match[Number(d)] ?? '');
}

/**
 * Split `text` into non-overlapping text/link segments. Rules are tried in
 * order; at any position the earliest rule wins. A substituted URL must be
 * http(s) to become a link. Invalid regexes are skipped. Returns a single
 * text segment when nothing matches.
 */
export function linkify(text: string, rules: LinkRule[]): Segment[] {
  if (!text) return [{ text }];

  const candidates: Candidate[] = [];
  rules.forEach((rule, ruleIndex) => {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'g');
    } catch {
      return; // invalid regex — skip
    }
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++; // avoid infinite loop on zero-length matches
        continue;
      }
      const url = substitute(rule.url, m);
      if (/^https?:\/\//i.test(url)) {
        candidates.push({ start: m.index, end: m.index + m[0].length, url, ruleIndex });
      }
      if (candidates.length >= MAX_MATCHES * rules.length) break;
    }
  });

  if (candidates.length === 0) return [{ text }];

  // Earliest start wins; ties broken by rule order, then longer match.
  candidates.sort((a, b) =>
    a.start - b.start || a.ruleIndex - b.ruleIndex || b.end - a.end);

  const segments: Segment[] = [];
  let cursor = 0;
  let used = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // overlaps an already-placed link
    if (used >= MAX_MATCHES) break;
    if (c.start > cursor) segments.push({ text: text.slice(cursor, c.start) });
    segments.push({ text: text.slice(c.start, c.end), url: c.url });
    cursor = c.end;
    used++;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
