// src/modules/public-profile/public-profile.test.ts
// Unit and integration tests for public portfolio profile & privacy controls (#1355).

import express, { Express } from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import * as redisUtils from '../../utils/redis.utils';
import * as holdingsService from '../users/holdings.service';
import {
   buildPublicProfileCacheKey,
   formatAmountRange,
   formatCountRange,
   RESERVED_HANDLES,
} from './public-profile.constants';
import {
   getPublicProfileByHandle,
   HandleTakenError,
   InvalidHandleFormatError,
   ReservedHandleError,
   upsertPublicProfile,
   validateHandle,
} from './public-profile.service';
import {
   publicProfileMeRouter,
   publicProfilesPublicRouter,
} from './public-profile.routes';

// Mock dependencies
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      publicProfile: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

jest.mock('../users/holdings.service', () => ({
   getWalletHoldings: jest.fn(),
}));

// Mock requireJwtAuth to inject test user
const mockWallet = 'GBBD47IF6LWK7P7MDEVTESTWALLETADDR1234567890';
jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: mockWallet };
      next();
   },
}));

describe('PublicProfile Module (#1355)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('Range Formatters', () => {
      it('formats amount ranges correctly', () => {
         expect(formatAmountRange(0)).toBe('$0');
         expect(formatAmountRange(50)).toBe('< $100');
         expect(formatAmountRange(500)).toBe('$100 - $1,000');
         expect(formatAmountRange(2500)).toBe('$1,000 - $5,000');
         expect(formatAmountRange(7500)).toBe('$5,000 - $10,000');
         expect(formatAmountRange(25000)).toBe('$10,000 - $50,000');
         expect(formatAmountRange(75000)).toBe('$50,000 - $100,000');
         expect(formatAmountRange(150000)).toBe('> $100,000');
      });

      it('formats count ranges correctly', () => {
         expect(formatCountRange(0)).toBe('0');
         expect(formatCountRange(3)).toBe('1 - 5');
         expect(formatCountRange(8)).toBe('5 - 10');
         expect(formatCountRange(15)).toBe('10 - 25');
         expect(formatCountRange(35)).toBe('25 - 50');
         expect(formatCountRange(75)).toBe('50 - 100');
         expect(formatCountRange(150)).toBe('100+');
      });
   });

   describe('Handle Validation & Reserved Words', () => {
      it('rejects handles shorter than 3 characters', () => {
         expect(() => validateHandle('ab')).toThrow(InvalidHandleFormatError);
      });

      it('rejects handles longer than 30 characters', () => {
         expect(() => validateHandle('a'.repeat(31))).toThrow(InvalidHandleFormatError);
      });

      it('rejects handles with special characters', () => {
         expect(() => validateHandle('alice@crypto')).toThrow(InvalidHandleFormatError);
         expect(() => validateHandle('alice.eth')).toThrow(InvalidHandleFormatError);
         expect(() => validateHandle('alice space')).toThrow(InvalidHandleFormatError);
      });

      it('rejects reserved words', () => {
         for (const reserved of Array.from(RESERVED_HANDLES)) {
            expect(() => validateHandle(reserved)).toThrow(ReservedHandleError);
         }
      });

      it('accepts and normalizes valid handles', () => {
         expect(validateHandle('  Alice_123-Pro  ')).toBe('alice_123-pro');
      });
   });

   describe('upsertPublicProfile Service', () => {
      it('rejects handle already taken by another wallet', async () => {
         (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce({
            wallet: 'ANOTHER_WALLET_ADDR',
            handle: 'taken_handle',
         });

         await expect(
            upsertPublicProfile(mockWallet, { handle: 'taken_handle' })
         ).rejects.toThrow(HandleTakenError);
      });

      it('upserts profile and invalidates cache when valid', async () => {
         (prisma.publicProfile.findUnique as jest.Mock)
            .mockResolvedValueOnce(null) // no handle conflict
            .mockResolvedValueOnce(null); // existing wallet check

         (prisma.publicProfile.upsert as jest.Mock).mockResolvedValueOnce({
            wallet: mockWallet,
            handle: 'stellar_whale',
            enabled: true,
            showHoldings: true,
            showPnl: true,
            showKeyCount: true,
            showJoined: true,
            showWallet: false,
            hideExactAmounts: false,
         });

         const result = await upsertPublicProfile(mockWallet, {
            handle: 'stellar_whale',
            enabled: true,
            showHoldings: true,
         });

         expect(result.handle).toBe('stellar_whale');
         expect(redisUtils.cacheInvalidate).toHaveBeenCalledWith(
            buildPublicProfileCacheKey('stellar_whale')
         );
      });

      it('invalidates both old and new handle cache when handle is changed', async () => {
         (prisma.publicProfile.findUnique as jest.Mock)
            .mockResolvedValueOnce(null) // no handle conflict
            .mockResolvedValueOnce({
               wallet: mockWallet,
               handle: 'old_handle',
            }); // existing wallet profile

         (prisma.publicProfile.upsert as jest.Mock).mockResolvedValueOnce({
            wallet: mockWallet,
            handle: 'new_handle',
         });

         await upsertPublicProfile(mockWallet, { handle: 'new_handle' });

         expect(redisUtils.cacheInvalidate).toHaveBeenCalledWith(
            buildPublicProfileCacheKey('new_handle')
         );
         expect(redisUtils.cacheInvalidate).toHaveBeenCalledWith(
            buildPublicProfileCacheKey('old_handle')
         );
      });
   });

   describe('getPublicProfileByHandle Service & Privacy Filtering', () => {
      const mockCreatedAt = new Date('2026-01-15T10:00:00Z');

      it('returns cached profile if present', async () => {
         const cachedView = { handle: 'cached_user', holdings: 1000 };
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(cachedView);

         const result = await getPublicProfileByHandle('cached_user');
         expect(result).toEqual(cachedView);
         expect(prisma.publicProfile.findUnique).not.toHaveBeenCalled();
      });

      it('returns null for unknown handle (triggers 404)', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce(null);

         const result = await getPublicProfileByHandle('unknown_handle');
         expect(result).toBeNull();
      });

      it('returns null for disabled profile (identical 404 response to unknown handle)', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce({
            wallet: mockWallet,
            handle: 'disabled_user',
            enabled: false, // disabled
         });

         const result = await getPublicProfileByHandle('disabled_user');
         expect(result).toBeNull();
      });

      it('never leaks hidden fields when disabled by owner', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce({
            wallet: mockWallet,
            handle: 'private_whale',
            enabled: true,
            showHoldings: false, // HIDDEN
            showPnl: false,      // HIDDEN
            showKeyCount: false, // HIDDEN
            showJoined: false,   // HIDDEN
            showWallet: false,   // HIDDEN
            hideExactAmounts: false,
            createdAt: mockCreatedAt,
         });

         (holdingsService.getWalletHoldings as jest.Mock).mockResolvedValueOnce([
            { keyId: 'k1', quantity: 10, currentPrice: 50, unrealisedPnl: 100 },
         ]);

         const result = await getPublicProfileByHandle('private_whale');

         expect(result).toBeDefined();
         expect(result?.handle).toBe('private_whale');
         expect(result?.wallet).toBeUndefined();
         expect(result?.joinedAt).toBeUndefined();
         expect(result?.holdings).toBeUndefined();
         expect(result?.pnl).toBeUndefined();
         expect(result?.keyCount).toBeUndefined();
      });

      it('includes exact amounts when enabled and hideExactAmounts is false', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce({
            wallet: mockWallet,
            handle: 'public_whale',
            enabled: true,
            showHoldings: true,
            showPnl: true,
            showKeyCount: true,
            showJoined: true,
            showWallet: true,
            hideExactAmounts: false,
            createdAt: mockCreatedAt,
         });

         (holdingsService.getWalletHoldings as jest.Mock).mockResolvedValueOnce([
            { keyId: 'k1', quantity: 10, currentPrice: 50, unrealisedPnl: 150 },
            { keyId: 'k2', quantity: 5, currentPrice: 100, unrealisedPnl: -50 },
         ]);

         const result = await getPublicProfileByHandle('public_whale');

         expect(result).toEqual({
            handle: 'public_whale',
            wallet: mockWallet,
            joinedAt: mockCreatedAt.toISOString(),
            keyCount: 2,
            holdings: 1000,
            pnl: 100,
         });
      });

      it('replaces exact amounts with range values when hideExactAmounts is true', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce({
            wallet: mockWallet,
            handle: 'range_whale',
            enabled: true,
            showHoldings: true,
            showPnl: true,
            showKeyCount: true,
            showJoined: true,
            showWallet: false,
            hideExactAmounts: true, // RANGE VALUES REPLACEMENT
            createdAt: mockCreatedAt,
         });

         (holdingsService.getWalletHoldings as jest.Mock).mockResolvedValueOnce([
            { keyId: 'k1', quantity: 10, currentPrice: 250, unrealisedPnl: 1200 }, // holdings: 2500 -> $1,000 - $5,000, pnl: 1200 -> $1,000 - $5,000
         ]);

         const result = await getPublicProfileByHandle('range_whale');

         expect(result).toEqual({
            handle: 'range_whale',
            joinedAt: mockCreatedAt.toISOString(),
            keyCount: '1 - 5',
            holdings: '$1,000 - $5,000',
            pnl: '$1,000 - $5,000',
         });
         expect(result?.wallet).toBeUndefined(); // wallet strictly hidden
      });
   });

   describe('HTTP Endpoints', () => {
      let app: Express;

      beforeEach(() => {
         app = express();
         app.use(express.json());
         app.use('/v1/me', publicProfileMeRouter);
         app.use('/v1/public/profiles', publicProfilesPublicRouter);
      });

      describe('PUT /v1/me/public-profile', () => {
         it('returns 400 for reserved handles', async () => {
            const res = await request(app)
               .put('/v1/me/public-profile')
               .send({ handle: 'admin' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
         });

         it('returns 409 for taken handles', async () => {
            (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValueOnce({
               wallet: 'OTHER_WALLET',
               handle: 'crypto_god',
            });

            const res = await request(app)
               .put('/v1/me/public-profile')
               .send({ handle: 'crypto_god' });

            expect(res.status).toBe(409);
            expect(res.body.success).toBe(false);
         });

         it('returns 200 on successful update', async () => {
            (prisma.publicProfile.findUnique as jest.Mock)
               .mockResolvedValueOnce(null)
               .mockResolvedValueOnce(null);

            (prisma.publicProfile.upsert as jest.Mock).mockResolvedValueOnce({
               wallet: mockWallet,
               handle: 'stellar_chad',
               enabled: true,
            });

            const res = await request(app)
               .put('/v1/me/public-profile')
               .send({ handle: 'stellar_chad', enabled: true });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.handle).toBe('stellar_chad');
         });
      });

      describe('GET /v1/public/profiles/:handle', () => {
         it('returns identical 404 for unknown handle and disabled profile', async () => {
            (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
            (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValue(null);

            const resUnknown = await request(app).get('/v1/public/profiles/non_existent');
            expect(resUnknown.status).toBe(404);
            expect(resUnknown.body.error.message).toBe('Profile not found');

            (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValue({
               wallet: mockWallet,
               handle: 'disabled_user',
               enabled: false,
            });

            const resDisabled = await request(app).get('/v1/public/profiles/disabled_user');
            expect(resDisabled.status).toBe(404);
            expect(resDisabled.body.error.message).toBe('Profile not found');
         });

         it('returns 200 and sets Cache-Control header for active profile', async () => {
            (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
            (prisma.publicProfile.findUnique as jest.Mock).mockResolvedValue({
               wallet: mockWallet,
               handle: 'active_trader',
               enabled: true,
               showHoldings: true,
               showPnl: true,
               showKeyCount: true,
               showJoined: true,
               showWallet: false,
               hideExactAmounts: false,
               createdAt: new Date('2026-02-01T00:00:00Z'),
            });
            (holdingsService.getWalletHoldings as jest.Mock).mockResolvedValue([]);

            const res = await request(app).get('/v1/public/profiles/active_trader');
            expect(res.status).toBe(200);
            expect(res.headers['cache-control']).toBe('public, max-age=60');
            expect(res.body.data.handle).toBe('active_trader');
         });
      });
   });
});
