import { BacklogScreen } from '../../../features/backlogs';

export default async function BacklogPage({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<React.ReactElement> {
  const { name } = await params;
  return <BacklogScreen name={decodeURIComponent(name)} />;
}
