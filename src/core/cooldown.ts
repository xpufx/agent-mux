export function parseResetDurationSeconds(text: string): number {
  const match = text.match(/Resets in\s+([^.\r\n]+)/i);
  if (match) {
    const duration = match[1];
    const days = duration.match(/(\d+)\s*d/i);
    const hours = duration.match(/(\d+)\s*h/i);
    const mins = duration.match(/(\d+)\s*m/i);
    const secs = duration.match(/(\d+)\s*s/i);
    let total = 0;
    if (days) total += parseInt(days[1], 10) * 86400;
    if (hours) total += parseInt(hours[1], 10) * 3600;
    if (mins) total += parseInt(mins[1], 10) * 60;
    if (secs) total += parseInt(secs[1], 10);
    if (total > 0) return total;
  }
  return 3600;
}
