import { HistoryScreen } from '../../../../components/history-screen';

export default async function HistoryPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <HistoryScreen runKey={decodeURIComponent(key)} />;
}
