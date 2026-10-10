export const PRODUCTION_SECRET_PROVIDERS: readonly string[];
export function assertNoProductionEnvFiles(directory: string): void;
export function parseProductionSecret(raw: string): Record<string, string>;
export function readSecretFile(source: string, appDirectory: string): string;
export function productionEnvironment(directory: string, base: Record<string, string | undefined>, raw: string, provider?: string): Record<string, string | undefined>;
export function productionCommand(mode: string, extra?: string[]): string[];
