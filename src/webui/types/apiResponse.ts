// Standard API response format for all Web-UI routes

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp?: string;
}

/**
 * Helper to create a success response
 */
export function createSuccessResponse<T>(data?: T): APIResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString()
  };
}

/**
 * Helper to create an error response
 */
export function createErrorResponse(error: string): APIResponse {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString()
  };
}
