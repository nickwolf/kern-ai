import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { globalInboxDir, userDirName } from "../../user-memory.js";

export interface Proposal {
  from: string;
  sessionId: string | null;
  target: string;
  change: string;
  rationale: string;
}

export interface PendingProposal {
  file: string;
  from: string;
  target: string;
}

/** Write a proposal into .kern/global-inbox/. Returns the file name. */
export async function writeProposal(agentDir: string, p: Proposal, now = new Date()): Promise<string> {
  const dir = globalInboxDir(agentDir);
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = `${stamp}-${userDirName(p.from)}.md`;
  const body = [
    "---",
    `from: ${p.from}`,
    `session: ${p.sessionId ?? "unknown"}`,
    `target: ${p.target}`,
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
    const field = (name: string) => text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "?";
    pending.push({ file, from: field("from"), target: field("target") });
  }
  return pending;
}
