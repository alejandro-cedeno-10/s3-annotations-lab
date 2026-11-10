export type FieldMap = Record<string, string>;

export interface RoundOutcome {
  round: number;
  lostFields: string[];
  finalDocuments: Record<string, FieldMap>;
}

export interface VariantTotals {
  rounds: number;
  roundsWithLoss: number;
  lostFields: number;
  lostPerRound: number[];
}

/**
 * Fields a writer believed it stored but that are absent or different in the final document.
 */
export function findLostFields(expected: FieldMap, finalDocument: FieldMap): string[] {
  return Object.entries(expected)
    .filter(([field, value]) => finalDocument[field] !== value)
    .map(([field]) => field);
}

export function summarizeRounds(outcomes: readonly RoundOutcome[]): VariantTotals {
  const lostPerRound = outcomes.map((outcome) => outcome.lostFields.length);
  return {
    rounds: outcomes.length,
    roundsWithLoss: lostPerRound.filter((lost) => lost > 0).length,
    lostFields: lostPerRound.reduce((sum, lost) => sum + lost, 0),
    lostPerRound,
  };
}

export function jitterMs(maxMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * (maxMs + 1));
}

export interface WriterTiming {
  writer: string;
  startMs: number;
  readEndMs: number;
  writeEndMs: number;
}

/**
 * True when each writer finished its read before the other finished its write, the necessary
 * condition for one of the two updates to be overwritten.
 */
export function readsInterleaved(first: WriterTiming, second: WriterTiming): boolean {
  return first.readEndMs < second.writeEndMs && second.readEndMs < first.writeEndMs;
}
