import { RunScreen } from '../../../features/run';

export default async function RunPage({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<React.ReactElement> {
  const { key } = await params;
  return <RunScreen runKey={decodeURIComponent(key)} />;
}
