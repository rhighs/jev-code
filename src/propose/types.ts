export interface Candidate {
  label: string;
  text: string;
  valid: boolean;
  reason?: string;
  bytes: number;
}

export type CandidateSummary = Omit<Candidate, 'text'>;
