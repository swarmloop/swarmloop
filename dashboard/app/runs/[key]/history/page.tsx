import { HistoryScreen } from '../../../../features/run';

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<React.ReactElement> {
  const { key } = await params;
  return <HistoryScreen runKey={decodeURIComponent(key)} />;
}
