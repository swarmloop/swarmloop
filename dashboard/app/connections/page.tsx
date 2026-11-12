import { ConnectionsPage } from '../../features/connections';
import { LoginProblemAlert } from '../login/login-problem-alert';

export default function Page(): React.ReactElement {
  return (
    <>
      <LoginProblemAlert />
      <ConnectionsPage />
    </>
  );
}
