import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentText } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const USER_ARTIFACT_ID_RE = /\bU\d{4,}\b/g;

export type UserArtifactKind = "plan" | "spec" | "requirements" | "correction" | "log" | "evidence" | "other";
export type UserArtifactAuthority = "governing" | "supporting";

export interface UserArtifactLocator {
  id: string;
  sourceSessionId?: string;
}

export interface UserArtifactSessionSource {
  sessionId: string;
  sessionFile?: string;
  inherited: boolean;
}

export interface UserArtifactRecord {
  id: string;
  sha256: string;
  timestamp: number;
  chars: number;
  preview: string;
  file: string;
  /** Runtime provenance; manifests remain session-local and omit these fields. */
  sourceSessionId?: string;
  inherited?: boolean;
}

interface UserArtifactManifestV1 {
  version: 1;
  nextId: number;
  artifacts: UserArtifactRecord[];
}

export interface DurableUserReference {
  id: string;
  sourceSessionId?: string;
  state: "active" | "cooling";
  misses: number;
  kind?: UserArtifactKind;
  authority?: UserArtifactAuthority;
  semanticNote?: string;
}

export interface PreviousUserArtifactState {
  knownIds: string[];
  knownArtifacts: UserArtifactLocator[];
  references: DurableUserReference[];
  /** Timestamp of the checkpoint that produced the legacy state, for provenance migration. */
  checkpointTimestamp?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "unknown-session";
}

function sessionDir(sessionId: string): string {
  return path.join(getAgentDir(), "state", "one-round-compaction", "sessions", safeSegment(sessionId));
}

function artifactDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), "user-artifacts");
}

function manifestPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "user-artifacts.json");
}

function emptyManifest(): UserArtifactManifestV1 {
  return { version: 1, nextId: 1, artifacts: [] };
}

function parseManifest(value: unknown): UserArtifactManifestV1 {
  if (!isObject(value)) return emptyManifest();
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.flatMap((item): UserArtifactRecord[] => {
        if (!isObject(item)) return [];
        if (
          typeof item.id !== "string" ||
          typeof item.sha256 !== "string" ||
          typeof item.timestamp !== "number" ||
          typeof item.chars !== "number" ||
          typeof item.preview !== "string" ||
          typeof item.file !== "string"
        ) return [];
        return [{
          id: item.id,
          sha256: item.sha256,
          timestamp: item.timestamp,
          chars: item.chars,
          preview: item.preview,
          file: item.file,
        }];
      })
    : [];
  const maxSeen = artifacts.reduce((max, artifact) => {
    const parsed = Number.parseInt(artifact.id.slice(1), 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  const requestedNext = typeof value.nextId === "number" && Number.isInteger(value.nextId) && value.nextId > 0
    ? value.nextId
    : 1;
  return { version: 1, nextId: Math.max(requestedNext, maxSeen + 1), artifacts };
}

export async function loadUserArtifactManifest(sessionId: string): Promise<UserArtifactManifestV1> {
  try {
    return parseManifest(JSON.parse(await readFile(manifestPath(sessionId), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    throw error;
  }
}

async function readSessionHeader(filePath: string): Promise<{ id: string; parentSession?: string } | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) return undefined;
    const value = JSON.parse(firstLine) as unknown;
    if (!isObject(value) || value.type !== "session" || typeof value.id !== "string" || !value.id.trim()) return undefined;
    return {
      id: value.id.trim(),
      ...(typeof value.parentSession === "string" && value.parentSession.trim()
        ? { parentSession: value.parentSession.trim() }
        : {}),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Current session first, then nearest persisted parentSession ancestors. */
export async function resolveUserArtifactSessionSources(params: {
  currentSessionId: string;
  currentSessionFile?: string;
  parentSession?: string;
  maxDepth?: number;
}): Promise<UserArtifactSessionSource[]> {
  const sources: UserArtifactSessionSource[] = [{
    sessionId: params.currentSessionId,
    ...(params.currentSessionFile ? { sessionFile: params.currentSessionFile } : {}),
    inherited: false,
  }];
  const seenIds = new Set([params.currentSessionId]);
  const seenFiles = new Set<string>();
  let parentSession = params.parentSession;
  let relativeTo = params.currentSessionFile;
  const maxDepth = Math.max(0, Math.min(params.maxDepth ?? 8, 32));
  for (let depth = 0; depth < maxDepth && parentSession; depth++) {
    const parentFile = path.isAbsolute(parentSession)
      ? path.normalize(parentSession)
      : path.resolve(relativeTo ? path.dirname(relativeTo) : process.cwd(), parentSession);
    if (seenFiles.has(parentFile)) break;
    seenFiles.add(parentFile);
    const header = await readSessionHeader(parentFile);
    if (!header) break;
    if (seenIds.has(header.id)) break;
    seenIds.add(header.id);
    sources.push({ sessionId: header.id, sessionFile: parentFile, inherited: true });
    parentSession = header.parentSession;
    relativeTo = parentFile;
  }
  return sources;
}

export async function loadUserArtifactCatalog(sources: UserArtifactSessionSource[]): Promise<UserArtifactRecord[]> {
  const records: UserArtifactRecord[] = [];
  for (const source of sources) {
    const manifest = await loadUserArtifactManifest(source.sessionId);
    records.push(...manifest.artifacts.map((record) => ({
      ...record,
      sourceSessionId: source.sessionId,
      inherited: source.inherited,
    })));
  }
  return records;
}

export function userArtifactKey(value: UserArtifactLocator): string {
  return `${value.sourceSessionId ?? ""}\u0000${value.id}`;
}

export function maxUserArtifactOrdinal(records: UserArtifactRecord[]): number {
  return records.reduce((max, record) => {
    const parsed = Number.parseInt(record.id.slice(1), 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
}

export function userArtifactHashes(records: UserArtifactRecord[]): Set<string> {
  return new Set(records.map((record) => record.sha256));
}

export function userArtifactRecordsOnBranch(artifacts: UserArtifactRecord[], branchEntries: SessionEntry[]): UserArtifactRecord[] {
  const byHash = new Map<string, UserArtifactRecord>();
  // Catalog order is current session, then nearest ancestors. Prefer the closest exact copy.
  for (const artifact of artifacts) if (!byHash.has(artifact.sha256)) byHash.set(artifact.sha256, artifact);
  const records: UserArtifactRecord[] = [];
  const seen = new Set<string>();
  for (const entry of branchEntries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = contentText(entry.message.content, "");
    if (!text.trim()) continue;
    const artifact = byHash.get(createHash("sha256").update(text).digest("hex"));
    if (!artifact) continue;
    const key = userArtifactKey(artifact);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(artifact);
  }
  return records;
}

async function saveManifest(sessionId: string, manifest: UserArtifactManifestV1): Promise<void> {
  const dir = sessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  const target = manifestPath(sessionId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

function previewText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Save exact oversized user text once per session, deduplicated by SHA-256. */
export async function storeUserArtifact(params: {
  sessionId: string;
  text: string;
  timestamp: number;
  thresholdChars: number;
  previewChars: number;
  minNextId?: number;
}): Promise<UserArtifactRecord | undefined> {
  if (params.text.length < params.thresholdChars) return undefined;
  const sha256 = createHash("sha256").update(params.text).digest("hex");
  const manifest = await loadUserArtifactManifest(params.sessionId);
  const existing = manifest.artifacts.find((artifact) => artifact.sha256 === sha256);
  if (existing) return existing;

  const nextId = Math.max(manifest.nextId, params.minNextId ?? 1);
  const id = `U${String(nextId).padStart(4, "0")}`;
  const file = `${id}-${sha256.slice(0, 12)}.md`;
  const record: UserArtifactRecord = {
    id,
    sha256,
    timestamp: params.timestamp,
    chars: params.text.length,
    preview: previewText(params.text, params.previewChars),
    file,
  };
  await mkdir(artifactDir(params.sessionId), { recursive: true });
  await writeFile(path.join(artifactDir(params.sessionId), file), params.text, "utf8");
  manifest.artifacts.push(record);
  manifest.nextId = nextId + 1;
  await saveManifest(params.sessionId, manifest);
  return record;
}

/**
 * Backfill exact oversized messages already present in a resumed session. This
 * intentionally inspects only persisted message entries whose native role is
 * `user`; custom/subagent notifications become LLM-user messages later and must
 * never be mistaken for human input.
 */
export function userArtifactIdsOnBranch(artifacts: UserArtifactRecord[], branchEntries: SessionEntry[]): string[] {
  const byHash = new Map(artifacts.map((artifact) => [artifact.sha256, artifact.id]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of branchEntries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = contentText(entry.message.content, "");
    if (!text.trim()) continue;
    const id = byHash.get(createHash("sha256").update(text).digest("hex"));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function backfillUserArtifacts(params: {
  sessionId: string;
  branchEntries: SessionEntry[];
  thresholdChars: number;
  previewChars: number;
  skipSha256?: ReadonlySet<string>;
  minNextId?: number;
}): Promise<void> {
  for (const entry of params.branchEntries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = contentText(entry.message.content, "");
    if (!text.trim() || text.length < params.thresholdChars) continue;
    const sha256 = createHash("sha256").update(text).digest("hex");
    if (params.skipSha256?.has(sha256)) continue;
    await storeUserArtifact({
      sessionId: params.sessionId,
      text,
      timestamp: typeof entry.message.timestamp === "number"
        ? entry.message.timestamp
        : Date.parse(entry.timestamp) || 0,
      thresholdChars: params.thresholdChars,
      previewChars: params.previewChars,
      ...(params.minNextId !== undefined ? { minNextId: params.minNextId } : {}),
    });
  }
}

export async function readUserArtifact(
  sessionId: string,
  id: string,
): Promise<{ record: UserArtifactRecord; text: string } | undefined> {
  const manifest = await loadUserArtifactManifest(sessionId);
  const record = manifest.artifacts.find((artifact) => artifact.id === id);
  if (!record) return undefined;
  return { record, text: await readFile(path.join(artifactDir(sessionId), record.file), "utf8") };
}

export async function searchUserArtifacts(
  sessionId: string,
  query: string,
  limit = 20,
  allowedIds?: ReadonlySet<string>,
): Promise<UserArtifactRecord[]> {
  const manifest = await loadUserArtifactManifest(sessionId);
  const candidates = allowedIds
    ? manifest.artifacts.filter((artifact) => allowedIds.has(artifact.id))
    : manifest.artifacts;
  const needle = query.trim().toLowerCase();
  if (!needle) return candidates.slice(-limit).reverse();
  const results: UserArtifactRecord[] = [];
  for (const record of [...candidates].sort((a, b) => b.timestamp - a.timestamp)) {
    if (record.preview.toLowerCase().includes(needle)) {
      results.push(record);
    } else {
      try {
        const text = await readFile(path.join(artifactDir(sessionId), record.file), "utf8");
        if (text.toLowerCase().includes(needle)) results.push(record);
      } catch {
        // A missing individual artifact should not make the whole catalog unusable.
      }
    }
    if (results.length >= limit) break;
  }
  return results;
}

export async function readCatalogUserArtifact(record: UserArtifactRecord): Promise<{ record: UserArtifactRecord; text: string } | undefined> {
  if (!record.sourceSessionId) return undefined;
  const found = await readUserArtifact(record.sourceSessionId, record.id);
  if (!found) return undefined;
  return {
    record: {
      ...found.record,
      sourceSessionId: record.sourceSessionId,
      ...(record.inherited !== undefined ? { inherited: record.inherited } : {}),
    },
    text: found.text,
  };
}

export async function searchUserArtifactCatalog(
  artifacts: UserArtifactRecord[],
  query: string,
  limit = 20,
  allowedKeys?: ReadonlySet<string>,
): Promise<UserArtifactRecord[]> {
  const candidates = allowedKeys
    ? artifacts.filter((artifact) => allowedKeys.has(userArtifactKey(artifact)))
    : artifacts;
  const needle = query.trim().toLowerCase();
  if (!needle) return candidates.slice(-limit).reverse();
  const results: UserArtifactRecord[] = [];
  for (const record of [...candidates].sort((a, b) => b.timestamp - a.timestamp)) {
    if (record.preview.toLowerCase().includes(needle)) {
      results.push(record);
    } else if (record.sourceSessionId) {
      try {
        const text = await readFile(path.join(artifactDir(record.sourceSessionId), record.file), "utf8");
        if (text.toLowerCase().includes(needle)) results.push(record);
      } catch {
        // A missing inherited artifact should not make the rest of the catalog unusable.
      }
    }
    if (results.length >= limit) break;
  }
  return results;
}

function parseKind(value: unknown): UserArtifactKind | undefined {
  return value === "plan" || value === "spec" || value === "requirements" || value === "correction" || value === "log" || value === "evidence" || value === "other"
    ? value
    : undefined;
}

function parseAuthority(value: unknown): UserArtifactAuthority | undefined {
  return value === "governing" || value === "supporting" ? value : undefined;
}

function parseLocator(value: unknown): UserArtifactLocator | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim()) return undefined;
  return {
    id: value.id.trim(),
    ...(typeof value.sourceSessionId === "string" && value.sourceSessionId.trim()
      ? { sourceSessionId: value.sourceSessionId.trim() }
      : {}),
  };
}

function parseReference(value: unknown): DurableUserReference | undefined {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  if (value.state !== "active" && value.state !== "cooling") return undefined;
  if (typeof value.misses !== "number" || !Number.isInteger(value.misses) || value.misses < 0) return undefined;
  const kind = parseKind(value.kind);
  const authority = parseAuthority(value.authority);
  return {
    id: value.id,
    ...(typeof value.sourceSessionId === "string" && value.sourceSessionId.trim()
      ? { sourceSessionId: value.sourceSessionId.trim() }
      : {}),
    state: value.state,
    misses: value.misses,
    ...(kind ? { kind } : {}),
    ...(authority ? { authority } : {}),
    ...(typeof value.semanticNote === "string" && value.semanticNote.trim()
      ? { semanticNote: value.semanticNote.trim().slice(0, 800) }
      : {}),
  };
}

/** Latest v4/v5 compaction carries lifecycle state; v3 is ignored because its user ledger could contain synthetic messages. */
export function previousUserArtifactState(branchEntries: SessionEntry[]): PreviousUserArtifactState {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i]!;
    if (entry.type !== "compaction" || !isObject(entry.details)) continue;
    if (entry.details.plugin !== "pi-one-round-compaction" || (entry.details.version !== 4 && entry.details.version !== 5)) continue;
    const knownIds = Array.isArray(entry.details.knownUserArtifactIds)
      ? entry.details.knownUserArtifactIds.filter((id): id is string => typeof id === "string")
      : [];
    const knownArtifacts = entry.details.version === 5 && Array.isArray(entry.details.knownUserArtifacts)
      ? entry.details.knownUserArtifacts.flatMap((value) => {
          const parsed = parseLocator(value);
          return parsed ? [parsed] : [];
        })
      : knownIds.map((id) => ({ id }));
    const references = Array.isArray(entry.details.durableUserReferences)
      ? entry.details.durableUserReferences.flatMap((value) => {
          const parsed = parseReference(value);
          return parsed ? [parsed] : [];
        })
      : [];
    const checkpointTimestamp = Date.parse(entry.timestamp);
    return {
      knownIds,
      knownArtifacts,
      references,
      ...(Number.isFinite(checkpointTimestamp) ? { checkpointTimestamp } : {}),
    };
  }
  return { knownIds: [], knownArtifacts: [], references: [] };
}

/** Fill missing v4 provenance from the closest visible artifact source. */
export function resolveLegacyArtifactProvenance(params: {
  artifacts: UserArtifactRecord[];
  references: DurableUserReference[];
  knownArtifacts: UserArtifactLocator[];
  knownIds: string[];
  checkpointTimestamp?: number;
}): { references: DurableUserReference[]; knownArtifacts: UserArtifactLocator[] } {
  const sourceFor = (id: string): string | undefined => {
    const candidates = params.artifacts.filter((artifact) => artifact.id === id);
    const eligible = params.checkpointTimestamp === undefined
      ? candidates
      : candidates.filter((artifact) => artifact.timestamp <= params.checkpointTimestamp!);
    const selected = eligible[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    return selected?.sourceSessionId;
  };
  const references = params.references.map((reference) => {
    if (reference.sourceSessionId) return reference;
    const sourceSessionId = sourceFor(reference.id);
    return { ...reference, ...(sourceSessionId ? { sourceSessionId } : {}) };
  });
  const knownArtifacts = params.knownArtifacts.length > 0
    ? params.knownArtifacts.map((locator) => {
        if (locator.sourceSessionId) return locator;
        const sourceSessionId = sourceFor(locator.id);
        return { ...locator, ...(sourceSessionId ? { sourceSessionId } : {}) };
      })
    : params.knownIds.map((id) => {
        const sourceSessionId = sourceFor(id);
        return { id, ...(sourceSessionId ? { sourceSessionId } : {}) };
      });
  return { references, knownArtifacts };
}

function matchingPrevious(record: UserArtifactRecord, previous: DurableUserReference[]): DurableUserReference | undefined {
  const exact = previous.find((reference) => userArtifactKey(reference) === userArtifactKey(record));
  if (exact) return exact;
  // v4 references have no provenance. They remain unambiguous for the common
  // parent-fork case because child-local IDs are allocated above inherited IDs in v5.
  return previous.find((reference) => reference.id === record.id && !reference.sourceSessionId);
}

function artifactLine(record: UserArtifactRecord, previous?: DurableUserReference): string {
  const prior = previous?.semanticNote ? `; previous LLM note: ${previous.semanticNote}` : "";
  const priorSemantics = previous?.kind || previous?.authority
    ? `; previous classification: kind=${previous.kind ?? "unknown"}, authority=${previous.authority ?? "unknown"}`
    : "";
  const state = previous ? `; previous state: ${previous.state}` : "; newly stored";
  return `- ${record.id} | sourceSessionId=${record.sourceSessionId ?? "unknown"} | chars=${record.chars.toLocaleString()}${state}; preview: ${record.preview}${priorSemantics}${prior}`;
}

export function renderArtifactCandidates(params: {
  artifacts: UserArtifactRecord[];
  previous: DurableUserReference[];
  maxChars: number;
}): string {
  if (params.artifacts.length === 0 || params.maxChars <= 0) return "";
  const header = [
    "Exact oversized HUMAN user messages are stored immutably outside the checkpoint.",
    "Semantically decide which sources still matter to the current task. Because the lane prompt normally constrains headings, when this candidate section is present append one extra heading exactly `## Durable User Sources`.",
    "For every relevant source emit exactly one bullet in this form: `- U#### | sourceSessionId=<id> | kind=<plan|spec|requirements|correction|log|evidence|other> | authority=<governing|supporting> | note=<short semantic description>`.",
    "Use `authority=governing` only when that exact user source still directly controls the current work and should be read with `user_artifact` before planning, delegating, editing, or implementing work governed by it. Use `supporting` for logs, evidence, historical context, or other material that is useful only on demand.",
    "If none matter, write `- None` and do not mention their IDs. Previously active governing plans/specs/requirements/corrections should be kept when uncertain; omission for two consecutive compactions archives a reference from normal context but never deletes the exact source.",
  ].join("\n");
  const lines = [header];
  let used = header.length;
  for (const artifact of params.artifacts) {
    const line = artifactLine(artifact, matchingPrevious(artifact, params.previous));
    if (used + 1 + line.length > params.maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join("\n");
}

function semanticSourceLine(
  text: string,
  artifact: UserArtifactRecord,
  candidates: UserArtifactRecord[],
): string | undefined {
  const lines = text.split(/\r?\n/).map((candidate) => candidate.trim());
  const exact = lines.find((candidate) =>
    candidate.includes(artifact.id)
    && (!artifact.sourceSessionId || candidate.includes(`sourceSessionId=${artifact.sourceSessionId}`)));
  if (exact) return exact;

  // Be tolerant of a minor LLM formatting miss when the human-readable U#### id
  // is unique in this classification batch. Provenance remains mandatory when
  // the same id exists in more than one visible source session.
  if (candidates.filter((candidate) => candidate.id === artifact.id).length !== 1) return undefined;
  return lines.find((candidate) => candidate.includes(artifact.id));
}

function semanticNote(line: string | undefined, id: string): string | undefined {
  if (!line) return undefined;
  const explicit = line.match(/\|\s*note\s*=\s*(.+)$/i)?.[1]?.trim();
  if (explicit) return explicit.slice(0, 800);
  const cleaned = line
    .replace(/^[-*]\s*/, "")
    .replace(new RegExp(`^${id}\\s*[-—:]?\\s*`), "")
    .trim();
  return (cleaned || line).slice(0, 800);
}

function semanticKind(line: string | undefined): UserArtifactKind | undefined {
  return parseKind(line?.match(/\bkind\s*=\s*(plan|spec|requirements|correction|log|evidence|other)\b/i)?.[1]?.toLowerCase());
}

function semanticAuthority(line: string | undefined): UserArtifactAuthority | undefined {
  return parseAuthority(line?.match(/\bauthority\s*=\s*(governing|supporting)\b/i)?.[1]?.toLowerCase());
}

/**
 * The LLM owns semantic relevance/classification. Deterministic code only
 * persists explicit labels and applies two-strike lifecycle hysteresis.
 */
export function reconcileDurableUserReferences(params: {
  candidates: UserArtifactRecord[];
  previous: DurableUserReference[];
  llmText: string;
}): DurableUserReference[] {
  const result: DurableUserReference[] = [];
  for (const artifact of params.candidates) {
    const prior = matchingPrevious(artifact, params.previous);
    const line = semanticSourceLine(params.llmText, artifact, params.candidates);
    if (line) {
      const kind = semanticKind(line) ?? prior?.kind;
      const authority = semanticAuthority(line) ?? prior?.authority;
      const note = semanticNote(line, artifact.id) ?? prior?.semanticNote;
      result.push({
        id: artifact.id,
        ...(artifact.sourceSessionId ? { sourceSessionId: artifact.sourceSessionId } : {}),
        state: "active",
        misses: 0,
        ...(kind ? { kind } : {}),
        ...(authority ? { authority } : {}),
        ...(note ? { semanticNote: note } : {}),
      });
      continue;
    }
    const misses = (prior?.misses ?? 0) + 1;
    if (misses < 2) {
      result.push({
        id: artifact.id,
        ...(artifact.sourceSessionId ?? prior?.sourceSessionId
          ? { sourceSessionId: artifact.sourceSessionId ?? prior!.sourceSessionId! }
          : {}),
        state: "cooling",
        misses,
        ...(prior?.kind ? { kind: prior.kind } : {}),
        ...(prior?.authority ? { authority: prior.authority } : {}),
        ...(prior?.semanticNote ? { semanticNote: prior.semanticNote } : {}),
      });
    }
  }
  return result;
}

function findRecord(reference: DurableUserReference, artifacts: UserArtifactRecord[]): UserArtifactRecord | undefined {
  const exact = artifacts.find((artifact) => userArtifactKey(artifact) === userArtifactKey(reference));
  if (exact) return exact;
  return artifacts.find((artifact) => artifact.id === reference.id);
}

function referenceLine(reference: DurableUserReference, record: UserArtifactRecord): string {
  const classification = [reference.state, reference.kind, reference.authority].filter(Boolean).join(", ");
  const note = reference.semanticNote ? ` — ${reference.semanticNote}` : "";
  return `- ${reference.id} [${classification}] sourceSessionId=${record.sourceSessionId ?? reference.sourceSessionId ?? "unknown"}: ${record.chars.toLocaleString()} chars${note}`;
}

export function renderDurableUserReferences(params: {
  references: DurableUserReference[];
  artifacts: UserArtifactRecord[];
  maxChars: number;
}): string {
  if (params.references.length === 0 || params.maxChars <= 0) return "";
  const governing = params.references.filter((reference) => reference.state === "active" && reference.authority === "governing");
  const recoverable = params.references.filter((reference) => !(reference.state === "active" && reference.authority === "governing"));
  const sections: string[] = [];
  let used = 0;

  const appendSection = (header: string, references: DurableUserReference[]): void => {
    if (references.length === 0 || used >= params.maxChars) return;
    const lines = [header];
    let local = header.length;
    for (const reference of references) {
      const record = findRecord(reference, params.artifacts);
      if (!record) continue;
      const line = referenceLine(reference, record);
      const extra = 1 + line.length;
      if (used + local + extra > params.maxChars) break;
      lines.push(line);
      local += extra;
    }
    if (lines.length === 1) return;
    const section = lines.join("\n");
    if (used + (sections.length ? 2 : 0) + section.length > params.maxChars) return;
    sections.push(section);
    used += (sections.length > 1 ? 2 : 0) + section.length;
  };

  appendSection([
    "### Governing exact user sources — READ BEFORE GOVERNED WORK",
    "These active sources are exact user instructions stored outside this checkpoint. The checkpoint summary is not a substitute for them. Before planning, delegating, editing, or implementing work governed by a source below, read its complete text with `user_artifact` action `read`, the U#### id, and the shown sourceSessionId. If the read is paged, continue until the tool reports the end of the exact source.",
  ].join("\n"), governing);

  appendSection([
    "### Recoverable oversized user sources",
    "These exact human sources remain outside the checkpoint. Read supporting/cooling sources with `user_artifact` when their exact evidence or wording matters; use action `search` to rediscover archived sources.",
  ].join("\n"), recoverable);

  return sections.join("\n\n");
}

export function referencedArtifactIds(text: string): string[] {
  return [...new Set(text.match(USER_ARTIFACT_ID_RE) ?? [])];
}
