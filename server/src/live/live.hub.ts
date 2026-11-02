import { EventEmitter } from 'events';
import { Injectable } from '@nestjs/common';

export interface LiveLog {
  key: string;
  step: string;
  body: string;
  samples?: { at: string; cpu: number; memory: number }[];
  usage?: { tokensIn: number; tokensOut: number; usd: number };
}

export interface LiveSpend {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export interface LivePeaks {
  cpuPeak: number;
  memPeak: number;
}

export interface LiveSample {
  at: string;
  cpu: number;
  memory: number;
}

@Injectable()
export class LiveHub {
  private readonly events = new EventEmitter();
  private readonly spend = new Map<string, Map<string, LiveSpend>>();
  private readonly samples = new Map<string, Map<string, LiveSample[]>>();

  constructor() {
    this.events.setMaxListeners(20);
  }

  changed(key: string): void {
    this.events.emit('changed', key);
  }

  log(entry: LiveLog): void {
    if (entry.usage) {
      let steps = this.spend.get(entry.key);
      if (!steps) {
        steps = new Map();
        this.spend.set(entry.key, steps);
      }
      const previous = total(steps);
      steps.set(entry.step, entry.usage);
      if (!sameSpend(previous, total(steps))) {
        this.events.emit('spend', entry.key);
      }
    }
    if (entry.samples) {
      let steps = this.samples.get(entry.key);
      if (!steps) {
        steps = new Map();
        this.samples.set(entry.key, steps);
      }
      const before = peakOf(this.samples.get(entry.key));
      steps.set(entry.step, entry.samples);
      const after = peakOf(steps);
      if (after.cpuPeak > before.cpuPeak || after.memPeak > before.memPeak) {
        this.events.emit('spend', entry.key);
      }
    }
    this.events.emit('log', entry);
  }

  spendOf(key: string): LiveSpend | undefined {
    const steps = this.spend.get(key);
    if (!steps || steps.size === 0) {
      return undefined;
    }
    return total(steps);
  }

  peaksOf(key: string): LivePeaks {
    return peakOf(this.samples.get(key));
  }

  samplesOf(key: string, step: string): LiveSample[] {
    return this.samples.get(key)?.get(step) ?? [];
  }

  clearSpend(key: string): void {
    this.spend.delete(key);
    this.samples.delete(key);
  }

  dropSpend(key: string, step: string): void {
    const steps = this.spend.get(key);
    if (!steps) {
      return;
    }
    const previous = total(steps);
    steps.delete(step);
    if (steps.size === 0) {
      this.spend.delete(key);
    }
    const next = this.spendOf(key) ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
    if (!sameSpend(previous, next)) {
      this.events.emit('spend', key);
    }
  }

  onChanged(listener: (key: string) => void): () => void {
    this.events.on('changed', listener);
    return () => this.events.off('changed', listener);
  }

  onLog(listener: (entry: LiveLog) => void): () => void {
    this.events.on('log', listener);
    return () => this.events.off('log', listener);
  }

  onSpend(listener: (key: string) => void): () => void {
    this.events.on('spend', listener);
    return () => this.events.off('spend', listener);
  }
}

function total(steps: Map<string, LiveSpend>): LiveSpend {
  let tokensIn = 0;
  let tokensOut = 0;
  let usd = 0;
  for (const row of steps.values()) {
    tokensIn += row.tokensIn;
    tokensOut += row.tokensOut;
    usd += row.usd;
  }
  return { tokensIn, tokensOut, usd };
}

function sameSpend(left: LiveSpend | undefined, right: LiveSpend): boolean {
  return left !== undefined && left.tokensIn === right.tokensIn && left.tokensOut === right.tokensOut && left.usd === right.usd;
}

function peakOf(steps: Map<string, LiveSample[]> | undefined): LivePeaks {
  let cpuPeak = 0;
  let memPeak = 0;
  if (!steps) {
    return { cpuPeak, memPeak };
  }
  for (const samples of steps.values()) {
    for (const sample of samples) {
      cpuPeak = Math.max(cpuPeak, sample.cpu);
      memPeak = Math.max(memPeak, sample.memory);
    }
  }
  return { cpuPeak, memPeak };
}
