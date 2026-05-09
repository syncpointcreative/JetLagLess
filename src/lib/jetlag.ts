export type Direction = 'east' | 'west' | 'none';

export interface JetlagInput {
  homeOffsetHours: number;
  destOffsetHours: number;
  departureLocalTime: string;
  flightDurationHours: number;
  usualBedtime: string;
  usualWakeTime: string;
  prepDaysAvailable: number;
}

export interface JetlagPlan {
  shiftHours: number;
  direction: Direction;
  severity: 'mild' | 'moderate' | 'severe';
  daysToFullyAdjust: number;
  arrivalLocalTime: string;
  usualSleepDurationHours: number;
  preFlightShifts: { day: number; bedtime: string; wakeTime: string }[];
  onboardSleep: {
    shouldSleep: boolean;
    sleepAtFlightHour: number;
    wakeAtFlightHour: number;
    sleepAtDestLocal: string;
    wakeAtDestLocal: string;
    durationHours: number;
    rationale: string;
  };
  arrivalAdvice: string[];
}

const parseTime = (t: string): number => {
  const [h, m] = t.split(':').map((n) => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) throw new Error(`Invalid time: ${t}`);
  return h + m / 60;
};

const formatTime = (hours: number): string => {
  let h = ((hours % 24) + 24) % 24;
  const mins = Math.round((h - Math.floor(h)) * 60);
  let hh = Math.floor(h);
  let mm = mins;
  if (mm === 60) {
    mm = 0;
    hh = (hh + 1) % 24;
  }
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
};

const sleepDuration = (bedtime: number, wake: number): number => {
  let dur = wake - bedtime;
  if (dur <= 0) dur += 24;
  return dur;
};

export function buildPlan(input: JetlagInput): JetlagPlan {
  const rawShift = input.destOffsetHours - input.homeOffsetHours;
  // Body adjusts along the shorter circadian path: a +14h trip is felt as -10h.
  let shift = rawShift;
  if (shift > 12) shift -= 24;
  if (shift < -12) shift += 24;
  const absShift = Math.abs(shift);
  const direction: Direction = shift > 0 ? 'east' : shift < 0 ? 'west' : 'none';

  // Eastward (advance) is harder than westward (delay).
  const adjustRate = direction === 'east' ? 1.0 : 1.5;
  const daysToFullyAdjust = Math.ceil(absShift / adjustRate);

  const severity: JetlagPlan['severity'] =
    absShift < 3 ? 'mild' : absShift < 7 ? 'moderate' : 'severe';

  const depHome = parseTime(input.departureLocalTime);
  const arrDest = depHome + input.flightDurationHours + rawShift;
  const arrivalLocalTime = formatTime(arrDest);

  const usualBed = parseTime(input.usualBedtime);
  const usualWake = parseTime(input.usualWakeTime);
  const usualSleepDurationHours = sleepDuration(usualBed, usualWake);

  // Pre-flight plan: shift sleep toward destination time gradually.
  const days = Math.min(input.prepDaysAvailable, daysToFullyAdjust);
  const perDayShift = days > 0 ? Math.min(absShift / days, 1.5) : 0;
  const preFlightShifts: JetlagPlan['preFlightShifts'] = [];
  for (let d = 1; d <= days; d++) {
    const delta = perDayShift * d * (direction === 'east' ? -1 : 1);
    preFlightShifts.push({
      day: d,
      bedtime: formatTime(usualBed + delta),
      wakeTime: formatTime(usualWake + delta),
    });
  }

  // Onboard sleep: target destination nighttime (22:00-07:00) during flight.
  const flightStartDest = depHome + rawShift;
  const flightEndDest = flightStartDest + input.flightDurationHours;

  const overlap = nightOverlap(flightStartDest, flightEndDest);
  let onboardSleep: JetlagPlan['onboardSleep'];

  if (overlap.duration >= 1.5) {
    const sleepDur = Math.min(overlap.duration, usualSleepDurationHours);
    const sleepStartDest = overlap.start;
    const sleepEndDest = sleepStartDest + sleepDur;
    const sleepAtFlightHour = sleepStartDest - flightStartDest;
    onboardSleep = {
      shouldSleep: true,
      sleepAtFlightHour,
      wakeAtFlightHour: sleepAtFlightHour + sleepDur,
      sleepAtDestLocal: formatTime(sleepStartDest),
      wakeAtDestLocal: formatTime(sleepEndDest),
      durationHours: sleepDur,
      rationale:
        `Your flight overlaps with night at your destination for ${overlap.duration.toFixed(1)}h. ` +
        `Sleeping during this window starts your circadian shift in the air.`,
    };
  } else {
    onboardSleep = {
      shouldSleep: false,
      sleepAtFlightHour: 0,
      wakeAtFlightHour: 0,
      sleepAtDestLocal: '--:--',
      wakeAtDestLocal: '--:--',
      durationHours: 0,
      rationale:
        `Your flight barely overlaps with night at your destination (${overlap.duration.toFixed(1)}h). ` +
        `Stay awake, hydrate, and save sleep for after arrival.`,
    };
  }

  const arrivalAdvice: string[] = [];
  if (direction === 'east') {
    arrivalAdvice.push('Seek bright morning light at destination — it advances your clock.');
    arrivalAdvice.push('Avoid bright light in the evening for the first 2-3 days.');
  } else if (direction === 'west') {
    arrivalAdvice.push('Seek bright evening light at destination — it delays your clock.');
    arrivalAdvice.push('Avoid bright light early in the morning for the first 2-3 days.');
  }
  if (arrDest >= 6 && arrDest <= 20) {
    arrivalAdvice.push(
      'You arrive during destination daytime — stay awake until at least 22:00 local.',
    );
  } else {
    arrivalAdvice.push('You arrive at destination night — go to bed at a normal local hour.');
  }
  arrivalAdvice.push('Hydrate aggressively; cabin air dehydrates and worsens jetlag symptoms.');

  return {
    shiftHours: shift,
    direction,
    severity,
    daysToFullyAdjust,
    arrivalLocalTime,
    usualSleepDurationHours,
    preFlightShifts,
    onboardSleep,
    arrivalAdvice,
  };
}

function nightOverlap(startDestHr: number, endDestHr: number) {
  // Destination night defined as 22:00 -> 07:00 (9h window).
  // Find the largest overlap of [startDestHr, endDestHr] with any night window.
  let best = { start: 0, duration: 0 };
  for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
    const nightStart = 22 + dayOffset * 24;
    const nightEnd = nightStart + 9;
    const oStart = Math.max(startDestHr, nightStart);
    const oEnd = Math.min(endDestHr, nightEnd);
    const dur = oEnd - oStart;
    if (dur > best.duration) best = { start: oStart, duration: dur };
  }
  return best;
}
