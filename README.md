# Roster Manager Plugin — Taverne posting permissions

Taverne (messageboard) posting is restricted to members of one configurable TS3
server group. The default is **23 (GoudGraaier)**, the guild membership group, so
every registered member may post and a player without membership cannot.

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `TAVERNE_POSTING_GROUP` | `23` | Server group whose members may post to the taverne |
| `LEADERSHIP_GROUP` | `17` | Unchanged; still gates `!taverne clear` |

- Any value, including a blank field, falls back to `23`. There is no "post to
  nobody" setting, and no way to leave the board open to everyone while the field
  reads blank.
- To restrict posting further, name the group explicitly (e.g. `25` limits it to
  Matroos).
- `!taverne clear` is unaffected — it still requires leadership regardless of who
  may post.

## Behaviour

- `!taverne <message>` — posts to the channel description, newest at top.
- Posting from outside the posting group is refused with
  `[RosterManager] Permission denied — you need to be in the taverne posting group to post messages.`
  and the board is left untouched.
- Bare `!taverne` and `!taverne help` are never gated; a non-member still sees the
  help text.

## Example

```json
{
  "BOT_NAME": "member",
  "TAVERNE_NAME": "taverne",
  "LEADERSHIP_GROUP": "17",
  "TAVERNE_POSTING_GROUP": "23",
  "MEMBERSHIP_GROUPS": "23",
  "MESSAGEBOARD_ENABLED": "enabled",
  "MESSAGEBOARD_CHANNEL_ID": "832",
  "MAX_SHOWN_MESSAGES": 50,
  "MESSAGEBOARD_TITLE": "Guild Messages"
}
```

## Testing

```bash
node test_harness.js
```

117 assertions. The posting-permission block covers a plain GoudGraaier member, a
member who also holds a rank group, and a rank-holder with no membership group who
must be refused; it also asserts the refused message never reaches the board.

That block was verified to discriminate: with the default reverted to a blank
posting group, `non-member (no GoudGraaier) denied posting` and
`denied post did not reach the board` both fail (115 passed, 2 failed).

## Upgrade note

An instance that previously saved `TAVERNE_POSTING_GROUP: ""` (the old default,
which meant "everyone may post") picks up `23` on the next load. If such an
instance genuinely needs an open board, that cannot be expressed with this field
— a separate open/closed switch would have to be added.
