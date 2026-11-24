// src/modules/public-profile/public-profile.constants.ts
// Public portfolio profile configuration, constants, and privacy range formatters (#1355).

export const PUBLIC_PROFILE_CACHE_TTL = 60; // 60 seconds TTL

export const RESERVED_HANDLES = new Set([
   'admin',
   'api',
   'system',
   'root',
   'support',
   'help',
   'accesslayer',
   'official',
   'null',
   'undefined',
   'me',
   'public',
   'dashboard',
   'settings',
   'auth',
   'user',
   'users',
   'creator',
   'creators',
   'keys',
   'trades',
   'internal',
   'webhook',
   'status',
]);

export function buildPublicProfileCacheKey(handle: string): string {
   return `public-profile:v1:${handle.trim().toLowerCase()}`;
}

export function formatAmountRange(amount: number): string {
   if (amount <= 0) return '$0';
   if (amount < 100) return '< $100';
   if (amount < 1000) return '$100 - $1,000';
   if (amount < 5000) return '$1,000 - $5,000';
   if (amount < 10000) return '$5,000 - $10,000';
   if (amount < 50000) return '$10,000 - $50,000';
   if (amount < 100000) return '$50,000 - $100,000';
   return '> $100,000';
}

export function formatCountRange(count: number): string {
   if (count <= 0) return '0';
   if (count < 5) return '1 - 5';
   if (count < 10) return '5 - 10';
   if (count < 25) return '10 - 25';
   if (count < 50) return '25 - 50';
   if (count < 100) return '50 - 100';
   return '100+';
}
