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
}

const redirectStates = new Map<string, RedirectState>();
const MAX_REDIRECT_ATTEMPTS = 3;
const REDIRECT_WINDOW_MS = 60000; // 1 minute

/**
 * Checks if redirect loop is detected
 * Prevents infinite redirect loops
 * 
 * @param sessionId - Unique session identifier
 * @returns true if loop detected
 */
export function checkRedirectLoop(sessionId: string): boolean {
  const state = redirectStates.get(sessionId);
  const now = Date.now();

  if (!state) {
    redirectStates.set(sessionId, {
      attempts: 1,
      lastRedirect: now,
      sessionId
    });
    return false;
  }

  // Reset if outside time window
  if (now - state.lastRedirect > REDIRECT_WINDOW_MS) {
    state.attempts = 1;
    state.lastRedirect = now;
    return false;
  }

  state.attempts++;
  state.lastRedirect = now;

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

// Cleanup every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRedirectStates, 5 * 60 * 1000);
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
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

