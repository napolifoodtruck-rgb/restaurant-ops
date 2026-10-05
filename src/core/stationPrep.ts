/**
 * Prep by station, live.
 *
 * Line cooks see their own station's list and check things off. A sous chef or chef sees
 * every station on one screen, with what's done, what's left and when each station will
 * finish at its pace. Every check-off keeps who and when, so over time the app learns how
 * long each task takes, whether the suggested order is followed, and how cooks compare on
 * the same task — numbers meant for coaching, shown to chef and manager roles by default.
 *
 * Durations come from an optional "start" tap, or else from the gap since the same cook's
 * previous check-off. Check-offs bunched together (everything ticked at 3:55) are batch
 * check-offs, not speed, and are left out.
 */

export type RoleLevel = 'line' | 'lead' | 'sous' | 'chef' | 'manager' | 'owner';
const RANK: Record<RoleLevel, number> = { line: 0, lead: 1, sous: 2, chef: 3, manager: 4, owner: 5 };

export interface PrepTask {
  id: string;
  stationId?: string;
  recipeId: string;
  /** In the recipe's yield unit. */
  amount: number;
  suggestedOrder: number;
  /** ISO time service needs it by. */
  neededBy?: string;
  status: 'open' | 'started' | 'done' | 'skipped';
  startedAt?: string;
  startedBy?: string;
  completedAt?: string;
  completedBy?: string;
}

export interface Viewer {
  staffId: string;
  role: RoleLevel;
  /** Stations they work today. */
  stations: readonly string[];
}

/** Sous chefs and above see every station; others see the stations they work today. */
export function canSeeAllStations(viewer: Viewer): boolean {
  return RANK[viewer.role] >= RANK.sous;
}

export function visibleTasks(tasks: readonly PrepTask[], viewer: Viewer): PrepTask[] {
  if (canSeeAllStations(viewer)) return [...tasks];
  return tasks.filter((t) => t.stationId !== undefined && viewer.stations.includes(t.stationId));
}

// ---------------------------------------------------------------- how long tasks take

const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? undefined : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface TimedTask {
  task: PrepTask;
  minutes: number;
  /** 'started': from a start tap. 'gap': since the cook's previous check-off. */
  source: 'started' | 'gap';
}

export interface TimingOptions {
  /** Check-offs this close to the cook's previous one are batch check-offs. Default 2 minutes. */
  batchGapMinutes?: number;
  /** Gaps longer than this aren't one task (a break, a delivery). Default 120 minutes. */
  maxGapMinutes?: number;
}

/** How long each finished task took, where it can be told. */
export function timedTasks(tasks: readonly PrepTask[], options: TimingOptions = {}): { timed: TimedTask[]; batchCheckOffs: PrepTask[] } {
  const batchGap = options.batchGapMinutes ?? 2;
  const maxGap = options.maxGapMinutes ?? 120;
  const done = tasks.filter((t) => t.status === 'done' && t.completedAt && t.completedBy);
  const byCook = new Map<string, PrepTask[]>();
  for (const t of done) byCook.set(t.completedBy!, [...(byCook.get(t.completedBy!) ?? []), t]);

  const timed: TimedTask[] = [];
  const batchCheckOffs: PrepTask[] = [];
  for (const list of byCook.values()) {
    list.sort((a, b) => a.completedAt!.localeCompare(b.completedAt!));
    list.forEach((t, i) => {
      if (t.startedAt) {
        timed.push({ task: t, minutes: minutesBetween(t.startedAt, t.completedAt!), source: 'started' });
        return;
      }
      const previous = list[i - 1];
      if (!previous) return; // the day's first task: no way to tell when it began
      const gap = minutesBetween(previous.completedAt!, t.completedAt!);
      if (gap < batchGap) batchCheckOffs.push(t);
      else if (gap <= maxGap) timed.push({ task: t, minutes: gap, source: 'gap' });
    });
  }
  return { timed, batchCheckOffs };
}

/** Typical minutes per unit of each recipe, from past timed tasks. */
export function typicalMinutesPerUnit(history: readonly TimedTask[]): Map<string, number> {
  const per = new Map<string, number[]>();
  for (const { task, minutes } of history) {
    if (task.amount > 0) per.set(task.recipeId, [...(per.get(task.recipeId) ?? []), minutes / task.amount]);
  }
  return new Map([...per].map(([id, xs]) => [id, median(xs)!]));
}

// ---------------------------------------------------------------- live progress

export interface StationProgress {
  stationId: string;
  done: number;
  total: number;
  /** Minutes of work left at typical pace, shared across the cooks on the station. */
  minutesLeft: number;
  /** Tasks with no history yet, left out of minutesLeft. */
  untimed: number;
  projectedFinish: string;
  /** Earliest time an unfinished task is needed by. */
  neededBy?: string;
  behind: boolean;
}

/**
 * Where each station stands now: tasks done, work left at typical pace, projected finish,
 * and whether that's later than service needs.
 */
export function stationProgress(tasks: readonly PrepTask[], now: string, typical: ReadonlyMap<string, number>, cooksPerStation: ReadonlyMap<string, number> = new Map()): StationProgress[] {
  const stations = new Map<string, PrepTask[]>();
  for (const t of tasks) if (t.stationId && t.status !== 'skipped') stations.set(t.stationId, [...(stations.get(t.stationId) ?? []), t]);

  return [...stations].map(([stationId, list]) => {
    let minutes = 0;
    let untimed = 0;
    let neededBy: string | undefined;
    for (const t of list) {
      if (t.status === 'done') continue;
      if (t.neededBy && (!neededBy || t.neededBy < neededBy)) neededBy = t.neededBy;
      const perUnit = typical.get(t.recipeId);
      if (perUnit === undefined) {
        untimed++;
        continue;
      }
      const full = perUnit * t.amount;
      minutes += t.status === 'started' && t.startedAt ? Math.max(0, full - minutesBetween(t.startedAt, now)) : full;
    }
    const cooks = Math.max(1, cooksPerStation.get(stationId) ?? 1);
    const minutesLeft = minutes / cooks;
    const projectedFinish = new Date(Date.parse(now) + minutesLeft * 60000).toISOString();
    return {
      stationId,
      done: list.filter((t) => t.status === 'done').length,
      total: list.length,
      minutesLeft,
      untimed,
      projectedFinish,
      ...(neededBy ? { neededBy } : {}),
      behind: !!neededBy && projectedFinish > new Date(Date.parse(neededBy)).toISOString(),
    };
  });
}

// ---------------------------------------------------------------- order and speed

export interface OrderReport {
  staffId: string;
  /** 1 = done exactly in the suggested order; lower means more jumping around. */
  inOrder: number;
  /** Tasks done ahead of higher-priority tasks the same cook finished later. */
  jumpedAhead: { task: PrepTask; ahead: PrepTask[] }[];
}

/** Suggested vs actual order, per cook, for one day's finished tasks. */
export function orderReport(tasks: readonly PrepTask[]): OrderReport[] {
  const byCook = new Map<string, PrepTask[]>();
  for (const t of tasks) if (t.status === 'done' && t.completedAt && t.completedBy) byCook.set(t.completedBy, [...(byCook.get(t.completedBy) ?? []), t]);
  return [...byCook].map(([staffId, list]) => {
    const done = [...list].sort((a, b) => a.completedAt!.localeCompare(b.completedAt!));
    let pairs = 0;
    let inversions = 0;
    const jumpedAhead: OrderReport['jumpedAhead'] = [];
    done.forEach((t, i) => {
      const ahead = done.slice(i + 1).filter((later) => later.suggestedOrder < t.suggestedOrder);
      pairs += done.length - i - 1;
      inversions += ahead.length;
      if (ahead.length) jumpedAhead.push({ task: t, ahead });
    });
    return { staffId, inOrder: pairs ? 1 - inversions / pairs : 1, jumpedAhead };
  });
}

export interface SpeedLine {
  staffId: string;
  recipeId: string;
  tasks: number;
  /** Their typical minutes per unit ÷ everyone's: 1.3 = 30% slower on this task. */
  relative: number;
}

/**
 * Each cook's pace on each recipe against the kitchen's, same task to same task, once
 * there are enough timed tasks on both sides to mean something.
 */
export function speedReport(history: readonly TimedTask[], options: { minTasks?: number } = {}): SpeedLine[] {
  const minTasks = options.minTasks ?? 3;
  const kitchen = typicalMinutesPerUnit(history);
  const per = new Map<string, number[]>();
  for (const { task, minutes } of history) {
    if (!task.completedBy || !(task.amount > 0)) continue;
    const key = `${task.completedBy}|${task.recipeId}`;
    per.set(key, [...(per.get(key) ?? []), minutes / task.amount]);
  }
  const lines: SpeedLine[] = [];
  for (const [key, xs] of per) {
    const [staffId, recipeId] = key.split('|') as [string, string];
    const all = history.filter((h) => h.task.recipeId === recipeId).length;
    if (xs.length < minTasks || all - xs.length < minTasks) continue; // need others to compare with
    lines.push({ staffId, recipeId, tasks: xs.length, relative: median(xs)! / kitchen.get(recipeId)! });
  }
  return lines.sort((a, b) => b.relative - a.relative);
}
