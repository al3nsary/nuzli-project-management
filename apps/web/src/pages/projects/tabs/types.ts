import type { TaskView, GanttView } from '../../../api/hoursWire';
import type { ProjectWrites } from '../../../api/projectWrites';

/**
 * Props of every project tab (ProjectPage mounts the active one). `data` is the Gantt payload
 * (the single source of the project views); `visible` is the toolbar filter (assignee, status,
 * priority, label, team, custom field, search) — tabs that list tasks apply it.
 */
export interface TabProps {
  data: GanttView;
  writes: ProjectWrites;
  onOpenTask(id: string): void;
  visible(task: TaskView): boolean;
}
