import { Tracer } from "@/components/tracer";

type Props = { params: Promise<{ id: string }> };

export default async function PlayPage({ params }: Props) {
  const { id } = await params;
  return <Tracer id={id} />;
}
