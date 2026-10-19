/**
 * Moving a bar on the calendar: the same engine preview as the Gantt (ADR-017), by whole days.
 * DAY projects move by calendar days (the engine snaps to a working day); HOUR projects move by
 * 1,440 wall-clock minutes per day. The result's `changes` is the ONE batch sent with
 * `writes.commitBatch` (groups bring their children; successors shift when auto-scheduling).
 */
import type { TaskDto } from '@nuzli/shared';
import type { GanttView } from '../../api/hoursWire';
import { unitOf } from '../../api/hoursWire';
import { previewMove, previewMoveMinutes, type EngineState, type Preview } from '../gantt/batch';

const EMPTY: Preview = { changes: [], byId: new Map() };

export function previewCalendarMove(
  data: Pick<GanttView, 'project'>,
  state: EngineState,
  task: TaskDto,
  deltaDays: number,
): Preview {
  if (!deltaDays) return EMPTY;
  try {
    return unitOf(data.project) === 'HOUR'
      ? previewMoveMinutes(state, task, deltaDays * 1440)
      : previewMove(state, task, deltaDays);
  } catch {
    // An edit the engine refuses (e.g. a dependency it cannot satisfy) previews as no change.
    return EMPTY;
  }
}
