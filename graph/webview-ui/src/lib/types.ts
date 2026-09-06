// Mirrored types from extension for use in webview

export interface Commit {
  hash: string;
  abbreviatedHash: string;
  author: PersonInfo;
  committer: PersonInfo;
  subject: string;
  body: string;
  parents: string[];
  refs: Ref[];
  /** Present only when the graph is fetched with signature verification on. */
  signatureStatus?: SignatureStatus;
}

/** Simplified 3-state mapping of git's `%G?` verification codes. */
export type SignatureStatus = 'good' | 'none' | 'unverified';

/** On-demand signature details for a single commit (Details panel). */
export interface CommitSignature {
  status: SignatureStatus;
  signer?: string;
  keyId?: string;
}

export interface PersonInfo {
  name: string;
  email: string;
  date: string;
}

export interface Ref {
  type: 'branch' | 'remote-branch' | 'tag' | 'head' | 'stash' | 'working-dir';
  name: string;
  remote?: string;
}

export interface GraphNode {
  commit: string;
  column: number;
  color: string;
  parents: ParentConnection[];
}

export interface ParentConnection {
  hash: string;
  column: number;
  color: string;
  waypoints?: Array<{ row: number; column: number }>;
}

export interface GraphPathData {
  points: Array<{ x: number; y: number }>;
  color: number;
  colorOverride?: string;
}

export interface GraphLinkData {
  start: { x: number; y: number };
  control: { x: number; y: number };
  end: { x: number; y: number };
  color: number;
  colorOverride?: string;
}

export interface GraphDotData {
  center: { x: number; y: number };
  color: number;
  colorOverride?: string;
  type: 'default' | 'head' | 'merge';
  localOnly: boolean;
  remoteTip: boolean;
}

export interface CommitGraphData {
  commits: Commit[];
  graph: GraphNode[];
  paths?: GraphPathData[];
  links?: GraphLinkData[];
  dots?: GraphDotData[];
  commitLeftMargin?: number[];
  hasMore?: boolean;
  currentLimit?: number;
  /** Set by the refresh hot path, which fetches the log WITHOUT signature
   *  verification for speed. Tells the commit store to carry each commit's
   *  last-known signatureStatus forward by hash instead of blanking the badges.
   *  Absent on `getLog` payloads, so toggling the setting off (an intentional
   *  unsigned load) correctly clears them. */
  preserveSignatures?: boolean;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  upstream?: string;
  /** True when the branch still has upstream config but the tracked remote
   *  branch no longer exists (git reports the track field as "gone"). */
  upstreamGone?: boolean;
  ahead: number;
  behind: number;
  hash: string;
  /** Detached-HEAD pseudo-row ("(HEAD detached at <hash>)"). Carries the
   *  current flag for the toolbar indicator; excluded from branch lists. */
  detached?: boolean;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface TagInfo {
  name: string;
  hash: string;
  message?: string;
  isAnnotated: boolean;
}

export interface StashEntry {
  index: number;
  message: string;
  date: string;
}

export interface BranchData {
  branches: BranchInfo[];
  tags: TagInfo[];
  remotes: RemoteInfo[];
  stashes: StashEntry[];
  worktrees: WorktreeInfo[];
}

export interface DiffData {
  file: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isImage: boolean;
  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  fingerprint?: string;
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: ui/diff D3 rename/mode diff-header metadata */
  oldPath?: string;
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  newFile?: boolean;
  deletedFile?: boolean;
  /* SNIPCODE-HOOK end */
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  /* SNIPCODE-HOOK start: ui/diff D2 no-newline-at-EOF marker */
  /** Set when this line is immediately followed by git's `\ No newline at end
   *  of file` marker — i.e. this line has no trailing newline in that blob. */
  noNewline?: boolean;
  /* SNIPCODE-HOOK end */
}

export interface WorktreeInfo {
  path: string;
  hash: string;
  branch: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export interface FlowConfig {
  productionBranch: string;
  developBranch: string;
  featurePrefix: string;
  releasePrefix: string;
  hotfixPrefix: string;
  versionTagPrefix: string;
}

export interface FlowStatus {
  installed: boolean;
  initialized: boolean;
  config: FlowConfig | null;
}

export interface FlowBranches {
  features: string[];
  releases: string[];
  hotfixes: string[];
}

export type FlowType = 'feature' | 'release' | 'hotfix';
