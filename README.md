# Roster Manager Plugin - Taverne Posting Permissions

This document describes the taverne (messageboard) posting permissions feature.

## Feature Overview

The Taverne messageboard now supports configurable posting permissions. By default, anyone can post to the taverne, but you can configure a specific server group to have posting privileges.

## Configuration

### New Config Option

- **TAVERNE_POSTING_GROUP**: Server Group ID (who can post to taverne)
  - Default: '' (empty string)
  - Behavior: When empty, anyone can post to the taverne. When set to a group ID, only members of that group can post.

### Example Configuration

```json
{
  "BOT_NAME": "member",
  "TAVERNE_NAME": "taverne",
  "LEADERSHIP_GROUP": "17",
  "TAVERNE_POSTING_GROUP": "25",  // Only Matroos group can post
  "MEMBERSHIP_GROUPS": "23",
  "MESSAGEBOARD_ENABLED": "enabled",
  "MESSAGEBOARD_CHANNEL_ID": "832",
  "MAX_SHOWN_MESSAGES": 50,
  "MESSAGEBOARD_TITLE": "Guild Messages"
}
```

## Usage

### Without Posting Group (Default)
- Anyone with the bot command access can post messages
- Example: `!taverne Looking for raid group tonight`

### With Posting Group
- Only members of the configured posting group can post
- Example: `!taverne Only Matroos can post to this board`

### Command Reference

- **`!taverne <message>`**: Post a message to the taverne (requires posting permissions if configured)
- **`!taverne clear`**: Clear all taverne messages (leadership only)
- **`!taverne help`**: Show this help message

## Permission Behavior

1. **When TAVERNE_POSTING_GROUP is empty**: Anyone who can use the bot can post
2. **When TAVERNE_POSTING_GROUP is set**: Only members of that server group can post
3. **Leadership can still clear**: The `!taverne clear` command still requires leadership permissions regardless of posting group settings

## Testing

Run the test suite with:
```bash
node test_harness.js
```

All existing tests pass, and new permission tests validate the feature.

## Files Modified

- `A_rostermanager.js`: Added posting permissions check
- `test_harness.js`: Added TAVERNE_POSTING_GROUP to test configurations

## Notes

- The posting permission is separate from leadership permissions
- Leadership can always clear the taverne, but cannot post if posting group is configured for others
- The feature is backward compatible - existing installations with no posting group configured will see no behavior change