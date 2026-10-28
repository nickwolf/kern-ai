import { mkdir, readdir, readFile, writeFile, rename, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { randomBytes } from "crypto";
import { globalInboxDir, userDirName } from "../../user-memory.js";
import type { TurnOrigin } from "../types.js";

export interface Proposal {
  from: string;
  sessionId: string | null;
  target: string;
  change: string;
  rationale: string;
  /** The proposing turn, so the outcome can be announced back to it. */
  origin?: TurnOrigin | null;
}

export interface ResolvedProposal {
  from: string;
  target: string;
  proposed: string;
  origin: TurnOrigin | null;
}

export interface PendingProposal {
  file: string;
  from: string;
  target: string;
  /** ISO time it was proposed. */
  proposed: string;
}

/**
 * Header values are shown in the core's system prompt, so they stay one short
 * line: a user can't smuggle extra lines or instructions in through them.
 */
function oneLine(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 120);
}

/** Where each proposal's origin (for the outcome notice) is kept, next to the proposals. */
const ORIGINS = ".origins";

/** Write a proposal into .kern/global-inbox/. Returns the file name. */
export async function writeProposal(agentDir: string, p: Proposal, now = new Date()): Promise<string> {
  const dir = globalInboxDir(agentDir);
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // Random suffix: two proposals in the same millisecond must not collide.
  const file = `${stamp}-${userDirName(p.from)}-${randomBytes(3).toString("hex")}.md`;
  const body = [
    "---",
    `from: ${oneLine(p.from)}`,
    `session: ${oneLine(p.sessionId ?? "unknown")}`,
    `target: ${oneLine(p.target)}`,
    `proposed: ${now.toISOString()}`,
    "---",
    "",
    "## Change",
    "",
    p.change.trim(),
    "",
    "## Rationale",
    "",
    p.rationale.trim(),
    "",
  ].join("\n");
  await writeFile(join(dir, file), body, "utf-8");
  // Routing data for the outcome notice stays out of the proposal the model reads.
  if (p.origin) {
    await mkdir(join(dir, ORIGINS), { recursive: true });
    await writeFile(join(dir, ORIGINS, `${file}.json`), JSON.stringify(p.origin), "utf-8");
  }
  return file;
}

/** Proposals waiting for the core session, oldest first. */
export async function listPending(agentDir: string): Promise<PendingProposal[]> {
  const dir = globalInboxDir(agentDir);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const pending: PendingProposal[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf-8").catch(() => "");
    const field = (name: string) => oneLine(text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "?");
    pending.push({ file, from: field("from"), target: field("target"), proposed: field("proposed") });
  }
  return pending;
}

/**
 * Archive a reviewed proposal into processed/ with the decision appended.
 * Returns who proposed it, or null when `file` is not a pending proposal.
 */
export async function resolveProposal(agentDir: string, file: string, decision: string, note: string, now = new Date()): Promise<ResolvedProposal | null> {
  // The inbox listing shows .kern/global-inbox/<file>; accept that form too.
  file = file.replace(/^(\.\/)?\.kern\/global-inbox\//, "");
  if (file !== basename(file) || !file.endsWith(".md")) return null;
  const dir = globalInboxDir(agentDir);
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf-8");
  const field = (name: string) => text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
  const originPath = join(dir, ORIGINS, `${file}.json`);
  const from = field("from") ?? "unknown";
  let origin: TurnOrigin | null = null;
  if (existsSync(originPath)) {
    try {
      const parsed = JSON.parse(await readFile(originPath, "utf-8"));
      // Route the outcome only back to the session that proposed it.
      if (parsed?.sessionKey === from) origin = parsed;
    } catch {
      // unreadable sidecar: settle the proposal without a notice
    }
    await rm(originPath, { force: true });
  }
  await mkdir(join(dir, "processed"), { recursive: true });
  await writeFile(path, `${text.trimEnd()}\n\n## Decision\n\n${decision} (${now.toISOString()}): ${note.trim()}\n`, "utf-8");
  await rename(path, join(dir, "processed", file));
  return { from, target: oneLine(field("target") ?? "?"), proposed: field("proposed") ?? "", origin };
}
