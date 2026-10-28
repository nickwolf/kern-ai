# Sessions

By default a kern agent has one session. Every interface feeds it, and the agent remembers a conversation no matter where it continues ([Interfaces](interfaces.md)). That is the right model for a personal agent.

An agent shared by a team works differently. Turns are serialized, so while one person's long task runs, everyone else waits. Per-user mode gives each person their own session while the agent keeps one shared memory.

```json
{ "sessionMode": "per-user" }
```

## Routing

| Message | Session |
|---------|---------|
| Direct message (Slack DM, Telegram private chat, Discord DM, two-member Matrix room, IRC private message, Nostr) | that user's session |
| Group channel or room | core |
| Web UI and TUI | core |
| Heartbeats, system turns | core (plus a light heartbeat per active user session, see below) |

In this mode the message envelope also carries the platform's chat ID, because channel names repeat (two Discord servers can each have a `#general`). It also marks channels the platform confirms anyone in the workspace can see as `public`, which Slack and Discord report: `[via slack, #general (C0123), public, user: U1, time: ...]`. Every other channel counts as private.

Each session has its own message queue, so same-channel injection and the idle timeout behave as before within a session. Different sessions run in parallel, up to `maxConcurrentSessions` model turns at once. A turn waiting for a free slot doesn't count toward the idle timeout, and heartbeats wait behind real messages.

A user's key is `<interface>:<userId>`, for example `slack:U0123`. The same person on Slack and Telegram is two users unless you map their accounts with `userAliases`:

```json
{ "userAliases": { "slack:U0123": "nick", "telegram:4567": "nick" } }
```

Set aliases before people start using the agent. Adding one later moves that person to a new memory folder. Their recall of past conversations carries over, but you have to move their old `users/<old>/` folder into the new one yourself.

A user session is loaded on its first message and unloaded after `userSessionIdleMinutes` without activity. Its JSONL file stays in `.kern/sessions/` (the header records the owner) and is resumed on the next message.

Async completions (background jobs, sub-agents) return to the session that started them.

## Memory

```
AGENTS.md IDENTITY.md KNOWLEDGE.md USERS.md knowledge/ notes/   # global
users/<user>/KNOWLEDGE.md  users/<user>/knowledge/  users/<user>/notes/   # personal
.kern/global-inbox/   .kern/global-inbox/processed/   # proposals
```

`<user>` is the user key made filesystem-safe plus a short hash, e.g. `users/slack_U0123-1a2b3c4d/`.

**Global memory** (`KNOWLEDGE.md`, `knowledge/`, `notes/`, `USERS.md`) is written only by the core session, and every session reads it. The core is told to record only what came from `public` channels or approved proposals, and to keep `USERS.md` to names and roles. The system prompt is rebuilt each turn, so a DM session sees the core's latest edits on its next turn. The core commits global memory with `commit_memory`, which leaves out `users/` and `.kern/`.

**Personal memory** belongs to one user's DM session. That session's system prompt includes `users/<user>/KNOWLEDGE.md` and the latest note in `users/<user>/notes/`. It is saved on disk as soon as it's written, and it is never committed to git: per-user mode adds `users/` to `.gitignore` and stops tracking anything committed there before. Back up the machine (`kern backup`) to keep it.

**Proposals.** When a DM session learns something everyone should know, it quotes the text to the user and asks before sharing. Once the user agrees, it calls `propose_global`, which writes a file to `.kern/global-inbox/`, and tells the user the change is pending.

Heartbeat and review turns see pending proposals, and only those turns can read the inbox. Operator turns get a one-line reminder, and group-channel turns get nothing. Proposals are written and settled only through the tools; no turn can edit inbox files directly. It applies each accepted change with `write`/`edit`, then calls `resolve_proposal`, which archives the proposal in `processed/` and commits global memory. The outcome goes back to the proposer's session as a `[global-inbox]` message, and the agent tells the user in their DM whether it was applied or rejected, and why.

With `globalReviewOnPropose: true`, the core gets a review turn as soon as a proposal arrives instead of at the next heartbeat. If that turn ends with the proposal unsettled, kern logs a warning and asks once more. With heartbeats off and `globalReviewOnPropose` false, nothing reviews proposals until the operator does, and kern warns about that at startup. `/inbox` (operator only) lists pending proposals and their age. Each user can make 10 proposals an hour.

**Heartbeats.** The core gets the usual `[heartbeat]`. Each user session that has been active since its last heartbeat gets `[heartbeat, scope: user]`. It updates the user's personal notes and messages no one.

**Recall.**

- **Operator turns:** every session.
- **Core turns from group channels or automatic turns:** core sessions only, never anyone's DMs.
- **DM sessions:** that user's own sessions, plus core history from channels the user has posted in. Every message in a hit has to come from such a channel.
- **Never visible to a DM session:**
  - other users' DMs
  - channels the user hasn't posted in (silent members included, for now)
  - the operator's web/TUI conversations
  - turns whose channel can't be determined

## Who can reach what

Every session runs in one process as one OS user. Per-user mode therefore enforces privacy at the tool level, and it trusts only the operator. That means the person at the web UI, TUI or CLI, who holds the agent's auth token, plus the DMs of chat accounts listed in `operatorUsers`. Everything else is untrusted: other DM sessions, group-channel turns (even from someone in `operatorUsers`), and automatic turns (heartbeats, inbox reviews).

| Turn | Tool scope | Shell | Files | Platform & MCP tools |
|------|-----------|:-----:|-------|----------------------|
| Operator (web UI, TUI, CLI, `operatorUsers` DMs) | `toolScope` | yes | everything | yes |
| Group channel, heartbeat, review | `groupToolScope` | no | agent dir, except `users/` and `.kern/` (inbox allowed) | only `untrustedTools` |
| DM session | `userToolScope` | no | agent dir, except other users' folders and `.kern/`; writes only its own folder | only `untrustedTools` |

`userToolScope` and `groupToolScope` default to `write` when `toolScope` is `full`, which keeps the shell (`bash` and `jobs`, or `pwsh` on Windows) from everyone but the operator. A value kern doesn't recognize stops it at startup rather than falling back to full access. A shell reaches every file on the box, so setting either one to `full` gives up these protections for those turns.

In untrusted turns:

- **File tools:** `read`, `write`, `edit`, `pdf`, `image` and `audio` refuse protected paths:
  - anything outside the agent directory
  - another user's folder
  - `.kern/`, except that files in `.kern/media/` can be opened by name and review turns can read the inbox
  - `.git/`

  They also refuse writes to the files that steer the agent (`AGENTS.md`, `IDENTITY.md`, `KERN.md`, `skills/`, `.gitignore`, `.gitattributes`). Paths are resolved through symlinks, and case is ignored when the filesystem ignores it.
- **Search:** `glob` and `grep` drop results from protected places. `grep` accepts only options that keep file names in its output, and it skips binary files.
- **Platform and MCP tools:** the Slack, Matrix, Discord, Telegram, IRC, OpenRouter and MCP tools act with the agent's own credentials across every conversation; Slack's history, for example, reaches every DM the bot has. They are off unless you name them in `untrustedTools`. Untrusted turns keep recall, skills, sub-agents, dashboards, the memory tools and `message`.
- **Sub-agents:** they inherit their parent's restrictions, and `subagents` shows a session only its own children.
- **Operator-only actions:** `kern logs` (message previews from every session), `kern users`, `kern pair`, and chat commands other than `/help`, `/status` and `/wyd`. `/help` lists only what the person can run, and refusals name `operatorContact` when it's set.

### What is not private

Per-user mode keeps coworkers from reading each other's DMs and personal memory through the agent. It is not a vault:

- **The operator** can read everything: every session from the web UI or TUI (`/history?session=<key>`), and every file through the shell.
- **The model provider** receives every conversation, as always.
- **Global memory** (`knowledge/`, `notes/`, `USERS.md`) is shown to every DM session. The core is told to record only content from channels marked `public` and approved proposals, but only the model's instructions enforce that. Recall's channel rules don't apply to these files.
- **The `message` tool** can post to any chat. A DM session is told not to forward the conversation unless the user asks.
- **Settings that loosen this:** `userToolScope`/`groupToolScope` set to `full`, or tools added to `untrustedTools`.
- **Switching back to shared mode** removes every restriction: all sessions, including past DMs, become one memory again.
- **History from before per-user mode** stays in the core session (see below).

## Turning it on for an existing agent

1. **Who is the operator.** The account auto-paired first on Slack or Telegram becomes an ordinary user. Add it to `operatorUsers` to keep operator powers in its DMs, and set `operatorContact` so refusals tell coworkers who to ask.
2. **Old DMs.** The core session resumes your existing session, which holds everyone's DMs from before. Group-channel turns can see it and recall it. To start clean, stop the agent and move the latest `.kern/sessions/<id>.jsonl` (and its `.media.jsonl`) out of the directory; recall still indexes it as core history. On startup, kern logs a warning while the core is on a pre-per-user session.
3. **Shared files.** Every DM session now reads `notes/`, `knowledge/` and `USERS.md`. Remove anything there that shouldn't reach every coworker, including notes in `USERS.md` about what someone may see.
4. **Shell workflows.** Heartbeats and group-channel requests lose `bash`. If your heartbeat checklist or team workflows depend on it, decide whether `groupToolScope: "full"` is worth what it gives up, or move that work to operator turns.
5. **Platform and MCP tools.** List the ones untrusted turns should keep in `untrustedTools`, e.g. `["jira__search"]`.
6. **Personal memory in git.** Earlier commits may contain `users/`; untracking it doesn't rewrite history.
7. **Git identity.** Group-channel and automatic turns commit through `commit_memory` rather than a shell, so the agent directory needs a git `user.name` and `user.email` (for example `git config` in the agent repo). Without them, commits fail and the tool says so.
8. **Web UI.** It shows the core session. DM sessions stream only to clients that connect with `/events?session=<key>`.

## Web UI and API

SSE events carry a `sessionKey`. A client sees core events unless it connects with `/events?session=<key>`. `/history` and `/context/system` take `?session=<key>` for loaded sessions. `/status` shows how many sessions are loaded and how many are running; its context and token figures are the core session's.

## Config

| Field | Default | |
|-------|---------|--|
| `sessionMode` | `"shared"` | `"per-user"` turns this on |
| `maxConcurrentSessions` | `4` | model turns running at once |
| `userSessionIdleMinutes` | `60` | unload idle user sessions, `0` = never |
| `userAliases` | `{}` | merge one person's accounts |
| `userToolScope` | `""` | tool scope for DM sessions; empty = `write` when `toolScope` is `full` |
| `groupToolScope` | `""` | tool scope for group-channel and automatic core turns; same default |
| `untrustedTools` | `[]` | platform/MCP tools untrusted turns may use |
| `operatorUsers` | `[]` | chat accounts (user keys) whose DMs get operator trust |
| `operatorContact` | `""` | how coworkers reach the operator, used in refusals |
| `globalReviewOnPropose` | `false` | wake the core when a proposal arrives |

## Limits

- Matrix rooms count as direct only once the agent has seen their member count in a sync.
- Personal notes have no rolling summary yet; only the latest personal note is injected.
- Channel membership for recall is inferred from who has posted where, not from the platform's member list.
