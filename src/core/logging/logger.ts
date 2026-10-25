/**
 * Privacy-safe logger. File names and paths are user data, so anything that looks like a URI or
 * absolute path is redacted before reaching the console (and any future crash reporter).
 * Never pass file contents, keys, or passwords to the logger.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const URI_PATTERN = /\b(?:file|content):\/\/[^\s"')]+/gi;
const PATH_PATTERN = /(?:\/(?:storage|sdcard|data|var|private|Users)\/)[^\s"')]+/g;

export function redact(text: string): string {
  return text.replace(URI_PATTERN, '<uri>').replace(PATH_PATTERN, '<path>');
}

function describe(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) {
    const code = (detail as { code?: unknown }).code;
    return ` ${typeof code === 'string' ? `[${code}] ` : ''}${redact(detail.message)}`;
  }
  return ` ${redact(typeof detail === 'string' ? detail : JSON.stringify(detail) ?? '')}`;
}

function write(level: Level, scope: string, message: string, detail?: unknown): void {
  if (level === 'debug' && !__DEV__) return;
  const line = `[fileora:${scope}] ${redact(message)}${describe(detail)}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const logger = {
  debug: (scope: string, message: string, detail?: unknown) => write('debug', scope, message, detail),
  info: (scope: string, message: string, detail?: unknown) => write('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: unknown) => write('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: unknown) => write('error', scope, message, detail),
};
