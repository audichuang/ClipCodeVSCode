// Read many committed blobs in ONE `git cat-file --batch` process instead of one
// `git show` per file. The vscode.git API serializes per-repo operations, so
// firing N concurrent show() calls still runs roughly serially — batching into a
// single process is what actually makes "Copy Full Source" of many files fast.
//
// Protocol (`git cat-file --batch`): for each `<rev>:<path>` line on stdin, git
// writes either `<oid> <type> <size>\n<size bytes>\n` or `<input> missing\n`,
// responses in request order.

/** stdin for `git cat-file --batch`: one `<hash>:<relativePath>` per line. */
export function formatBatchRequest(hash: string, relativePaths: string[]): string {
  return relativePaths.map(p => `${hash}:${p}`).join('\n') + '\n';
}

/**
 * Parse `git cat-file --batch` stdout against the request order. Returns a map
 * from relativePath to its text content, or `undefined` for a missing object or
 * binary content (a NUL byte) — matching the per-file reader's skip behaviour.
 */
export function parseCatFileBatch(stdout: Buffer, relativePaths: string[]): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  let offset = 0;

  for (const path of relativePaths) {
    const lineEnd = stdout.indexOf(0x0a, offset); // next LF = end of header line
    if (lineEnd === -1) break; // truncated/short output: leave the rest unresolved
    const header = stdout.toString('utf8', offset, lineEnd);
    offset = lineEnd + 1;

    if (header.endsWith(' missing')) {
      result.set(path, undefined);
      continue;
    }

    // "<oid> <type> <size>" — size is the last space-separated field.
    const size = Number(header.slice(header.lastIndexOf(' ') + 1));
    if (!Number.isFinite(size) || size < 0 || offset + size > stdout.length) {
      result.set(path, undefined); // malformed header: skip rather than mis-read
      continue;
    }

    const body = stdout.subarray(offset, offset + size);
    offset += size + 1; // skip the content bytes and the trailing LF git appends
    result.set(path, body.includes(0x00) ? undefined : body.toString('utf8'));
  }

  return result;
}
