/* Shared calendar recurrence projection; no persistence or edit controls. */
(function(root){
  const DAY_MS=86400000;
  function scheduleOccurrences(item, range) {
    const result = [];
    const baseStart = new Date(item.start);
    const baseEnd = new Date(item.deadline);
    const recurrence = item.recurrence || { frequency: 'none', interval: 1, count: 0 };
    const selectedWeekdays = Array.isArray(recurrence.weekdays) ? recurrence.weekdays : [];
    const weeklyRule = recurrence.frequency === 'weekly' || (recurrence.frequency === 'custom' && recurrence.unit === 'weeks');
    const stepDays = weeklyRule && !selectedWeekdays.length ? 7 * recurrence.interval : recurrence.frequency === 'daily' ? recurrence.interval : recurrence.frequency === 'custom' && recurrence.unit === 'days' ? recurrence.interval : 0;
    let index = 0;
    let start = new Date(baseStart);
    const duration = baseEnd.getTime() - baseStart.getTime();
    const distanceDays = Math.max(0, Math.ceil((range.end.getTime() - baseStart.getTime()) / DAY_MS));
    const maxOccurrences = Math.min(10000, Math.max(32, Math.ceil(distanceDays / Math.max(1, stepDays || (recurrence.frequency === 'monthly' ? 28 * recurrence.interval : 1))) + 16));
    const baseWeek = new Date(baseStart); baseWeek.setDate(baseWeek.getDate() - baseWeek.getDay()); baseWeek.setHours(0, 0, 0, 0);
    const nextStart = (current) => {
      if (recurrence.frequency === 'monthly' || (recurrence.frequency === 'custom' && recurrence.unit === 'months')) {
        const dayOfMonth = baseStart.getDate(); let monthIndex = current.getMonth() + recurrence.interval; let guard = 0;
        while (guard < 1200) { const year = current.getFullYear() + Math.floor(monthIndex / 12); const month = ((monthIndex % 12) + 12) % 12; const daysInMonth = new Date(year, month + 1, 0).getDate(); if (dayOfMonth <= daysInMonth) return new Date(year, month, dayOfMonth, baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), baseStart.getMilliseconds()); monthIndex += recurrence.interval; guard += 1; }
        return null;
      }
      if (weeklyRule && selectedWeekdays.length) {
        for (let offset = 1; offset <= 7 * (recurrence.interval + 1); offset += 1) {
          const candidate = new Date(current); candidate.setDate(candidate.getDate() + offset);
          const week = new Date(candidate); week.setDate(week.getDate() - week.getDay()); week.setHours(0, 0, 0, 0);
          const weekIndex = Math.round((week.getTime() - baseWeek.getTime()) / (7 * DAY_MS));
          if (weekIndex >= 0 && weekIndex % recurrence.interval === 0 && selectedWeekdays.includes(candidate.getDay())) return candidate;
        }
      }
      if (!stepDays) return null;
      const next = new Date(current); next.setDate(next.getDate() + stepDays); return next;
    };
    if (weeklyRule && selectedWeekdays.length && !selectedWeekdays.includes(start.getDay())) start = nextStart(start);
    while (index < maxOccurrences) {
      const occurrenceKey = start.toISOString();
      const exception = Array.isArray(item.exceptions) ? item.exceptions.find((entry) => entry.key === occurrenceKey) : null;
      if (exception?.cancelled) {
        if (recurrence.count && index + 1 >= recurrence.count) break;
        start = nextStart(start); if (!start) break; index++;
        continue;
      }
      const baseOccurrenceEnd = new Date(start.getTime() + duration);
      const effectiveStart = exception?.start ? new Date(exception.start) : start;
      const end = exception?.deadline ? new Date(exception.deadline) : baseOccurrenceEnd;
      if (recurrence.until && start > new Date(recurrence.until + 'T23:59:59.999Z')) break;
      if (end > range.start && effectiveStart < range.end) result.push({ item, start: effectiveStart, end, baseStart: new Date(start), baseEnd: baseOccurrenceEnd, occurrence: index, occurrenceKey: occurrenceKey, exception: exception });
      if (recurrence.frequency === 'none' || (recurrence.count && index + 1 >= recurrence.count)) break;
      start = nextStart(start); if (!start) break; index++;
      if (start >= range.end && index > 0 && !item.exceptions?.some((entry) => entry.key === start.toISOString())) break;
    }
    const seen = new Set(result.map((entry) => entry.occurrenceKey));
    (item.exceptions || []).filter((exception) => !exception.cancelled && !seen.has(exception.key)).forEach((exception) => {
      const effectiveStart = new Date(exception.start); const end = new Date(exception.deadline); const originalStart = new Date(exception.key);
      if (!Number.isNaN(effectiveStart.getTime()) && !Number.isNaN(end.getTime()) && end > range.start && effectiveStart < range.end) result.push({ item, start: effectiveStart, end, baseStart: originalStart, baseEnd: new Date(originalStart.getTime() + duration), occurrence: -1, occurrenceKey: exception.key, exception: exception });
    });
    return result;
  }

  root.ProximaScheduleProjection=Object.freeze({occurrences:scheduleOccurrences});
})(globalThis);
