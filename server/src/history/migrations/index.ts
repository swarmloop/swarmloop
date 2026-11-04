import { InitialSchema1793664000000 } from './1793664000000-initial-schema';
import { RetireVerifyStep1793800000000 } from './1793800000000-retire-verify-step';

// To add a migration: run `npm run migration:generate -- src/history/migrations/<name>`, export the generated class
// from its own file, and append it here. Migrations run in list order at startup.
export const migrations = [InitialSchema1793664000000, RetireVerifyStep1793800000000];
