/**
 * Custom error classes for different types of errors in the NBA PrizePicks analyzer
 */

export class AnalysisError extends Error {
  constructor(message, code, status = 500, retryable = false) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class ConfigurationError extends AnalysisError {
  constructor(message) {
    super(message, 'CONFIGURATION_ERROR', 500, false);
    this.name = 'ConfigurationError';
  }
}

export class ValidationError extends AnalysisError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR', 400, false);
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends AnalysisError {
  constructor(message, retryAfterMs) {
    super(message, 'RATE_LIMIT_ERROR', 429, true);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ExternalAPIError extends AnalysisError {
  constructor(message, apiName, retryable = true) {
    super(message, `EXTERNAL_API_ERROR_${apiName.toUpperCase()}`, 502, retryable);
    this.name = 'ExternalAPIError';
    this.apiName = apiName;
  }
}

export class LLMError extends AnalysisError {
  constructor(message, retryable = false) {
    super(message, 'LLM_ERROR', 500, retryable);
    this.name = 'LLMError';
  }
}

export class DataNotFoundError extends AnalysisError {
  constructor(message) {
    super(message, 'DATA_NOT_FOUND_ERROR', 404, false);
    this.name = 'DataNotFoundError';
  }
}

// Helper function to create standardized error responses
export function createErrorResponse(error) {
  // Don't expose internal error details in production
  const message = process.env.NODE_ENV === 'development' 
    ? error.message 
    : 'An internal error occurred';
  
  const responseBody = {
    error: message
  };
  
  // Add retry-after header for rate limit errors
  const headers = {};
  if (error instanceof RateLimitError) {
    headers['Retry-After'] = String(Math.ceil(error.retryAfterMs / 1000));
  }
  
  return Response.json(responseBody, {
    status: error.status,
    headers
  });
}

// Helper function to determine if an error is retryable based on HTTP status or error code
export function isRetryableError(error) {
  // Network errors are generally retryable
  if (error instanceof TypeError && 
      (error.message.includes('fetch') || error.message.includes('network'))) {
    return true;
  }
  
  // Check if the error object has retryable property
  if (error.retryable !== undefined) {
    return error.retryable;
  }
  
  // Default to not retryable for safety
  return false;
}

// Helper function to sleep for retry delays
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Exponential backoff delay calculation
export function calculateBackoffDelay(attempt, baseDelay = 1000, maxDelay = 10000) {
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}