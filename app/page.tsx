import { HomeForm } from "@/components/home-form";
import { tasks } from "@/server/tasks";

export default function Page() {
  return (
    <HomeForm
      tasks={tasks.map((task) => ({
        id: task.id,
        title: task.title,
        blurb: task.blurb,
        source: task.source,
      }))}
    />
  );
}
