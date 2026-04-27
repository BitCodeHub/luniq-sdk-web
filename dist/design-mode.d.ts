type CommandHandler = (kind: string, payload: any) => void;
export declare class DesignMode {
    private ws;
    private endpoint;
    private apiKey;
    private code;
    private connected;
    private overlayEl;
    private screen;
    private onCommand;
    configure(endpoint: string, apiKey: string): void;
    /** Sets the host SDK callback that receives preview commands. */
    setCommandHandler(fn: CommandHandler): void;
    /** Auto-pair if URL contains ?luniq_design=CODE. */
    maybeAutoPair(): void;
    pair(code: string): void;
    reportScreen(name: string): void;
    disconnect(): void;
    private send;
    private handle;
    private dispatch;
    private startScreenObserver;
    private installOverlay;
    private setStatus;
    private removeOverlay;
}
export declare const _designMode: DesignMode;
export {};
