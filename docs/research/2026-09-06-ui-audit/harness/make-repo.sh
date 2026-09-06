#!/usr/bin/env bash
# Build a synthetic git repo that looks like a real team project.
set -euo pipefail

S="${1:?scratchpad}"
REPO="$S/synth-repo"
BARE="$S/synth-origin.git"
rm -rf "$REPO" "$BARE"
mkdir -p "$REPO"
git init -q --bare "$BARE"
cd "$REPO"
git init -q -b main
git config commit.gpgsign false
git remote add origin "$BARE"
git config user.name "Alice Chen"
git config user.email "alice@example.com"

# Deterministic, monotonically increasing clock: one commit every ~37 minutes
# starting 2026-08-01T09:00:00+08:00.
T=$(date -d '2026-08-01T09:00:00+08:00' +%s)
tick() { T=$((T + 2220 + RANDOM % 900)); export GIT_AUTHOR_DATE="@$T +0800" GIT_COMMITTER_DATE="@$T +0800"; }
as() { # as <who>
  case "$1" in
    alice) git config user.name "Alice Chen"; git config user.email "alice@example.com";;
    bob)   git config user.name "Bob Martínez"; git config user.email "bob.martinez@example.com";;
    carol) git config user.name "Carol 王小明"; git config user.email "carol.wang@example.com";;
  esac
}
# c <who> <file> <subject> [body...]
c() {
  local who="$1" file="$2" subj="$3"; shift 3
  as "$who"; tick
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "// $subj" >> "$file"
  git add -A
  if [ $# -gt 0 ]; then git commit -q -m "$subj" "${@/#/-m}"; else git commit -q -m "$subj"; fi
}

# ---- main: bootstrap ----
c alice README.md "Initial commit"
c alice package.json "Add package.json and basic project scaffold"
c bob   src/index.ts "Add application entry point"
c carol src/config/env.ts "Load environment config with sane defaults"
c alice src/utils/logger.ts "Add structured logger (pino) with request-id binding"
git branch develop
git push -q -u origin main develop

# ---- develop: work ----
git checkout -q develop
c bob   src/api/router.ts "Introduce express router with health endpoint"
c carol src/db/client.ts "Add Postgres client with connection pooling"
c alice src/api/users.ts "Users API: list/get endpoints"
c bob   src/api/errors.ts "Central error handler mapping domain errors to HTTP status"
c carol src/db/migrations/0001_init.sql "db: initial schema migration"
c carol src/db/migrations/0002_orders.sql "db: orders table + indexes"
c alice tsconfig.json "chore: enable strict TypeScript"
as alice; tick; git tag -a v1.2.0 -m "Release 1.2.0 — first stable API surface"

# ---- feature/auth-login off develop ----
git checkout -q -b feature/auth-login
c bob src/auth/session.ts "auth: add session store backed by redis"
c bob src/auth/login.ts "auth: implement password login with bcrypt" "Uses cost factor 12. Rate limiting is left for a follow-up." "" "Refs #123"
c carol src/auth/middleware.ts "auth: requireUser middleware and 401 handling"

# ---- meanwhile develop moves on ----
git checkout -q develop
c carol src/api/orders.ts "Orders API: create/list endpoints"
c alice src/api/validation.ts "Add zod request validation for users and orders payloads so malformed bodies are rejected early with a 400 and a machine-readable error code instead of throwing deep inside handlers"

# ---- feature/very-long-branch-name off develop ----
git checkout -q -b feature/very-long-branch-name-for-truncation-testing
c bob src/ui/table.ts "ui: virtualised data table"
c bob src/ui/table.test.ts "ui: table tests"
git push -q -u origin feature/very-long-branch-name-for-truncation-testing

# ---- release/1.3 off develop ----
git checkout -q develop
git checkout -q -b release/1.3
c alice CHANGELOG.md "chore(release): prepare 1.3.0 changelog"
c alice package.json "chore(release): bump version to 1.3.0-rc1"
as alice; tick; git tag -a v1.3.0-rc1 -m "Release candidate 1.3.0-rc1"
git push -q -u origin release/1.3 --tags

# ---- hotfix/1.2.1 off main ----
git checkout -q main
git checkout -q -b hotfix/1.2.1
c carol src/utils/logger.ts "fix(logger): do not leak Authorization header into request logs" "Redact the header before binding it to the child logger." "" "Fixes #131"
c carol src/utils/logger.test.ts "test(logger): cover header redaction"

# hotfix -> main (merge #1), tag v1.2.1
git checkout -q main
as alice; tick; git merge -q --no-ff hotfix/1.2.1 -m "Merge branch 'hotfix/1.2.1'"
git tag v1.2.1
# hotfix -> develop (merge #2)
git checkout -q develop
as alice; tick; git merge -q --no-ff hotfix/1.2.1 -m "Merge branch 'hotfix/1.2.1' into develop"

# ---- feature/auth-login continues, then merges into develop (merge #3) ----
git checkout -q feature/auth-login
c bob src/auth/logout.ts "auth: logout endpoint clears session cookie"
c alice src/auth/README.md "auth: document login flow and the extremely long rationale for choosing server-side sessions over stateless JWTs in this service, including revocation, rotation and the audit-log requirements from the security review"
git push -q -u origin feature/auth-login
git checkout -q develop
as bob; tick; git merge -q --no-ff feature/auth-login -m "Merge branch 'feature/auth-login' into develop" -m "Closes #118, #123"

# ---- more develop work ----
c carol src/api/orders.ts "Orders: paginate list endpoint"
c bob   src/api/router.ts "router: mount auth routes under /auth"
c alice src/api/users.test.ts "test(users): list/get endpoints"
c carol src/db/client.ts "db: retry connect with exponential backoff"
c bob   Dockerfile "build: multi-stage Dockerfile"
git push -q origin develop main --tags

# ---- origin/main gets ahead of local main (remote-only segment) ----
git checkout -q main
c alice docs/deploy.md "docs: add deployment runbook"
c bob   .github/workflows/ci.yml "ci: run tests on pull requests"
c bob   .github/workflows/ci.yml "ci: cache node_modules between jobs"
git push -q origin main
git reset -q --hard HEAD~3

# ---- develop gets local-only commits (not pushed) ----
git checkout -q develop
c alice src/api/users.ts "Users: add avatar upload endpoint"
c carol src/db/migrations/0003_avatars.sql "db: migration for user avatars"
c bob   src/api/users.ts "Users: validate mime type on avatar upload (#140)"

# ---- feature/very-long-branch-name continues locally ----
git checkout -q feature/very-long-branch-name-for-truncation-testing
c bob src/ui/table.ts "ui: sticky header and column resize"
git checkout -q develop

# ---- stash (on develop) ----
printf '// wip: experiment with cursor pagination\n' >> src/api/orders.ts
as alice; tick; git stash push -q -m "WIP: cursor pagination experiment"

# ---- dirty working tree: staged + unstaged on the same file ----
printf 'export const LIMIT = 50;\n' >> src/api/users.ts
git add src/api/users.ts
printf 'export const OFFSET = 0;\n' >> src/api/users.ts
printf '# scratch\n' > NOTES.md   # untracked

git fetch -q origin
echo "repo=$REPO"
git log --oneline --graph --all --decorate | head -70
echo; git branch -vv; echo; git tag -n1; echo; git stash list; echo; git status --short
