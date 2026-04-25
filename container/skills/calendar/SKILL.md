---
name: calendar
description: Read and write Apple Calendar events. Available in main group only. Use MCP tools calendar_list, calendar_events, calendar_create, calendar_update, calendar_delete.
---

# Apple Calendar

You have access to the user's Apple Calendar via MCP tools. Main group only.

## Available Tools

- `calendar_list` — List all calendars
- `calendar_events` — Get events in a date range
- `calendar_create` — Create a new event
- `calendar_update` — Update an existing event
- `calendar_delete` — Delete an event

## Usage Notes

- All dates are ISO format in the user's local timezone (no Z suffix)
- When the user asks "what's on my calendar today", use today's date range
- When creating events, always confirm the details before creating
- Use `calendar_list` first if you need to know which calendars exist
