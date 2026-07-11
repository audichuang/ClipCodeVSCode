// Parses `git blame --porcelain` output into per-line commit metadata.
// The porcelain format prints the full author/summary block only the FIRST
// time a commit appears; later lines from the same commit print just the
// "<sha> <orig> <final> [<count>]" header, so metadata is cached by sha.

const ZERO_SHA = '0000000000000000000000000000000000000000';

export interface BlameCommit {
  sha: string;
  author: string;
  authorTime: number;
  summary: string;
  isUncommitted: boolean;
}

export interface BlameLine {
  finalLine: number;
  commit: BlameCommit;
}

const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const cache = new Map<string, BlameCommit>();
  const result: BlameLine[] = [];
  const lines = stdout.split('\n');

  let currentSha: string | undefined;
  let currentFinalLine = 0;
  // Mutable fields collected between a header line and its `\t` content line.
  let author = '';
  let authorTime = 0;
  let summary = '';

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      currentSha = header[1];
      currentFinalLine = Number(header[3]);
      const cached = cache.get(currentSha);
      if (cached) {
        author = cached.author;
        authorTime = cached.authorTime;
        summary = cached.summary;
      }
      continue;
    }
    if (line.startsWith('author ')) {
      author = line.slice('author '.length);
    } else if (line.startsWith('author-time ')) {
      authorTime = Number(line.slice('author-time '.length));
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length);
    } else if (line.startsWith('\t') && currentSha) {
      let commit = cache.get(currentSha);
      if (!commit) {
        commit = {
          sha: currentSha,
          author,
          authorTime,
          summary,
          isUncommitted: currentSha === ZERO_SHA
        };
        cache.set(currentSha, commit);
      }
      result.push({ finalLine: currentFinalLine, commit });
    }
  }
  return result;
}
