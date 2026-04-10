/**
 * Apple Calendar integration via JXA (JavaScript for Automation).
 * Executes osascript commands to interact with macOS Calendar.app.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

interface CalendarEvent {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  calendar: string;
  location?: string;
  notes?: string;
  isAllDay: boolean;
}

function runJxa(script: string): string {
  try {
    return execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();
  } catch (err: any) {
    logger.error({ err: err.message }, 'JXA execution failed');
    throw new Error(`Calendar error: ${err.stderr || err.message}`);
  }
}

export function listCalendars(): string[] {
  const script = `
    const app = Application("Calendar");
    const cals = app.calendars();
    JSON.stringify(cals.map(c => c.name()));
  `;
  return JSON.parse(runJxa(script));
}

export function getEvents(startDate: string, endDate: string, calendarName?: string): CalendarEvent[] {
  const calFilter = calendarName
    ? `const cals = [app.calendars.byName("${calendarName.replace(/"/g, '\\"')}")];`
    : `const cals = app.calendars();`;

  const script = `
    const app = Application("Calendar");
    ${calFilter}
    const start = new Date("${startDate}");
    const end = new Date("${endDate}");
    const results = [];
    for (const cal of cals) {
      try {
        const events = cal.events.whose({
          _and: [
            { startDate: { _greaterThan: start } },
            { startDate: { _lessThan: end } }
          ]
        })();
        for (const e of events) {
          results.push({
            id: e.uid(),
            title: e.summary(),
            startDate: e.startDate().toISOString(),
            endDate: e.endDate().toISOString(),
            calendar: cal.name(),
            location: e.location() || undefined,
            notes: e.description() || undefined,
            isAllDay: e.alldayEvent()
          });
        }
      } catch(err) {}
    }
    results.sort((a,b) => new Date(a.startDate) - new Date(b.startDate));
    JSON.stringify(results);
  `;
  return JSON.parse(runJxa(script));
}

export function createEvent(params: {
  title: string;
  startDate: string;
  endDate: string;
  calendar?: string;
  location?: string;
  notes?: string;
  isAllDay?: boolean;
}): CalendarEvent {
  const calRef = params.calendar
    ? `app.calendars.byName("${params.calendar.replace(/"/g, '\\"')}")`
    : `app.defaultCalendar()`;

  const script = `
    const app = Application("Calendar");
    const cal = ${calRef};
    const e = app.Event({
      summary: "${params.title.replace(/"/g, '\\"')}",
      startDate: new Date("${params.startDate}"),
      endDate: new Date("${params.endDate}"),
      ${params.location ? `location: "${params.location.replace(/"/g, '\\"')}",` : ''}
      ${params.notes ? `description: "${params.notes.replace(/"/g, '\\"')}",` : ''}
      ${params.isAllDay ? 'alldayEvent: true,' : ''}
    });
    cal.events.push(e);
    JSON.stringify({
      id: e.uid(),
      title: e.summary(),
      startDate: e.startDate().toISOString(),
      endDate: e.endDate().toISOString(),
      calendar: cal.name(),
      location: e.location() || undefined,
      notes: e.description() || undefined,
      isAllDay: e.alldayEvent()
    });
  `;
  return JSON.parse(runJxa(script));
}

export function deleteEvent(eventId: string, calendarName?: string): boolean {
  const calFilter = calendarName
    ? `const cals = [app.calendars.byName("${calendarName.replace(/"/g, '\\"')}")];`
    : `const cals = app.calendars();`;

  const script = `
    const app = Application("Calendar");
    ${calFilter}
    let deleted = false;
    for (const cal of cals) {
      try {
        const events = cal.events.whose({ uid: "${eventId}" })();
        for (const e of events) {
          app.delete(e);
          deleted = true;
        }
      } catch(err) {}
    }
    JSON.stringify(deleted);
  `;
  return JSON.parse(runJxa(script));
}

export function updateEvent(eventId: string, updates: {
  title?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  notes?: string;
}, calendarName?: string): CalendarEvent | null {
  const calFilter = calendarName
    ? `const cals = [app.calendars.byName("${calendarName.replace(/"/g, '\\"')}")];`
    : `const cals = app.calendars();`;

  const setters: string[] = [];
  if (updates.title) setters.push(`e.summary = "${updates.title.replace(/"/g, '\\"')}";`);
  if (updates.startDate) setters.push(`e.startDate = new Date("${updates.startDate}");`);
  if (updates.endDate) setters.push(`e.endDate = new Date("${updates.endDate}");`);
  if (updates.location) setters.push(`e.location = "${updates.location.replace(/"/g, '\\"')}";`);
  if (updates.notes) setters.push(`e.description = "${updates.notes.replace(/"/g, '\\"')}";`);

  const script = `
    const app = Application("Calendar");
    ${calFilter}
    let result = null;
    for (const cal of cals) {
      try {
        const events = cal.events.whose({ uid: "${eventId}" })();
        for (const e of events) {
          ${setters.join('\n          ')}
          result = {
            id: e.uid(),
            title: e.summary(),
            startDate: e.startDate().toISOString(),
            endDate: e.endDate().toISOString(),
            calendar: cal.name(),
            location: e.location() || undefined,
            notes: e.description() || undefined,
            isAllDay: e.alldayEvent()
          };
        }
      } catch(err) {}
    }
    JSON.stringify(result);
  `;
  return JSON.parse(runJxa(script));
}

export interface CalendarRequest {
  action: string;
  requestId: string;
  params: Record<string, any>;
}

export function handleCalendarRequest(req: CalendarRequest): { success: boolean; data?: any; error?: string } {
  try {
    switch (req.action) {
      case 'list_calendars':
        return { success: true, data: listCalendars() };
      case 'get_events':
        return { success: true, data: getEvents(req.params.startDate, req.params.endDate, req.params.calendar) };
      case 'create_event':
        return { success: true, data: createEvent(req.params as any) };
      case 'delete_event':
        return { success: true, data: deleteEvent(req.params.eventId, req.params.calendar) };
      case 'update_event':
        return { success: true, data: updateEvent(req.params.eventId, req.params.updates, req.params.calendar) };
      default:
        return { success: false, error: `Unknown calendar action: ${req.action}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
