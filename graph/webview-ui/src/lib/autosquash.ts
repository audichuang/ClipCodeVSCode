/**
 * Client-side autosquash arrangement for the interactive rebase UI.
 *
 * Mirrors `git rebase --autosquash`: `fixup! <subject>` / `squash! <subject>`
 * commits are moved directly below the commit they target and their action is
 * set to `fixup` / `squash`. The actual rebase is still applied through the
 * existing interactiveRebase path — this only rearranges the todo list.
 */

export interface AutosquashTodo {
  action: 'pick' | 'squash' | 'fixup' | 'reword' | 'edit' | 'drop';
  hash: string;
  subject: string;
  body: string;
  newMessage?: string;
}

const PREFIX_RE = /^(fixup|squash)! (.+)$/;

interface Parsed {
  kind: 'fixup' | 'squash';
  /** The subject the prefix points at (the text after `fixup! ` / `squash! `). */
  target: string;
}

function parsePrefix(subject: string): Parsed | null {
  const m = PREFIX_RE.exec(subject);
  if (!m) return null;
  return { kind: m[1] as 'fixup' | 'squash', target: m[2] };
}

/** True if any todo is a `fixup!` / `squash!` commit that could be autosquashed. */
export function hasAutosquashTargets(todos: AutosquashTodo[]): boolean {
  return todos.some(t => parsePrefix(t.subject) !== null);
}

/**
 * Returns a new todo array with fixup!/squash! commits grouped under their
 * targets. Non-matching commits keep their relative order. A fixup!/squash!
 * with no preceding target is left as `pick` in place.
 */
export function applyAutosquash(todos: AutosquashTodo[]): AutosquashTodo[] {
  // Resolve each commit's "match key": the subject git would compare against.
  // For a fixup!/squash! commit, that is the inner target subject; chaining
  // (`fixup! fixup! X`) collapses to the innermost subject so the whole chain
  // lands on the same target group.
  const matchKey = (subject: string): string => {
    let s = subject;
    let parsed = parsePrefix(s);
    while (parsed) {
      s = parsed.target;
      parsed = parsePrefix(s);
    }
    return s;
  };

  // Build the result by walking the original order. Each non-fixup commit
  // anchors a group; matching fixup!/squash! commits attach to the nearest
  // preceding group with the same key.
  const result: AutosquashTodo[] = [];
  // Index in `result` of the last todo belonging to each group key.
  const groupEnd = new Map<string, number>();

  for (const todo of todos) {
    const parsed = parsePrefix(todo.subject);
    if (parsed) {
      const key = matchKey(todo.subject);
      const insertAfter = groupEnd.get(key);
      if (insertAfter !== undefined) {
        const placed: AutosquashTodo = { ...todo, action: parsed.kind, newMessage: undefined };
        result.splice(insertAfter + 1, 0, placed);
        // Shift group-end indices that sit at/after the insertion point, then
        // extend this group's end to the freshly placed member. A later chained
        // fixup (`fixup! fixup! X`) resolves to the same key and attaches here.
        for (const [k, idx] of groupEnd) {
          if (idx > insertAfter) groupEnd.set(k, idx + 1);
        }
        groupEnd.set(key, insertAfter + 1);
        continue;
      }
      // No preceding target — leave as pick where it is.
      result.push({ ...todo });
      groupEnd.set(todo.subject, result.length - 1);
      continue;
    }
    // Regular commit: anchors a group keyed by its subject.
    result.push({ ...todo });
    groupEnd.set(todo.subject, result.length - 1);
  }

  // Guard: the first todo can never be squash/fixup.
  if (result.length > 0 && (result[0].action === 'squash' || result[0].action === 'fixup')) {
    result[0] = { ...result[0], action: 'pick', newMessage: undefined };
  }

  return result;
}
