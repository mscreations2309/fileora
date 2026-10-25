/**
 * Every failure surfaced to the user is a FileoraError with a stable code. Codes from the
 * Android native module (modules/fileora-storage) map 1:1; errors from expo-file-system and
 * other libraries are classified by `toFileoraError`.
 */
export type ErrorCode =
  | 'ERR_ACCESS_DENIED'
  | 'ERR_NOT_FOUND'
  | 'ERR_ALREADY_EXISTS'
  | 'ERR_NO_SPACE'
  | 'ERR_READ_ONLY'
  | 'ERR_CANCELLED'
  | 'ERR_UNSUPPORTED'
  | 'ERR_INVALID_NAME'
  | 'ERR_IO'
  | 'ERR_VERIFICATION_FAILED'
  | 'ERR_DATABASE_MIGRATION'
  | 'ERR_NO_HANDLER'
  | 'ERR_INTERNAL';

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'ERR_ACCESS_DENIED',
  'ERR_NOT_FOUND',
  'ERR_ALREADY_EXISTS',
  'ERR_NO_SPACE',
  'ERR_READ_ONLY',
  'ERR_CANCELLED',
  'ERR_UNSUPPORTED',
  'ERR_INVALID_NAME',
  'ERR_IO',
  'ERR_VERIFICATION_FAILED',
  'ERR_DATABASE_MIGRATION',
  'ERR_NO_HANDLER',
  'ERR_INTERNAL',
]);

export class FileoraError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'FileoraError';
    this.code = code;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

type ErrorPresentation = { title: string; guidance: string; retryable: boolean };

const PRESENTATION: Record<ErrorCode, ErrorPresentation> = {
  ERR_ACCESS_DENIED: {
    title: 'Fileora no longer has access',
    guidance: 'The permission for this location was denied or revoked. Grant access again from Storage access.',
    retryable: false,
  },
  ERR_NOT_FOUND: {
    title: 'Item not found',
    guidance: 'It may have been moved or deleted by another app, or its storage was disconnected.',
    retryable: false,
  },
  ERR_ALREADY_EXISTS: {
    title: 'An item with this name already exists',
    guidance: 'Choose a different name, keep both, or replace the existing item.',
    retryable: false,
  },
  ERR_NO_SPACE: {
    title: 'Not enough storage',
    guidance: 'Free up space on the destination and try again. Nothing was overwritten.',
    retryable: true,
  },
  ERR_READ_ONLY: {
    title: 'Destination is read-only',
    guidance: 'This location does not allow changes. Choose another destination.',
    retryable: false,
  },
  ERR_CANCELLED: {
    title: 'Cancelled',
    guidance: 'The operation was stopped. Items finished before cancelling were kept.',
    retryable: true,
  },
  ERR_UNSUPPORTED: {
    title: 'Not supported here',
    guidance: 'This location or file type does not support that action.',
    retryable: false,
  },
  ERR_INVALID_NAME: {
    title: 'Invalid name',
    guidance: 'Names cannot be empty, contain "/", or be longer than 255 bytes.',
    retryable: false,
  },
  ERR_IO: {
    title: 'The storage reported an error',
    guidance: 'The file may be locked or the storage temporarily unavailable. Try again.',
    retryable: true,
  },
  ERR_VERIFICATION_FAILED: {
    title: 'Verification failed',
    guidance: 'The copied data did not match the original, so the original was kept untouched.',
    retryable: true,
  },
  ERR_DATABASE_MIGRATION: {
    title: 'Fileora could not open its library',
    guidance: 'Your files are not affected. Update the app, or reset Fileora data from Settings.',
    retryable: false,
  },
  ERR_NO_HANDLER: {
    title: 'No app can open this file',
    guidance: 'Install an app that supports this file type, or share it to another app.',
    retryable: false,
  },
  ERR_INTERNAL: {
    title: 'Something went wrong',
    guidance: 'Please try again. If it keeps happening, restart Fileora.',
    retryable: true,
  },
};

export function presentError(error: FileoraError): ErrorPresentation {
  return PRESENTATION[error.code];
}

/** Classifies any thrown value. Native module errors carry a `code`; others are matched by message. */
export function toFileoraError(error: unknown): FileoraError {
  if (error instanceof FileoraError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && KNOWN_CODES.has(code)) {
    return new FileoraError(code as ErrorCode, message, { cause: error });
  }
  const lower = message.toLowerCase();
  const classified: ErrorCode =
    lower.includes('permission') || lower.includes('denied') || lower.includes('not authorized')
      ? 'ERR_ACCESS_DENIED'
      : lower.includes('no space') || lower.includes('enospc')
        ? 'ERR_NO_SPACE'
        : lower.includes('already exists')
          ? 'ERR_ALREADY_EXISTS'
          : lower.includes('does not exist') || lower.includes('not found') || lower.includes('no such file')
            ? 'ERR_NOT_FOUND'
            : lower.includes('read-only') || lower.includes('erofs')
              ? 'ERR_READ_ONLY'
              : 'ERR_INTERNAL';
  return new FileoraError(classified, message, { cause: error });
}

export function isCancellation(error: unknown): boolean {
  return toFileoraError(error).code === 'ERR_CANCELLED';
}
