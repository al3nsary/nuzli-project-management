/**
 * The supervisor's task page `/my-tasks/:id` (owner request A9: «عندما يفتح المشرف المهمة يمكنه
 * أن يرى الملاحظات كشات ويمكنه الرد عليها»). The screen itself is `TaskWorkspace`, which admins
 * also open over a project from a task's chat icon (A10). A task that is not assigned to the
 * viewer answers 404 → a friendly state with a way back.
 */
import { useParams } from 'react-router-dom';
import { useMyTasks } from '../../api/projectQueries';
import { TaskWorkspace } from './TaskWorkspace';

export function MyTaskPage() {
  const { id = '' } = useParams();
  const mine = useMyTasks();
  const projectName = mine.data?.find((x) => x.id === id)?.project.name ?? null;
  return <TaskWorkspace taskId={id} variant="page" projectName={projectName} />;
}
