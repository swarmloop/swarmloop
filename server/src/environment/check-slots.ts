interface Waiting {
  key: string;
  onAhead: (ahead: number) => void;
  resolve: (taken: TakenPlace | null) => void;
  told: number;
}

/** A place given to a command: its number, and the function that gives it back. */
interface TakenPlace {
  place: number;
  release: () => void;
}

/**
 * One first-come-first-served line of places for the check commands of the whole server. The places are numbered
 * from 0, and a number that is given back is given again.
 */
export class CheckSlots {
  private readonly held = new Set<number>();
  private line: Waiting[] = [];

  constructor(
    private readonly limit: () => number,
    private readonly halted: (key: string) => boolean = () => false,
  ) {}

  /**
   * Waits for a place. `onAhead` gets the number of commands before this one in the line, each time it changes.
   * Resolves with the place and the function that gives it back, or with null when the run is halted or `drop` took the command out of the line.
   */
  take(key: string, onAhead: (ahead: number) => void): Promise<TakenPlace | null> {
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
    for (let next = this.line[0]; next && this.held.size < this.limit(); next = this.line[0]) {
      this.line.shift();
      const place = this.lowestFree();
      this.held.add(place);
      next.resolve({ place, release: this.releaser(place) });
    }
    this.tell();
  }

  private lowestFree(): number {
    let place = 0;
    while (this.held.has(place)) {
      place += 1;
    }
    return place;
  }

  private releaser(place: number): () => void {
    let given = false;
    return () => {
      if (!given) {
        given = true;
        this.held.delete(place);
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
