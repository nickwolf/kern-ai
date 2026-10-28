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

Each session has its own message queue, so same-channel injection and the idle timeout behave as before within a session. Different sessions run in parallel, up to `maxConcurrentSessions` model turns at once.

A user's key is `<interface>:<userId>`, for example `slack:U0123`. To give one person a single session across platforms, map their accounts with `userAliases`:

```json
{ "userAliases": { "slack:U0123": "nick", "telegram:4567": "nick" } }
```

A user session is loaded on its first message and unloaded after `userSessionIdleMinutes` without activity. Its JSONL file stays in `.kern/sessions/` (the header records the owner) and is resumed on the next message.

Async completions (background jobs, sub-agents) return to the session that started them.

## Memory

```
AGENTS.md IDENTITY.md KNOWLEDGE.md USERS.md knowledge/ notes/   # global
users/<user>/KNOWLEDGE.md  users/<user>/knowledge/  users/<user>/notes/   # personal
.kern/global-inbox/   .kern/global-inbox/processed/   # proposals
```

`<user>` is the user key with characters other than letters, digits, `.`, `_` and `-` replaced by `_`, e.g. `users/slack_U0123/`.

**Global memory** is written only by the core session. Every session reads it, and since the system prompt is rebuilt each turn, a user session sees the core's latest edits on its next turn.

**Personal memory** belongs to one user's session, and only that session can see it. Its system prompt includes `users/<user>/KNOWLEDGE.md` and the latest note in `users/<user>/notes/`. User sessions save it with `commit_memory`, which commits (and pushes, if the agent repo has an `origin`) only that user's folder.

**Proposals.** When a user session learns something everyone should know, it calls `propose_global`, which writes a file to `.kern/global-inbox/`. The core session sees pending proposals in its heartbeat, review and operator turns, but not in group-channel turns. It applies each accepted change with `write`/`edit`, then settles the proposal with `resolve_proposal`. That tool archives the proposal into `processed/` with the decision and commits global memory, leaving out `users/`. With `globalReviewOnPropose: true` the core gets a review turn as soon as a proposal arrives instead of at the next heartbeat. `/inbox` lists pending proposals.

**Heartbeats.** The core gets the usual `[heartbeat]`. Each user session active since its last heartbeat gets `[heartbeat, scope: user]` and updates its personal notes.

**Recall.**

- **Core session:** searches only core sessions, never a user's private sessions.
- **User session:** searches its own sessions, plus core-session history from channels that user has posted in. Every message in a hit has to come from such a channel.
- **Never visible to a user session:**
  - other users' DMs
  - channels the user hasn't posted in (silent members included, for now)
  - the operator's web/TUI conversations
  - turns whose channel can't be determined

## Who can reach what

Every session runs in one process as one OS user, so per-user mode enforces privacy at the tool level:

| Turn | Tool scope | Shell | Personal memory | `.kern/` |
|------|-----------|:-----:|-----------------|----------|
| Operator (web UI, TUI, CLI) on core | `toolScope` | yes | none through file tools | `global-inbox/` only |
| Group channel or room on core | `groupToolScope` | no | none | `global-inbox/` only |
| Heartbeat, inbox review | `groupToolScope` | no | none | `global-inbox/` only |
| User session (DMs) | `userToolScope` | no | own folder only | none |

`userToolScope` and `groupToolScope` default to `write` when `toolScope` is `full`, which keeps `bash` and `jobs` from everyone but the operator. A shell reaches every file the agent can, so setting either to `full` gives up these guarantees for those turns. With no shell, the core and user sessions commit through `commit_memory`, and the core settles proposals through `resolve_proposal`.

On top of the tool scope:

- `read`, `write`, `edit`, `pdf`, `image` and `audio` refuse protected paths. These are other users' folders (every user's folder for the core session) and `.kern/`, which holds every session's transcripts, the recall index, logs and sub-agent results.
- `glob` and `grep` drop results under protected paths.
- A user session can't write anywhere else inside the agent directory, because global memory is the core's.
- Sub-agents get the same restrictions as the session that spawned them, and `subagents` shows a session only its own children.
- `kern logs` (which carries message previews from every session) and `kern pair` work only in operator turns.

Operator turns keep the shell, so the operator can still read anything on the box, the same as anyone with shell access to it.

## Web UI and API

SSE events carry a `sessionKey`. A client sees core events unless it connects with `/events?session=<key>`. `/history` and `/context/system` take `?session=<key>` for loaded sessions. `/status` shows how many sessions are loaded and how many are running.

## Config

| Field | Default | |
|-------|---------|--|
| `sessionMode` | `"shared"` | `"per-user"` turns this on |
| `maxConcurrentSessions` | `4` | model turns running at once |
| `userSessionIdleMinutes` | `60` | unload idle user sessions, `0` = never |
| `userAliases` | `{}` | merge one person's accounts |
| `userToolScope` | `""` | tool scope for user sessions; empty = `write` when `toolScope` is `full` |
| `groupToolScope` | `""` | tool scope for group-channel and automatic core turns; same default |
| `globalReviewOnPropose` | `false` | wake the core when a proposal arrives |

## Limits

- Turns waiting for a concurrency slot count toward the 5-minute idle timeout.
- Matrix rooms count as direct only once the agent has seen their member count in a sync.
- Personal notes have no rolling summary yet; only the latest personal note is injected.
- Channel membership for recall is inferred from who has posted where, not from the platform's member list.
- Global notes and knowledge are visible to everyone. The core is told never to copy one person's private details into them.
