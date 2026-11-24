// src/modules/public-profile/public-profile.service.ts
// Public portfolio profile registry, handle validation, caching, and privacy filtering (#1355).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { getWalletHoldings } from '../users/holdings.service';
import {
   buildPublicProfileCacheKey,
   formatAmountRange,
   formatCountRange,
   PUBLIC_PROFILE_CACHE_TTL,
   RESERVED_HANDLES,
} from './public-profile.constants';

export class ReservedHandleError extends Error {
   constructor(handle: string) {
      super(`Handle '${handle}' is reserved and cannot be registered.`);
      this.name = 'ReservedHandleError';
   }
}

export class HandleTakenError extends Error {
   constructor(handle: string) {
      super(`Handle '${handle}' is already registered to another account.`);
      this.name = 'HandleTakenError';
   }
}

export class InvalidHandleFormatError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'InvalidHandleFormatError';
   }
}

export interface UpdatePublicProfileInput {
   handle: string;
   enabled?: boolean;
   showHoldings?: boolean;
   showPnl?: boolean;
   showKeyCount?: boolean;
   showJoined?: boolean;
   showWallet?: boolean;
   hideExactAmounts?: boolean;
}

export interface PublicProfileView {
   handle: string;
   wallet?: string;
   joinedAt?: string;
   keyCount?: number | string;
   holdings?: number | string;
   pnl?: number | string;
}

const HANDLE_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;

export function validateHandle(rawHandle: string): string {
   const trimmed = rawHandle.trim().toLowerCase();
   if (RESERVED_HANDLES.has(trimmed)) {
      throw new ReservedHandleError(trimmed);
   }
   if (!HANDLE_REGEX.test(trimmed)) {
      throw new InvalidHandleFormatError(
         'Handle must be 3-30 characters long and contain only letters, numbers, underscores, and hyphens.'
      );
   }
   return trimmed;
}

export async function upsertPublicProfile(
   wallet: string,
   input: UpdatePublicProfileInput
) {
   const normalizedHandle = validateHandle(input.handle);

   // Check if handle is taken by another wallet
   const existingWithHandle = await prisma.publicProfile.findUnique({
      where: { handle: normalizedHandle },
   });

   if (existingWithHandle && existingWithHandle.wallet !== wallet) {
      throw new HandleTakenError(normalizedHandle);
   }

   // Fetch existing profile to check for previous handle to invalidate
   const existingForWallet = await prisma.publicProfile.findUnique({
      where: { wallet },
   });

   const profile = await prisma.publicProfile.upsert({
      where: { wallet },
      create: {
         wallet,
         handle: normalizedHandle,
         enabled: input.enabled ?? true,
         showHoldings: input.showHoldings ?? true,
         showPnl: input.showPnl ?? true,
         showKeyCount: input.showKeyCount ?? true,
         showJoined: input.showJoined ?? true,
         showWallet: input.showWallet ?? false,
         hideExactAmounts: input.hideExactAmounts ?? false,
      },
      update: {
         handle: normalizedHandle,
         ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
         ...(input.showHoldings !== undefined ? { showHoldings: input.showHoldings } : {}),
         ...(input.showPnl !== undefined ? { showPnl: input.showPnl } : {}),
         ...(input.showKeyCount !== undefined ? { showKeyCount: input.showKeyCount } : {}),
         ...(input.showJoined !== undefined ? { showJoined: input.showJoined } : {}),
         ...(input.showWallet !== undefined ? { showWallet: input.showWallet } : {}),
         ...(input.hideExactAmounts !== undefined ? { hideExactAmounts: input.hideExactAmounts } : {}),
      },
   });

   // Invalidate cache for new handle and previous handle if changed
   await cacheInvalidate(buildPublicProfileCacheKey(normalizedHandle));
   if (existingForWallet && existingForWallet.handle !== normalizedHandle) {
      await cacheInvalidate(buildPublicProfileCacheKey(existingForWallet.handle));
   }

   return profile;
}

export async function getPublicProfileByHandle(
   rawHandle: string
): Promise<PublicProfileView | null> {
   const handle = rawHandle.trim().toLowerCase();
   const cacheKey = buildPublicProfileCacheKey(handle);

   const cached = await cacheGetJson<PublicProfileView>(cacheKey);
   if (cached) {
      return cached;
   }

   const profile = await prisma.publicProfile.findUnique({
      where: { handle },
   });

   // Both unknown handles and disabled profiles return null (identical 404 response)
   if (!profile || !profile.enabled) {
      return null;
   }

   // Fetch user holdings to calculate metrics
   const holdingsList = await getWalletHoldings(profile.wallet).catch(() => []);

   const totalHoldingsValue = holdingsList.reduce(
      (sum, h) => sum + (h.quantity * (h.currentPrice || 0)),
      0
   );
   const totalPnl = holdingsList.reduce(
      (sum, h) => sum + (h.unrealisedPnl || 0),
      0
   );
   const totalKeys = holdingsList.length;

   // Build privacy-filtered response view
   const result: PublicProfileView = {
      handle: profile.handle,
   };

   // Only include fields explicitly enabled by the owner
   if (profile.showWallet) {
      result.wallet = profile.wallet;
   }

   if (profile.showJoined) {
      result.joinedAt = profile.createdAt.toISOString();
   }

   if (profile.showKeyCount) {
      result.keyCount = profile.hideExactAmounts
         ? formatCountRange(totalKeys)
         : totalKeys;
   }

   if (profile.showHoldings) {
      result.holdings = profile.hideExactAmounts
         ? formatAmountRange(totalHoldingsValue)
         : Number(totalHoldingsValue.toFixed(2));
   }

   if (profile.showPnl) {
      result.pnl = profile.hideExactAmounts
         ? formatAmountRange(totalPnl)
         : Number(totalPnl.toFixed(2));
   }

   await cacheSetJson(cacheKey, result, PUBLIC_PROFILE_CACHE_TTL);

   return result;
}
