/** Makes the waits of the host retry policy return at once; undo with `jest.restoreAllMocks()`. */
export function instantBackoff(): void {
  jest.spyOn(global, 'setTimeout').mockImplementation(((run: () => void) => {
    run();
    return 0;
  }) as unknown as typeof setTimeout);
}
