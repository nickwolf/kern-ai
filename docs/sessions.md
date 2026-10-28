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

**Personal memory** belongs to one user's session. That session's system prompt includes `users/<user>/KNOWLEDGE.md` and the latest note in `users/<user>/notes/`. The `write` and `edit` tools refuse any path inside the agent directory outside the user's own folder. `bash` is not guarded, so set `userToolScope: "write"` if user sessions must not touch global files at all.

**Proposals.** When a user session learns something everyone should know, it calls `propose_global`, which writes a file to `.kern/global-inbox/`. The core session sees pending proposals in its context on every turn, including heartbeats. It applies or rejects each one, commits, and moves it to `processed/`. With `globalReviewOnPropose: true` the core gets a review turn as soon as a proposal arrives instead of at the next heartbeat. `/inbox` lists pending proposals.

**Heartbeats.** The core gets the usual `[heartbeat]`. Each user session active since its last heartbeat gets `[heartbeat, scope: user]` and updates its personal notes.

**Recall.** A user session searches and loads only its own sessions and the core session. The core session can read every session.

## Web UI and API

SSE events carry a `sessionKey`. A client sees core events unless it connects with `/events?session=<key>`. `/history` and `/context/system` take `?session=<key>` for loaded sessions. `/status` shows how many sessions are loaded and how many are running.

## Config

| Field | Default | |
|-------|---------|--|
| `sessionMode` | `"shared"` | `"per-user"` turns this on |
| `maxConcurrentSessions` | `4` | model turns running at once |
| `userSessionIdleMinutes` | `60` | unload idle user sessions, `0` = never |
| `userAliases` | `{}` | merge one person's accounts |
| `userToolScope` | `""` | tool scope for user sessions |
| `globalReviewOnPropose` | `false` | wake the core when a proposal arrives |

## Limits

- Turns waiting for a concurrency slot count toward the 5-minute idle timeout.
- Matrix rooms count as direct only once the agent has seen their member count in a sync.
- Personal notes have no rolling summary yet; only the latest personal note is injected.
