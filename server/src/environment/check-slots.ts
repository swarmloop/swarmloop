interface Waiting {
  key: string;
  onAhead: (ahead: number) => void;
  resolve: (release: (() => void) | null) => void;
  told: number;
}

/** One first-come-first-served line of places for the check commands of the whole server. */
export class CheckSlots {
  private taken = 0;
  private line: Waiting[] = [];

  constructor(
    private readonly limit: () => number,
    private readonly halted: (key: string) => boolean = () => false,
  ) {}

  /**
   * Waits for a place. `onAhead` gets the number of commands before this one in the line, each time it changes.
   * Resolves with the function that gives the place back, or with null when the run is halted or `drop` took the command out of the line.
   */
  take(key: string, onAhead: (ahead: number) => void): Promise<(() => void) | null> {
    if (this.halted(key)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.line.push({ key, onAhead, resolve, told: -1 });
      this.advance();
    });
  }

  /** Takes every waiting command of a run out of the line. Places already given stay with their commands. */
  drop(key: string): void {
    const dropped = this.line.filter((waiting) => waiting.key === key);
    this.line = this.line.filter((waiting) => waiting.key !== key);
    for (const waiting of dropped) {
      waiting.resolve(null);
    }
    this.tell();
  }

  private advance(): void {
    for (let next = this.line[0]; next && this.taken < this.limit(); next = this.line[0]) {
      this.line.shift();
      this.taken += 1;
      next.resolve(this.releaser());
    }
    this.tell();
  }

  private releaser(): () => void {
    let given = false;
    return () => {
      if (!given) {
        given = true;
        this.taken -= 1;
        this.advance();
      }
    };
  }

  private tell(): void {
    this.line.forEach((waiting, ahead) => {
      if (waiting.told !== ahead) {
        waiting.told = ahead;
        waiting.onAhead(ahead);
      }
    });
  }
}
