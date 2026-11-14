// A spec must not depend on the free space of the machine it runs on: the observation is fixed at the filesystem
// boundary, and the shipped MIN_FREE_GB stays in force. Specs of the disk guard supply their own readings.
const AMPLE_FREE_BYTES = 100 * 1024 ** 3;

jest.mock('./src/core/free-bytes', () => ({
  ...jest.requireActual('./src/core/free-bytes'),
  freeBytes: async () => AMPLE_FREE_BYTES,
}));
