import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentText } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const USER_ARTIFACT_ID_RE = /\bU\d{4,}\b/g;

export interface UserArtifactRecord {
  id: string;
  sha256: string;
  timestamp: number;
  chars: number;
  preview: string;
  file: string;
}

interface UserArtifactManifestV1 {
  version: 1;
  nextId: number;
  artifacts: UserArtifactRecord[];
}

export interface DurableUserReference {
  id: string;
  state: "active" | "cooling";
  misses: number;
  semanticNote?: string;
}

export interface PreviousUserArtifactState {
  knownIds: string[];
  references: DurableUserReference[];
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
}): Promise<UserArtifactRecord | undefined> {
  if (params.text.length < params.thresholdChars) return undefined;
  const sha256 = createHash("sha256").update(params.text).digest("hex");
  const manifest = await loadUserArtifactManifest(params.sessionId);
  const existing = manifest.artifacts.find((artifact) => artifact.sha256 === sha256);
  if (existing) return existing;

  const id = `U${String(manifest.nextId).padStart(4, "0")}`;
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
  manifest.nextId++;
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
}): Promise<void> {
  for (const entry of params.branchEntries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = contentText(entry.message.content, "");
    if (!text.trim() || text.length < params.thresholdChars) continue;
    await storeUserArtifact({
      sessionId: params.sessionId,
      text,
      timestamp: typeof entry.message.timestamp === "number"
        ? entry.message.timestamp
        : Date.parse(entry.timestamp) || 0,
      thresholdChars: params.thresholdChars,
      previewChars: params.previewChars,
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
  for (const record of [...candidates].reverse()) {
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

function parseReference(value: unknown): DurableUserReference | undefined {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  if (value.state !== "active" && value.state !== "cooling") return undefined;
  if (typeof value.misses !== "number" || !Number.isInteger(value.misses) || value.misses < 0) return undefined;
  return {
    id: value.id,
    state: value.state,
    misses: value.misses,
    ...(typeof value.semanticNote === "string" && value.semanticNote.trim()
      ? { semanticNote: value.semanticNote.trim().slice(0, 800) }
      : {}),
  };
}

/** Latest v4 compaction carries the lifecycle state; v3 is ignored because its user ledger could contain synthetic messages. */
export function previousUserArtifactState(branchEntries: SessionEntry[]): PreviousUserArtifactState {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i]!;
    if (entry.type !== "compaction" || !isObject(entry.details)) continue;
    if (entry.details.plugin !== "pi-one-round-compaction" || entry.details.version !== 4) continue;
    const knownIds = Array.isArray(entry.details.knownUserArtifactIds)
      ? entry.details.knownUserArtifactIds.filter((id): id is string => typeof id === "string")
      : [];
    const references = Array.isArray(entry.details.durableUserReferences)
      ? entry.details.durableUserReferences.flatMap((value) => {
          const parsed = parseReference(value);
          return parsed ? [parsed] : [];
        })
      : [];
    return { knownIds, references };
  }
  return { knownIds: [], references: [] };
}

function artifactLine(record: UserArtifactRecord, previous?: DurableUserReference): string {
  const prior = previous?.semanticNote ? `; previous LLM note: ${previous.semanticNote}` : "";
  const state = previous ? `; previous state: ${previous.state}` : "; newly stored";
  return `- ${record.id}: ${record.chars.toLocaleString()} chars${state}; preview: ${record.preview}${prior}`;
}

export function renderArtifactCandidates(params: {
  artifacts: UserArtifactRecord[];
  previous: DurableUserReference[];
  maxChars: number;
}): string {
  if (params.artifacts.length === 0 || params.maxChars <= 0) return "";
  const previous = new Map(params.previous.map((reference) => [reference.id, reference]));
  const header = [
    "Exact oversized HUMAN user messages are stored immutably outside the checkpoint.",
    "Semantically decide which sources still matter to the current task. Because the lane prompt normally constrains headings, when this candidate section is present append one extra heading exactly `## Durable User Sources`. Under it, list every relevant U#### ID, identify what it is (plan/spec/requirements/log/etc.), and state that exact wording can be retrieved with `user_artifact`. If none matter, write `- None` and do not mention their IDs. Previously active plans/specs should be kept when uncertain; omission for two consecutive compactions archives a reference from normal context but never deletes the exact source.",
  ].join("\n");
  const lines = [header];
  let used = header.length;
  for (const artifact of params.artifacts) {
    const line = artifactLine(artifact, previous.get(artifact.id));
    if (used + 1 + line.length > params.maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join("\n");
}

function semanticLine(text: string, id: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes(id));
  if (!line) return undefined;
  const cleaned = line
    .replace(/^[-*]\s*/, "")
    .replace(new RegExp(`^${id}\\s*[-—:]?\\s*`), "")
    .trim();
  return (cleaned || line).slice(0, 800);
}

/**
 * LLM semantics are expressed by mentioning an artifact ID. Deterministic code
 * only applies two-strike lifecycle hysteresis; it never decides what is a plan.
 */
export function reconcileDurableUserReferences(params: {
  candidates: UserArtifactRecord[];
  previous: DurableUserReference[];
  llmText: string;
}): DurableUserReference[] {
  const mentioned = new Set(params.llmText.match(USER_ARTIFACT_ID_RE) ?? []);
  const previous = new Map(params.previous.map((reference) => [reference.id, reference]));
  const result: DurableUserReference[] = [];
  for (const artifact of params.candidates) {
    const prior = previous.get(artifact.id);
    if (mentioned.has(artifact.id)) {
      const semanticNote = semanticLine(params.llmText, artifact.id) ?? prior?.semanticNote;
      result.push({
        id: artifact.id,
        state: "active",
        misses: 0,
        ...(semanticNote ? { semanticNote } : {}),
      });
      continue;
    }
    const misses = (prior?.misses ?? 0) + 1;
    if (misses < 2) {
      result.push({
        id: artifact.id,
        state: "cooling",
        misses,
        ...(prior?.semanticNote ? { semanticNote: prior.semanticNote } : {}),
      });
    }
  }
  return result;
}

export function renderDurableUserReferences(params: {
  references: DurableUserReference[];
  artifacts: UserArtifactRecord[];
  maxChars: number;
}): string {
  if (params.references.length === 0 || params.maxChars <= 0) return "";
  const records = new Map(params.artifacts.map((artifact) => [artifact.id, artifact]));
  const header = [
    "### Recoverable oversized user sources",
    "Exact source text is stored outside the checkpoint. Use `user_artifact` with action `read` and the U#### id when exact requirements or wording matter; use action `search` to rediscover archived sources.",
  ].join("\n");
  const lines = [header];
  let used = header.length;
  const ordered = [...params.references].sort((a, b) => {
    if (a.state !== b.state) return a.state === "active" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  for (const reference of ordered) {
    const record = records.get(reference.id);
    if (!record) continue;
    const note = reference.semanticNote ? ` — ${reference.semanticNote}` : "";
    const line = `- ${reference.id} [${reference.state}]: ${record.chars.toLocaleString()} chars${note}`;
    if (used + 1 + line.length > params.maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join("\n");
}

export function referencedArtifactIds(text: string): string[] {
  return [...new Set(text.match(USER_ARTIFACT_ID_RE) ?? [])];
}
