import { isIP } from 'net';

/**
 * Security utilities for captive portal URL handling
 * Implements best practices from RFC 8908, WISPr, and OWASP guidelines
 */

// Maximum URL length (RFC 7230 recommends 8000, but we use conservative limit)
const MAX_URL_LENGTH = 2048;

// Default safe redirect URL
const DEFAULT_REDIRECT_URL = process.env.DEFAULT_REDIRECT_URL || 'http://www.google.com';

// Allowed redirect domains (comma-separated in env, or empty for all HTTP/HTTPS)
const ALLOWED_REDIRECT_DOMAINS = (process.env.ALLOWED_REDIRECT_DOMAINS || '')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

/**
 * Validates and sanitizes user-provided redirect URLs
 * Prevents open redirect vulnerabilities (OWASP A03:2021)
 * 
 * @param userurl - User-provided URL from query/form
 * @param defaultUrl - Fallback URL if validation fails
 * @returns Sanitized URL safe for redirect
 */
export function validateAndSanitizeUserUrl(
  userurl: string | undefined | null,
  defaultUrl: string = DEFAULT_REDIRECT_URL
): string {
  // Return default if no URL provided
  if (!userurl || typeof userurl !== 'string') {
    return defaultUrl;
  }

  // Length check - prevent DoS via extremely long URLs
  if (userurl.length > MAX_URL_LENGTH) {
    return defaultUrl;
  }

  try {
    // Parse URL - throws if invalid
    const url = new URL(userurl);

    // CRITICAL: Only allow HTTP/HTTPS protocols
    // Prevents javascript:, data:, file:, etc. attacks
    if (!['http:', 'https:'].includes(url.protocol)) {
      return defaultUrl;
    }

    // Optional: Domain whitelist (if configured)
    if (ALLOWED_REDIRECT_DOMAINS.length > 0) {
      const hostname = url.hostname.toLowerCase();
      const isAllowed = ALLOWED_REDIRECT_DOMAINS.some(domain => {
        // Support exact match or subdomain match
        return hostname === domain || hostname.endsWith('.' + domain);
      });

      if (!isAllowed) {
        return defaultUrl;
      }
    }

    // Remove dangerous query parameters that could be used for XSS
    const dangerousParams = [
      'javascript',
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onfocus',
      'onblur'
    ];
    dangerousParams.forEach(param => {
      url.searchParams.delete(param);
    });

    // Reconstruct URL with sanitized query params
    return url.toString();
  } catch (error) {
    // Invalid URL format - return default
    return defaultUrl;
  }
}

/**
 * Validates router IP address
 * Prevents IP spoofing and ensures IP is in expected range
 * 
 * @param uamip - Router IP address from request
 * @param nasid - Optional router ID for verification
 * @returns true if IP is valid
 */
export function validateRouterIp(uamip: string | undefined | null): boolean {
  if (!uamip || typeof uamip !== 'string') {
    return false;
  }

  // Validate IP format (IPv4 or IPv6)
  if (!isIP(uamip)) {
    return false;
  }

  // For captive portals, router IPs should typically be private/internal
  // This prevents external IP spoofing
  const parts = uamip.split('.');
  
  // Check for private IPv4 ranges:
  // - 10.0.0.0/8
  // - 172.16.0.0/12
  // - 192.168.0.0/16
  // - 169.254.0.0/16 (link-local)
  if (parts.length === 4) {
    const [a, b] = parts.map(p => parseInt(p, 10));
    
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    
    return isPrivate;
  }

  // IPv6: Allow link-local (fe80::/10) and private ranges
  if (uamip.startsWith('fe80:') || uamip.startsWith('fc00:') || uamip.startsWith('fd00:')) {
    return true;
  }

  // If env var allows public IPs (for testing), allow all valid IPs
  if (process.env.ALLOW_PUBLIC_ROUTER_IPS === 'true') {
    return true;
  }

  return false;
}

/**
 * Validates router port number
 * 
 * @param port - Port number as string
 * @returns Valid port number or default
 */
export function validateRouterPort(port: string | undefined | null, defaultPort: string = '3990'): string {
  if (!port) {
    return defaultPort;
  }

  const portNum = parseInt(port, 10);
  
  // Valid port range: 1-65535
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return defaultPort;
  }

  return port;
}

/**
 * Escapes HTML to prevent XSS attacks
 * OWASP XSS Prevention Cheat Sheet
 * 
 * @param text - Text that may contain HTML
 * @returns HTML-escaped text
 */
export function escapeHtml(text: string | undefined | null): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '/': '&#x2F;'
  };

  return text.replace(/[&<>"'/]/g, m => map[m]);
}

/**
 * Redirect loop detection state
 */
interface RedirectState {
  attempts: number;
  lastRedirect: number;
  sessionId: string;
  url: string; // Track the URL to detect same-URL loops
  normalizedUrl: string; // Normalized URL (without query params) for better detection
}

const redirectStates = new Map<string, RedirectState>();
const MAX_REDIRECT_ATTEMPTS = 5; // Increased to allow legitimate retries
const REDIRECT_WINDOW_MS = 30000; // 30 seconds - shorter window for faster detection

/**
 * Normalizes URL by removing query parameters to detect loops even when params vary
 */
function normalizeUrl(url: string): string {
  if (!url) return '';
  // Extract just the pathname to detect loops even if query params change
  // Fastify request.url is in format "/path?query", so we just take the path part
  return url.split('?')[0];
}

/**
 * Rate limiting for login attempts
 */
interface LoginAttempt {
  count: number;
  lastAttempt: number;
  blockedUntil?: number;
}

const loginAttempts = new Map<string, LoginAttempt>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BLOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes block after max attempts

/**
 * Checks if redirect loop is detected
 * Prevents infinite redirect loops
 * 
 * @param sessionId - Unique session identifier
 * @param currentUrl - Current request URL to detect same-URL loops
 * @returns true if loop detected
 */
export function checkRedirectLoop(sessionId: string, currentUrl?: string): boolean {
  const state = redirectStates.get(sessionId);
  const now = Date.now();
  const url = currentUrl || '';
  const normalizedUrl = normalizeUrl(url);

  if (!state) {
    redirectStates.set(sessionId, {
      attempts: 1,
      lastRedirect: now,
      sessionId,
      url: url,
      normalizedUrl: normalizedUrl
    });
    return false;
  }

  // Reset if outside time window (allows legitimate retries after delay)
  if (now - state.lastRedirect > REDIRECT_WINDOW_MS) {
    state.attempts = 1;
    state.lastRedirect = now;
    state.url = url;
    state.normalizedUrl = normalizedUrl;
    return false;
  }

  // Detect same-URL loops (most dangerous - exact same URL)
  if (url && state.url === url) {
    state.attempts += 2; // Penalize same-URL loops more heavily
  }
  // Detect same-path loops (URL path matches even if query params differ)
  else if (normalizedUrl && state.normalizedUrl === normalizedUrl) {
    state.attempts += 1.5; // Penalize same-path loops moderately
  } else {
    state.attempts++;
  }
  
  state.lastRedirect = now;
  state.url = url;
  state.normalizedUrl = normalizedUrl;

  if (state.attempts > MAX_REDIRECT_ATTEMPTS) {
    return true; // Loop detected
  }

  return false;
}

/**
 * Clears redirect state (call after successful authentication)
 */
export function clearRedirectState(sessionId: string): void {
  redirectStates.delete(sessionId);
}

/**
 * Gets redirect state without modifying it (for checking before clearing)
 */
export function getRedirectState(sessionId: string): RedirectState | undefined {
  return redirectStates.get(sessionId);
}

/**
 * Checks if login attempts are rate limited
 * 
 * @param identifier - IP address, MAC, or session ID
 * @returns true if blocked, false if allowed
 */
export function checkLoginRateLimit(identifier: string): boolean {
  const attempt = loginAttempts.get(identifier);
  const now = Date.now();

  if (!attempt) {
    loginAttempts.set(identifier, {
      count: 1,
      lastAttempt: now
    });
    return false;
  }

  // Check if still blocked
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return true; // Still blocked
  }

  // Reset if outside time window
  if (now - attempt.lastAttempt > LOGIN_WINDOW_MS) {
    attempt.count = 1;
    attempt.lastAttempt = now;
    attempt.blockedUntil = undefined;
    return false;
  }

  attempt.count++;
  attempt.lastAttempt = now;

  // Block if exceeded max attempts
  if (attempt.count > MAX_LOGIN_ATTEMPTS) {
    attempt.blockedUntil = now + BLOCK_DURATION_MS;
    return true; // Blocked
  }

  return false;
}

/**
 * Clears login rate limit (call after successful login)
 */
export function clearLoginRateLimit(identifier: string): void {
  loginAttempts.delete(identifier);
}

/**
 * Gets remaining block time in seconds
 */
export function getRemainingBlockTime(identifier: string): number {
  const attempt = loginAttempts.get(identifier);
  if (!attempt?.blockedUntil) return 0;
  const remaining = attempt.blockedUntil - Date.now();
  return Math.max(0, Math.ceil(remaining / 1000));
}

/**
 * Cleanup old redirect states (call periodically)
 */
export function cleanupRedirectStates(): void {
  const now = Date.now();
  for (const [sessionId, state] of redirectStates.entries()) {
    if (now - state.lastRedirect > REDIRECT_WINDOW_MS * 2) {
      redirectStates.delete(sessionId);
    }
  }
}

/**
 * Cleanup old login attempt records
 */
export function cleanupLoginAttempts(): void {
  const now = Date.now();
  for (const [identifier, attempt] of loginAttempts.entries()) {
    // Remove if outside window and not blocked
    if (!attempt.blockedUntil && now - attempt.lastAttempt > LOGIN_WINDOW_MS * 2) {
      loginAttempts.delete(identifier);
    }
    // Remove if block expired
    else if (attempt.blockedUntil && now > attempt.blockedUntil) {
      loginAttempts.delete(identifier);
    }
  }
}

// Cleanup every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRedirectStates, 5 * 60 * 1000);
  setInterval(cleanupLoginAttempts, 5 * 60 * 1000);
}

/**
 * Generates Content Security Policy header
 * Prevents XSS and other injection attacks
 */
export function getCSPHeader(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // 'unsafe-inline' needed for inline forms
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "form-action 'self' http: https:", // Allow form submission to router IPs
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests"
  ].join('; ');
}

/**
 * Gets security headers for portal responses
 */
export function getSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': getCSPHeader(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  };
}

