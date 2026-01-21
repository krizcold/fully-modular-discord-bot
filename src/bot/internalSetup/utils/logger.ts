export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  constructor(private readonly prefix: string) {}

  private shouldLog(level: LogLevel): boolean {
    const minLevel = process.env.NODE_ENV === 'production'
      ? LogLevel.WARN
      : LogLevel.DEBUG;
    return level >= minLevel;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(`[${this.prefix}] ${message}`, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(`[${this.prefix}] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(`[${this.prefix}] ${message}`, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(`[${this.prefix}] ${message}`, ...args);
    }
  }
}

export function createLogger(moduleName: string): Logger {
  return new Logger(moduleName);
}
