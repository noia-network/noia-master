import path from "path";
import Vorpal from "vorpal";
const vorpal = new Vorpal();

// const DEBUG_LEVEL: undefined | string | number = process.env.DEBUG_LEVEL;

export enum LogLevel {
    /**
     * None.
     */
    None = 0,
    /**
     * Error logs.
     */
    Error = 1,
    /**
     * Warning logs.
     */
    Warning = 2,
    /**
     * Info logs.
     */
    Info = 4,
    /**
     * Configuration log.
     */
    Config = 8,
    /**
     * Blockchain log.
     */
    Debug = 16,
    /**
     * Blockchain log.
     */
    Blockchain = 32,
    /**
     * Verbose logs.
     */
    Verbose = 64,
    /**
     * Caching logs.
     */
    Caching = 128,
    /**
     * Default log leve (191).
     */
    Default = 128 + 32 + 16 + 8 + 4 + 2 + 1,
    /**
     * All available log (255).
     */
    All = 128 + 64 + 32 + 16 + 8 + 4 + 2 + 1
}

class Logger {
    constructor() {
        this._styles = {
            Reset: "\x1b[0m",
            Bright: "\x1b[1m",
            Underscore: "\x1b[4m",
            Blink: "\x1b[5m",
            Reverse: "\x1b[7m",
            Hidden: "\x1b[8m",

            FgBlack: "\x1b[30m",
            FgRed: "\x1b[31m",
            FgGreen: "\x1b[32m",
            FgYellow: "\x1b[33m",
            FgBlue: "\x1b[34m",
            FgMagenta: "\x1b[35m",
            FgCyan: "\x1b[36m",
            FgWhite: "\x1b[37m",

            BgBlack: "\x1b[40m",
            BgRed: "\x1b[41m",
            BgGreen: "\x1b[42m",
            BgYellow: "\x1b[43m",
            BgBlue: "\x1b[44m",
            BgMagenta: "\x1b[45m",
            BgCyan: "\x1b[46m",
            BgWhite: "\x1b[47m"
        };

        if (require == null || require.main == null) {
            return;
        }

        this.absStartPath = path.resolve(path.dirname(require.main.filename));
    }

    public absStartPath?: string;
    public _styles: { [key: string]: string };
    public vorpal: Vorpal = vorpal;
    public logLevel: LogLevel = LogLevel.Default;

    private prefixTime(): string {
        const date = new Date();
        const prefix = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}.${
            date.getMilliseconds() < 100 ? date.getMilliseconds() + " " : date.getMilliseconds()
        }`;
        const msg = `[${prefix}]`;
        return msg;
    }

    private prefixType(type: string, callerFile = ""): string {
        switch (type) {
            case "error":
                return `FgWhite[FgRedERRORFgWhite]ResetFgRed[FgWhite${callerFile}FgRed]Reset`;
            case "warn":
                return `FgWhite[FgYellowWARNFgWhite]FgYellow[FgWhite${callerFile}FgYellow]Reset`;
            case "info":
                return `FgWhite[FgGreenINFOFgWhite]FgGreen[FgWhite${callerFile}FgGreen]Reset`;
            case "config":
                return `FgWhite[FgGreenCNFGFgWhite]FgGreen[FgWhite${callerFile}FgGreen]Reset`;
            case "blockchain":
                return `FgWhite[FgGreenBCHNFgWhite]FgGreen[FgWhite${callerFile}FgGreen]Reset`;
            case "verbose":
                return `FgWhite[FgMagentaVRBSFgWhite]FgMagenta[FgWhite${callerFile}FgMagenta]Reset`;
            case "caching":
                return `FgWhite[FgBlueCHNGFgWhite]FgBlue[FgWhite${callerFile}FgBlue]Reset`;
            case "debug":
                return `FgWhite[FgCyanDEBUGFgWhite]FgCyan[FgWhite${callerFile}FgCyan]Reset`;
            case "table":
                return "FgWhite[FgBlueTABLEFgWhite]Reset";
            default:
                throw new Error(`Logger prefixType [${type}]`);
        }
    }

    private colorizeText(text: string): string {
        Object.keys(this._styles).forEach(key => {
            const regexp = new RegExp("\\" + key, "g");
            text = text.replace(regexp, this._styles[key]);
        });
        return text;
    }

    private getCallerFile(): string {
        const originalFunc = Error.prepareStackTrace;
        let callerfile;
        try {
            Error.prepareStackTrace = (_, stack) => stack;
            const err = new Error();
            // @ts-ignore
            const currentfile = err.stack.shift().getFileName();
            // @ts-ignore
            while (err.stack.length) {
                // @ts-ignore
                callerfile = err.stack.shift().getFileName();

                if (currentfile !== callerfile) {
                    break;
                }
            }
        } catch (e) {
            // TODO
        }

        Error.prepareStackTrace = originalFunc;
        return callerfile.replace(this.absStartPath, "");
    }

    public setLogLevel(logLevel: LogLevel): void {
        this.logLevel = logLevel;
    }

    // tslint:disable-next-line
    public error(...args: any[]): void {
        if (this.logLevel & LogLevel.Error) {
            const text = `${this.prefixTime()}${this.prefixType("error", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public warn(...args: any[]): void {
        if (this.logLevel & LogLevel.Warning) {
            const text = `${this.prefixTime()}${this.prefixType("warn", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public info(...args: any[]): void {
        if (this.logLevel & LogLevel.Info) {
            const text = `${this.prefixTime()}${this.prefixType("info", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public config(...args: any[]): void {
        if (this.logLevel & LogLevel.Config) {
            const text = `${this.prefixTime()}${this.prefixType("config", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public blockchain(...args: any[]): void {
        if (this.logLevel & LogLevel.Blockchain) {
            const text = `${this.prefixTime()}${this.prefixType("blockchain", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public debug(...args: any[]): void {
        if (this.logLevel & LogLevel.Debug) {
            const text = `${this.prefixTime()}${this.prefixType("debug", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public verbose(...args: any[]): void {
        if (this.logLevel & LogLevel.Verbose) {
            const text = `${this.prefixTime()}${this.prefixType("verbose", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public caching(...args: any[]): void {
        if (this.logLevel & LogLevel.Caching) {
            const text = `${this.prefixTime()}${this.prefixType("caching", this.getCallerFile())} ${args[0]}`;
            args[0] = this.colorizeText(text);

            // @ts-ignore
            vorpal.log.apply(vorpal, args);
        }
    }

    // tslint:disable-next-line
    public table(...args: any[]): void {
        if (this.logLevel & LogLevel.Info) {
            const text = `${this.prefixTime()}${this.prefixType("table")} ${args[0]}:`;
            const prefix = this.colorizeText(text);
            vorpal.log(prefix);
            args.shift();
            // @ts-ignore
            console.table.apply(null, args);
        }
    }
}

export let logger = new Logger();
