export type Direction = 'east' | 'west' | 'none';
export type Severity = 'mild' | 'moderate' | 'severe';

/**
 * One flight segment, expressed as instants (UTC) plus the IANA timezones of
 * the airports it operates from / to. The UI converts user-entered local
 * date+time into the UTC instants before calling the planner.
 */
export interface LegInput {
  originTz: string;
  destTz: string;
  departureUtc: Date;
  arrivalUtc: Date;
}

export type PlaneSleepAbility = 'none' | 'poor' | 'okay' | 'good';
export type BathroomFrequency = 'rare' | 'average' | 'often';
export type MealStrategy = 'skip' | 'light' | 'regular';
export type CaffeineSensitivity = 'low' | 'normal' | 'high';
export type Chronotype = 'early' | 'neutral' | 'night';

export interface PersonalProfile {
  planeSleepAbility: PlaneSleepAbility;
  bathroomFrequency: BathroomFrequency;
  mealStrategy: MealStrategy;
  caffeineSensitivity: CaffeineSensitivity;
  alcoholOnFlights: boolean;
  chronotype: Chronotype;
}

export const DEFAULT_PROFILE: PersonalProfile = {
  planeSleepAbility: 'poor',
  bathroomFrequency: 'average',
  mealStrategy: 'light',
  caffeineSensitivity: 'normal',
  alcoholOnFlights: false,
  chronotype: 'neutral',
};

export interface ItineraryInput {
  legs: LegInput[];
  usualBedtime: string;
  usualWakeTime: string;
  prepDaysAvailable: number;
  profile?: PersonalProfile;
}

export interface LegPlan {
  index: number;
  durationHours: number;
  onboardSleep: {
    shouldSleep: boolean;
    sleepAtFlightHour: number;
    wakeAtFlightHour: number;
    sleepAtFinalDestLocal: string;
    wakeAtFinalDestLocal: string;
    durationHours: number;
    rationale: string;
  };
}

export interface LayoverPlan {
  afterLegIndex: number;
  durationHours: number;
  airportTz: string;
  arrivalLocalTime: string;
  departureLocalTime: string;
  classification: 'short' | 'medium' | 'long';
  advice: string[];
}

export interface ItineraryPlan {
  shiftHours: number;
  direction: Direction;
  severity: Severity;
  daysToFullyAdjust: number;
  totalTravelHours: number;
  arrivalLocalTime: string;
  usualSleepDurationHours: number;
  onboardSleepCapHours: number;
  preFlightShifts: { day: number; bedtime: string; wakeTime: string }[];
  preFlightAdvice: string[];
  legs: LegPlan[];
  layovers: LayoverPlan[];
  inflightAdvice: string[];
  arrivalAdvice: string[];
}

const parseTime = (t: string): number => {
  const [h, m] = t.split(':').map((n) => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) throw new Error(`Invalid time: ${t}`);
  return h + m / 60;
};

const fmt = (hours: number): string => {
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

/** Hours of UTC offset for an IANA timezone at a specific instant. Handles DST. */
export function tzOffsetHours(timeZone: string, at: Date = new Date()): number {
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tgt = new Date(at.toLocaleString('en-US', { timeZone }));
  return (tgt.getTime() - utc.getTime()) / 3_600_000;
}

/** Local hour-of-day (0-24, fractional) for an instant in a timezone. */
function localHour(at: Date, tz: string): number {
  const offset = tzOffsetHours(tz, at);
  const localMs = at.getTime() + offset * 3_600_000;
  const d = new Date(localMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

function nightOverlap(startHr: number, endHr: number) {
  // Destination night: 22:00 -> 07:00 local (9h window).
  let best = { start: 0, duration: 0 };
  for (let dayOffset = -1; dayOffset <= 2; dayOffset++) {
    const nightStart = 22 + dayOffset * 24;
    const nightEnd = nightStart + 9;
    const oStart = Math.max(startHr, nightStart);
    const oEnd = Math.min(endHr, nightEnd);
    const dur = oEnd - oStart;
    if (dur > best.duration) best = { start: oStart, duration: dur };
  }
  return best;
}

export function buildItineraryPlan(input: ItineraryInput): ItineraryPlan {
  if (input.legs.length === 0) throw new Error('Add at least one flight leg.');
  for (const l of input.legs) {
    if (l.arrivalUtc.getTime() <= l.departureUtc.getTime()) {
      throw new Error('Each leg must arrive after it departs.');
    }
  }

  const firstLeg = input.legs[0];
  const lastLeg = input.legs[input.legs.length - 1];

  const homeOffset = tzOffsetHours(firstLeg.originTz, firstLeg.departureUtc);
  const destOffset = tzOffsetHours(lastLeg.destTz, lastLeg.arrivalUtc);
  const rawShift = destOffset - homeOffset;
  let shift = rawShift;
  if (shift > 12) shift -= 24;
  if (shift < -12) shift += 24;
  const absShift = Math.abs(shift);
  const direction: Direction = shift > 0 ? 'east' : shift < 0 ? 'west' : 'none';

  const profile = input.profile ?? DEFAULT_PROFILE;

  // Eastward (advance) is harder than westward (delay). Chronotype tilts the
  // rate: night owls naturally drift later, so westward is a bit easier and
  // eastward harder; early birds the opposite.
  let baseRate = direction === 'east' ? 1.0 : 1.5;
  if (profile.chronotype === 'night') {
    baseRate *= direction === 'east' ? 0.85 : 1.15;
  } else if (profile.chronotype === 'early') {
    baseRate *= direction === 'east' ? 1.15 : 0.85;
  }
  const adjustRate = baseRate;
  const daysToFullyAdjust = Math.max(1, Math.ceil(absShift / adjustRate));
  const severity: Severity = absShift < 3 ? 'mild' : absShift < 7 ? 'moderate' : 'severe';

  const usualBed = parseTime(input.usualBedtime);
  const usualWake = parseTime(input.usualWakeTime);
  const usualSleepDurationHours = sleepDuration(usualBed, usualWake);

  const planeSleepFactor: Record<PlaneSleepAbility, number> = {
    none: 0,
    poor: 0.4,
    okay: 0.7,
    good: 1.0,
  };
  const onboardSleepCapHours = usualSleepDurationHours * planeSleepFactor[profile.planeSleepAbility];

  // Pre-flight gradual shift toward destination time.
  const days = Math.min(input.prepDaysAvailable, daysToFullyAdjust);
  const perDayShift = days > 0 ? Math.min(absShift / days, 1.5) : 0;
  const preFlightShifts: ItineraryPlan['preFlightShifts'] = [];
  for (let d = 1; d <= days; d++) {
    const delta = perDayShift * d * (direction === 'east' ? -1 : 1);
    preFlightShifts.push({
      day: d,
      bedtime: fmt(usualBed + delta),
      wakeTime: fmt(usualWake + delta),
    });
  }

  // Per-leg onboard sleep, allocated against final-destination night.
  const finalDestTz = lastLeg.destTz;
  const legCandidates = input.legs.map((leg, index) => {
    const startFinal = localHour(leg.departureUtc, finalDestTz);
    const durationHours = (leg.arrivalUtc.getTime() - leg.departureUtc.getTime()) / 3_600_000;
    const endFinal = startFinal + durationHours;
    const overlap = nightOverlap(startFinal, endFinal);
    return { leg, index, startFinal, durationHours, overlap };
  });

  // Allocate sleep budget greedily to the legs with biggest night overlap.
  const sortedByOverlap = [...legCandidates].sort((a, b) => b.overlap.duration - a.overlap.duration);
  let remainingBudget = onboardSleepCapHours;
  const allocated = new Map<number, number>();
  for (const c of sortedByOverlap) {
    if (remainingBudget <= 0) break;
    if (c.overlap.duration < 1.5) continue;
    const take = Math.min(c.overlap.duration, remainingBudget);
    allocated.set(c.index, take);
    remainingBudget -= take;
  }

  const legs: LegPlan[] = legCandidates.map((c) => {
    const sleepDur = allocated.get(c.index) ?? 0;
    if (sleepDur > 0) {
      const sleepStartFinal = c.overlap.start;
      const sleepEndFinal = sleepStartFinal + sleepDur;
      return {
        index: c.index,
        durationHours: c.durationHours,
        onboardSleep: {
          shouldSleep: true,
          sleepAtFlightHour: sleepStartFinal - c.startFinal,
          wakeAtFlightHour: sleepStartFinal - c.startFinal + sleepDur,
          sleepAtFinalDestLocal: fmt(sleepStartFinal),
          wakeAtFinalDestLocal: fmt(sleepEndFinal),
          durationHours: sleepDur,
          rationale: `This leg overlaps ${c.overlap.duration.toFixed(1)}h with night at your final destination.`,
        },
      };
    }
    return {
      index: c.index,
      durationHours: c.durationHours,
      onboardSleep: {
        shouldSleep: false,
        sleepAtFlightHour: 0,
        wakeAtFlightHour: 0,
        sleepAtFinalDestLocal: '--:--',
        wakeAtFinalDestLocal: '--:--',
        durationHours: 0,
        rationale: c.overlap.duration < 1.5
          ? `Little overlap with destination night (${c.overlap.duration.toFixed(1)}h) — stay awake.`
          : 'Sleep budget already met by another leg — stay awake here.',
      },
    };
  });

  const layovers: LayoverPlan[] = [];
  for (let i = 0; i < input.legs.length - 1; i++) {
    const arrived = input.legs[i].arrivalUtc;
    const nextDep = input.legs[i + 1].departureUtc;
    const layoverHours = (nextDep.getTime() - arrived.getTime()) / 3_600_000;
    if (layoverHours <= 0) continue;
    const tz = input.legs[i + 1].originTz;
    const arrLocal = localHour(arrived, tz);
    const depLocal = localHour(nextDep, tz);
    const cls: LayoverPlan['classification'] =
      layoverHours < 3 ? 'short' : layoverHours < 8 ? 'medium' : 'long';
    const advice: string[] = [];
    if (cls === 'short') {
      advice.push('Stretch, walk the terminal, hydrate. No time for a real rest.');
    } else if (cls === 'medium') {
      advice.push('Get a real meal at the local meal time, walk, hydrate.');
      advice.push('Avoid napping unless the next leg leaves overnight at the final destination.');
    } else {
      const layoverNight = nightOverlap(arrLocal, arrLocal + layoverHours);
      if (layoverNight.duration >= 4) {
        advice.push(
          `Long layover overlaps ${layoverNight.duration.toFixed(1)}h with night here — book a lounge or hotel and sleep.`,
        );
      } else {
        advice.push('Long daytime layover — eat on local schedule, get sunlight, walk.');
      }
    }
    layovers.push({
      afterLegIndex: i,
      durationHours: layoverHours,
      airportTz: tz,
      arrivalLocalTime: fmt(arrLocal),
      departureLocalTime: fmt(depLocal),
      classification: cls,
      advice,
    });
  }

  const totalTravelHours =
    (lastLeg.arrivalUtc.getTime() - firstLeg.departureUtc.getTime()) / 3_600_000;
  const arrivalLocalTime = fmt(localHour(lastLeg.arrivalUtc, lastLeg.destTz));

  const arrivalAdvice: string[] = [];
  if (direction === 'east') {
    arrivalAdvice.push('Seek bright morning light at destination — it advances your clock.');
    arrivalAdvice.push('Avoid bright light in the evening for the first 2-3 days.');
  } else if (direction === 'west') {
    arrivalAdvice.push('Seek bright evening light at destination — it delays your clock.');
    arrivalAdvice.push('Avoid bright light early in the morning for the first 2-3 days.');
  }
  const arrLocalHr = localHour(lastLeg.arrivalUtc, lastLeg.destTz);
  if (arrLocalHr >= 6 && arrLocalHr <= 20) {
    arrivalAdvice.push(
      'You arrive during destination daytime — stay awake until at least 22:00 local.',
    );
  } else {
    arrivalAdvice.push('You arrive at destination night — go to bed at a normal local hour.');
  }
  arrivalAdvice.push('Hydrate aggressively; cabin air dehydrates and worsens jetlag symptoms.');

  const inflightAdvice = buildInflightAdvice(profile, legs, onboardSleepCapHours);
  const preFlightAdvice = buildPreFlightAdvice(profile, direction);

  return {
    shiftHours: shift,
    direction,
    severity,
    daysToFullyAdjust,
    totalTravelHours,
    arrivalLocalTime,
    usualSleepDurationHours,
    onboardSleepCapHours,
    preFlightShifts,
    preFlightAdvice,
    legs,
    layovers,
    inflightAdvice,
    arrivalAdvice,
  };
}

function buildInflightAdvice(
  profile: PersonalProfile,
  legs: LegPlan[],
  onboardSleepCapHours: number,
): string[] {
  const advice: string[] = [];
  const firstSleep = legs.find((l) => l.onboardSleep.shouldSleep);

  // Caffeine
  const cutoffHours = profile.caffeineSensitivity === 'high'
    ? 8
    : profile.caffeineSensitivity === 'low'
      ? 4
      : 6;
  if (firstSleep) {
    const sleepStart = parseTime(firstSleep.onboardSleep.sleepAtFinalDestLocal);
    const cutoffLocal = fmt(sleepStart - cutoffHours);
    advice.push(
      `Caffeine cutoff: no coffee/tea after ${cutoffLocal} (final-destination time) — that's ${cutoffHours}h before your sleep window.`,
    );
  } else if (onboardSleepCapHours === 0) {
    advice.push('No onboard sleep planned — caffeine is fine in moderation, but stop 6h before destination bedtime.');
  }

  // Alcohol
  if (profile.alcoholOnFlights) {
    advice.push('Skip the in-flight wine. Alcohol fragments deep sleep and the dry cabin amplifies dehydration.');
  } else {
    advice.push('Continue avoiding alcohol — it disrupts sleep architecture and worsens cabin dehydration.');
  }

  // Hydration / bathroom
  if (profile.bathroomFrequency === 'often') {
    advice.push('Take an aisle seat. Sip water steadily but stop drinking ~3h before any sleep window.');
  } else if (profile.bathroomFrequency === 'average') {
    advice.push('Drink ~1 cup of water per flight hour; switch to small sips ~2h before any sleep window.');
  } else {
    advice.push('Drink ~1 cup of water per flight hour; cabin air dehydrates faster than you think.');
  }

  // Meals
  if (profile.mealStrategy === 'skip') {
    advice.push('Skipping meals is fine — fasting actually helps the circadian shift. Just keep hydrating.');
  } else if (profile.mealStrategy === 'light') {
    advice.push('Eat light. Skip any in-flight meal that falls during your destination\'s nighttime.');
  } else {
    advice.push('Eat on your destination\'s clock: take meals at destination breakfast/lunch/dinner times, skip ones served during destination night.');
  }

  // Plane sleep ability override
  if (profile.planeSleepAbility === 'none') {
    advice.push('You said you can\'t sleep on planes — don\'t fight it. Use eye mask + earplugs to rest, and bank sleep before/after.');
  } else if (profile.planeSleepAbility === 'poor') {
    advice.push('Tip for poor plane sleepers: eye mask, earplugs, neck pillow, recline as much as possible, and don\'t check the time.');
  }

  return advice;
}

function buildPreFlightAdvice(profile: PersonalProfile, direction: Direction): string[] {
  const advice: string[] = [];
  const cutoffHours = profile.caffeineSensitivity === 'high'
    ? 10
    : profile.caffeineSensitivity === 'low'
      ? 6
      : 8;
  advice.push(
    `On each prep day, no caffeine within ${cutoffHours}h of your shifted bedtime.`,
  );
  if (direction === 'east') {
    advice.push('Get morning sunlight on prep days; dim screens after dinner.');
  } else if (direction === 'west') {
    advice.push('Get evening sunlight on prep days; avoid bright morning light.');
  }
  if (profile.chronotype === 'night' && direction === 'east') {
    advice.push('Heads-up: as a night owl going east, expect this to feel rougher than the schedule suggests. Be strict on the prep schedule.');
  } else if (profile.chronotype === 'early' && direction === 'west') {
    advice.push('Heads-up: as an early bird going west, staying up later will feel unnatural. Use evening light to push yourself.');
  }
  return advice;
}
