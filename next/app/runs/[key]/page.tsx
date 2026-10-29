import { RunScreen } from '../../../components/flow/run-screen';

export default async function RunPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <RunScreen runKey={decodeURIComponent(key)} />;
}
