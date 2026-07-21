export type AnalysisType = Readonly<{
  value: string;
  label: string;
  desc: string;
}>;

export const ANALYSIS_TYPES: ReadonlyArray<AnalysisType>;
export function analysisTypeDescription(value: unknown): string;
