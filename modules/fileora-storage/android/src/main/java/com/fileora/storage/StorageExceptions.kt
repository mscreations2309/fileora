package com.fileora.storage

import expo.modules.kotlin.exception.CodedException

/**
 * Error codes are part of the JS contract (see src/core/errors/FileoraError.ts).
 * Messages must never contain file contents; paths are allowed because they are
 * shown to the user who owns them, but JS redacts them before logging.
 */
internal class AccessDeniedException(detail: String, cause: Throwable? = null) :
  CodedException("ERR_ACCESS_DENIED", "Access denied: $detail", cause)

internal class NotFoundException(detail: String) :
  CodedException("ERR_NOT_FOUND", "Not found: $detail", null)

internal class AlreadyExistsException(detail: String) :
  CodedException("ERR_ALREADY_EXISTS", "Already exists: $detail", null)

internal class NoSpaceException(required: Long, available: Long) :
  CodedException("ERR_NO_SPACE", "Insufficient storage: required $required bytes, available $available bytes", null)

internal class ReadOnlyException(detail: String) :
  CodedException("ERR_READ_ONLY", "Destination is read-only: $detail", null)

internal class CancelledException :
  CodedException("ERR_CANCELLED", "Operation cancelled", null)

internal class UnsupportedException(detail: String) :
  CodedException("ERR_UNSUPPORTED", "Unsupported: $detail", null)

internal class InvalidNameException(detail: String) :
  CodedException("ERR_INVALID_NAME", "Invalid name: $detail", null)

internal class IoFailureException(detail: String, cause: Throwable? = null) :
  CodedException("ERR_IO", "I/O failure: $detail", cause)

internal class NoHandlerException(detail: String) :
  CodedException("ERR_NO_HANDLER", "No app can open $detail", null)
