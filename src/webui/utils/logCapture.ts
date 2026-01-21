const MAX_LOGS = 5000;
const webuiLogs: string[] = [];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function formatLogEntry(level: string, args: any[]): string {
  const timestamp = new Date().toISOString();
  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  return `[${timestamp}] [${level}] ${message}`;
}

function addLog(entry: string): void {
  webuiLogs.push(entry);
  if (webuiLogs.length > MAX_LOGS) {
    webuiLogs.shift();
  }
}

export function initLogCapture(): void {
  console.log = (...args: any[]) => {
    const entry = formatLogEntry('INFO', args);
    addLog(entry);
    originalConsoleLog.apply(console, args);
  };

  console.error = (...args: any[]) => {
    const entry = formatLogEntry('ERROR', args);
    addLog(entry);
    originalConsoleError.apply(console, args);
  };

  console.warn = (...args: any[]) => {
    const entry = formatLogEntry('WARN', args);
    addLog(entry);
    originalConsoleWarn.apply(console, args);
  };
}

export function getWebuiLogs(limit?: number): string[] {
  if (limit && limit > 0) {
    return webuiLogs.slice(-limit);
  }
  return [...webuiLogs];
}

export function clearWebuiLogs(): void {
  webuiLogs.length = 0;
}
