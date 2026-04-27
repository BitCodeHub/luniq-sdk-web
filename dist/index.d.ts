type Props = Record<string, any>;
interface Config {
    apiKey: string;
    endpoint: string;
    environment?: string;
    autoCapture?: boolean;
    batchSize?: number;
    flushIntervalMs?: number;
}
declare class LuniqClient {
    private cfg;
    private queue;
    private visitorId;
    private accountId;
    private traits;
    private sessionId;
    private lastActivity;
    private sessionTimeoutMs;
    private flushTimer;
    start(cfg: Config): void;
    /** Manually enter design mode with a 6-char pairing code from the dashboard. */
    enableDesignMode(code: string): void;
    identify(visitorId: string, accountId?: string, traits?: Props): void;
    track(name: string, properties?: Props): void;
    screen(name: string, properties?: Props): void;
    optOut(on: boolean): void;
    submitFeedback(kind: "idea" | "bug" | "kudos" | "other", message: string): Promise<void>;
    private enrich;
    private persist;
    flush(sync?: boolean): Promise<void>;
    private installAutoCapture;
}
export declare const Luniq: LuniqClient;
export {};
