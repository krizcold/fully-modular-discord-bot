/**
 * JSON Utilities - Core validation and sanitization
 */

// Forbidden keys that could enable prototype pollution attacks
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

// Defaults
const DEFAULT_MAX_DEPTH = 50;
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Result of JSON validation
 */
export type JsonValidationResult<T = any> =
  | { valid: true; data: T }
  | { valid: false; error: string };

/**
 * Options for JSON validation
 */
export interface JsonValidationOptions {
  /** Allow primitive values (default: false - only objects/arrays) */
  allowPrimitives?: boolean;
  /** Maximum nesting depth (default: 50) */
  maxDepth?: number;
  /** Maximum string length in bytes (default: 10MB) */
  maxSize?: number;
  /** Required type: 'object', 'array', or 'any' (default: 'any') */
  requiredType?: 'object' | 'array' | 'any';
}

/**
 * Check if data contains forbidden keys (prototype pollution)
 * Recursively checks all nested objects
 */
function containsForbiddenKeys(obj: any, depth: number = 0, maxDepth: number = DEFAULT_MAX_DEPTH): boolean {
  if (depth > maxDepth) return false;
  if (obj === null || typeof obj !== 'object') return false;

  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.includes(key)) return true;
    if (containsForbiddenKeys(obj[key], depth + 1, maxDepth)) return true;
  }
  return false;
}

/**
 * Check maximum nesting depth of JSON structure
 */
function getMaxDepth(obj: any, currentDepth: number = 0): number {
  if (obj === null || typeof obj !== 'object') return currentDepth;

  let maxDepth = currentDepth;
  const values = Array.isArray(obj) ? obj : Object.values(obj);

  for (const value of values) {
    const depth = getMaxDepth(value, currentDepth + 1);
    if (depth > maxDepth) maxDepth = depth;
  }

  return maxDepth;
}

/**
 * Validate and sanitize JSON string
 * Checks for: empty input, syntax errors, prototype pollution, type requirements, depth/size limits
 */
export function validateAndSanitizeJson<T = any>(
  jsonString: string,
  options: JsonValidationOptions = {}
): JsonValidationResult<T> {
  const {
    allowPrimitives = false,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxSize = DEFAULT_MAX_SIZE,
    requiredType = 'any',
  } = options;

  // Check size limit before parsing
  if (jsonString.length > maxSize) {
    return { valid: false, error: `JSON exceeds maximum size (${Math.round(maxSize / 1024)}KB limit)` };
  }

  // Trim whitespace
  const trimmed = jsonString.trim();

  if (!trimmed) {
    return { valid: false, error: 'JSON cannot be empty' };
  }

  // Parse JSON
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Parse error';
    return { valid: false, error: `Invalid JSON syntax: ${message}` };
  }

  // Type validation
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  const isArray = Array.isArray(parsed);

  if (!allowPrimitives && !isObject && !isArray) {
    return { valid: false, error: 'Data must be a JSON object or array, not a primitive value' };
  }

  if (requiredType === 'object' && !isObject) {
    return { valid: false, error: 'Data must be a JSON object' };
  }

  if (requiredType === 'array' && !isArray) {
    return { valid: false, error: 'Data must be a JSON array' };
  }

  // Depth check
  if (isObject || isArray) {
    const depth = getMaxDepth(parsed);
    if (depth > maxDepth) {
      return { valid: false, error: `JSON exceeds maximum nesting depth (${maxDepth} levels)` };
    }
  }

  // Prototype pollution check
  if ((isObject || isArray) && containsForbiddenKeys(parsed, 0, maxDepth)) {
    return { valid: false, error: 'Data contains forbidden property names (__proto__, constructor, prototype)' };
  }

  // Re-serialize and parse to sanitize (removes non-JSON properties, functions, etc.)
  const sanitized = JSON.parse(JSON.stringify(parsed));

  return { valid: true, data: sanitized as T };
}

/**
 * Parse JSON with enhanced error context
 */
export function parseJsonSafe<T = any>(
  jsonString: string
): { data: T; error: null } | { data: null; error: string } {
  try {
    const data = JSON.parse(jsonString);
    return { data: data as T, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Parse error';
    return { data: null, error: message };
  }
}

/**
 * Check if data is empty (null, undefined, empty object/array)
 */
export function isDataEmpty(data: any): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data) && data.length === 0) return true;
  if (typeof data === 'object' && Object.keys(data).length === 0) return true;
  return false;
}

/**
 * Get count of items (array length or object keys)
 */
export function getDataItemCount(data: any): number {
  if (Array.isArray(data)) return data.length;
  if (typeof data === 'object' && data !== null) return Object.keys(data).length;
  return 0;
}

/**
 * Get human-readable type info
 */
export function getDataTypeInfo(data: any): string {
  if (Array.isArray(data)) return `Array (${data.length} items)`;
  if (typeof data === 'object' && data !== null) return `Object (${Object.keys(data).length} properties)`;
  if (data === null) return 'null';
  return typeof data;
}

/**
 * Check if parsed data is safe from prototype pollution
 */
export function isPrototypeSafe(data: any): boolean {
  return !containsForbiddenKeys(data);
}

/**
 * Deep sanitize JSON by re-serializing
 * Removes non-JSON properties, functions, undefined values, etc.
 */
export function sanitizeJson<T = any>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

/**
 * Calculate serialized JSON size in bytes
 */
export function getJsonSize(data: any): number {
  return JSON.stringify(data).length;
}
