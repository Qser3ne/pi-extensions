export interface TokenUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
}
export interface TimeRange { start: number; end: number; amount: number; unit: 'h' | 'd' }
export interface UsageRecord {
  key: string; timestamp: number; usage: TokenUsage; source: string; kind: string;
  provider?: string; model?: string; toolName?: string; childRefs?: string[]; summaryKey?: string; inherited?: boolean;
}
export interface ScanResult { records: UsageRecord[]; warnings: string[] }
export interface ModelIdentity { provider: string; id: string }
export interface ModelUsage { provider?: string; model?: string; usage: TokenUsage; recordCount: number }
export interface UsageReport {
  scope?: 'current-models';
  range: TimeRange; usage: TokenUsage; models: ModelUsage[]; warnings: string[]; recordCount: number;
}
