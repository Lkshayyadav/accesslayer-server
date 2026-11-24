// src/modules/collections/collections.test.ts
// Unit and integration tests for curated collections (#1353).

import express, { Express } from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import * as collectionEvents from './collections.events';
import {
   addItemToCollection,
   createCollection,
   followCollection,
   getCollectionBySlug,
   getPublishedCollections,
   reorderCollectionItems,
   unfollowCollection,
} from './collections.service';
import { collectionsRouter } from './collections.routes';

// Mock dependencies
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      collection: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      collectionItem: {
         create: jest.fn(),
         deleteMany: jest.fn(),
         findMany: jest.fn(),
         updateMany: jest.fn(),
      },
      collectionFollow: {
         findUnique: jest.fn(),
         create: jest.fn(),
         delete: jest.fn(),
      },
      keyFreeze: {
         findMany: jest.fn(),
      },
      keyRetirement: {
         findMany: jest.fn(),
      },
      keyReport: {
         findMany: jest.fn(),
      },
      $transaction: jest.fn((callbackOrArray) => {
         if (typeof callbackOrArray === 'function') {
            return callbackOrArray(prisma);
         }
         return Promise.all(callbackOrArray);
      }),
   },
}));

jest.mock('./collections.events', () => {
   const original = jest.requireActual('./collections.events');
   return {
      ...original,
      emitCollectionItemAdded: jest.fn(),
   };
});

const mockWallet = 'GBBD47IF6LWK7P7MDEVTESTWALLETADDR1234567890';
jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: mockWallet };
      next();
   },
}));

describe('Curated Collections Module (#1353)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('Public Collection Listings', () => {
      it('queries only published collections', async () => {
         (prisma.collection.findMany as jest.Mock).mockResolvedValueOnce([
            { id: 'c1', slug: 'top-defi', published: true },
         ]);

         const result = await getPublishedCollections();

         expect(prisma.collection.findMany).toHaveBeenCalledWith({
            where: { published: true },
            orderBy: { createdAt: 'desc' },
            include: {
               _count: {
                  select: { items: true, follows: true },
               },
            },
         });
         expect(result.length).toBe(1);
      });

      it('returns null when collection is not published and requirePublished is true', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'draft-collection',
            published: false,
            items: [],
         });

         const result = await getCollectionBySlug('draft-collection', true);
         expect(result).toBeNull();
      });

      it('excludes frozen, retired, and actioned keys from public view', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'stellar-gems',
            published: true,
            items: [
               { id: 'i1', keyId: 'active-key-1', position: 1, notes: 'Great key' },
               { id: 'i2', keyId: 'frozen-key', position: 2, notes: 'Frozen' },
               { id: 'i3', keyId: 'retired-key', position: 3, notes: 'Retired' },
               { id: 'i4', keyId: 'flagged-key', position: 4, notes: 'Flagged' },
               { id: 'i5', keyId: 'active-key-2', position: 5, notes: 'Another great key' },
            ],
         });

         (prisma.keyFreeze.findMany as jest.Mock).mockResolvedValueOnce([
            { keyId: 'frozen-key' },
         ]);
         (prisma.keyRetirement.findMany as jest.Mock).mockResolvedValueOnce([
            { keyId: 'retired-key' },
         ]);
         (prisma.keyReport.findMany as jest.Mock).mockResolvedValueOnce([
            { keyId: 'flagged-key' },
         ]);

         const result = await getCollectionBySlug('stellar-gems', true);

         expect(result).toBeDefined();
         expect(result?.items.length).toBe(2);
         expect(result?.items.map(i => i.keyId)).toEqual(['active-key-1', 'active-key-2']);
      });
   });

   describe('Editor Operations & Event Emission', () => {
      it('creates collection with normalized slug', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce(null);
         (prisma.collection.create as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'metaverse-keys',
            title: 'Metaverse Keys',
         });

         const result = await createCollection(mockWallet, {
            slug: 'Metaverse-Keys ',
            title: 'Metaverse Keys',
         });

         expect(result.slug).toBe('metaverse-keys');
      });

      it('adds item to collection and emits collection.item_added event', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'col-123',
            slug: 'blue-chips',
         });

         (prisma.collectionItem.create as jest.Mock).mockResolvedValueOnce({
            id: 'item-1',
            collectionId: 'col-123',
            keyId: 'stellar-key-1',
            position: 1,
            notes: 'Top tier key',
         });

         const item = await addItemToCollection(mockWallet, 'blue-chips', {
            keyId: 'stellar-key-1',
            position: 1,
            notes: 'Top tier key',
         });

         expect(item.keyId).toBe('stellar-key-1');
         expect(collectionEvents.emitCollectionItemAdded).toHaveBeenCalledWith(
            expect.objectContaining({
               type: 'collection.item_added',
               collectionId: 'col-123',
               slug: 'blue-chips',
               keyId: 'stellar-key-1',
               position: 1,
            })
         );
      });

      it('persists reordered items with unique positions in a transaction', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'col-123',
            slug: 'blue-chips',
         });

         const reorders = [
            { keyId: 'key-b', position: 1 },
            { keyId: 'key-a', position: 2 },
         ];

         (prisma.collectionItem.findMany as jest.Mock).mockResolvedValueOnce([
            { keyId: 'key-b', position: 1 },
            { keyId: 'key-a', position: 2 },
         ]);

         await reorderCollectionItems(mockWallet, 'blue-chips', reorders);

         expect(prisma.$transaction).toHaveBeenCalled();
         expect(prisma.collectionItem.updateMany).toHaveBeenCalled();
      });

      it('rejects duplicate positions during reordering', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'col-123',
            slug: 'blue-chips',
         });

         const duplicateReorders = [
            { keyId: 'key-a', position: 1 },
            { keyId: 'key-b', position: 1 }, // duplicate
         ];

         await expect(
            reorderCollectionItems(mockWallet, 'blue-chips', duplicateReorders)
         ).rejects.toThrow('Positions must be unique');
      });
   });

   describe('Follow / Unfollow Idempotency', () => {
      it('increments follower count when followed first time', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'top-picks',
            followerCount: 0,
         });
         (prisma.collectionFollow.findUnique as jest.Mock).mockResolvedValueOnce(null);

         (prisma.collection.update as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            followerCount: 1,
         });

         const res = await followCollection(mockWallet, 'top-picks');
         expect(res.followed).toBe(true);
         expect(res.followerCount).toBe(1);
      });

      it('is idempotent when user follows an already followed collection', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'top-picks',
            followerCount: 5,
         });
         (prisma.collectionFollow.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'f1',
            wallet: mockWallet,
         });

         const res = await followCollection(mockWallet, 'top-picks');
         expect(res.followed).toBe(true);
         expect(res.followerCount).toBe(5);
         expect(prisma.collection.update).not.toHaveBeenCalled();
      });

      it('decrements follower count on unfollow', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'top-picks',
            followerCount: 5,
         });
         (prisma.collectionFollow.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'f1',
            wallet: mockWallet,
         });
         (prisma.collection.update as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            followerCount: 4,
         });

         const res = await unfollowCollection(mockWallet, 'top-picks');
         expect(res.followed).toBe(false);
         expect(res.followerCount).toBe(4);
      });
   });

   describe('HTTP API Endpoints', () => {
      let app: Express;

      beforeEach(() => {
         app = express();
         app.use(express.json());
         app.use('/v1/collections', collectionsRouter);
      });

      it('GET /v1/collections returns 200 with list', async () => {
         (prisma.collection.findMany as jest.Mock).mockResolvedValueOnce([]);
         const res = await request(app).get('/v1/collections');
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
      });

      it('GET /v1/collections/:slug returns 404 for missing or draft collection', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce(null);
         const res = await request(app).get('/v1/collections/missing');
         expect(res.status).toBe(404);
         expect(res.body.error.message).toBe('Collection not found');
      });

      it('POST /v1/collections/:slug/follow adds user to followers', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'stellar-club',
            followerCount: 10,
         });
         (prisma.collectionFollow.findUnique as jest.Mock).mockResolvedValueOnce(null);
         (prisma.collection.update as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            followerCount: 11,
         });

         const res = await request(app).post('/v1/collections/stellar-club/follow');
         expect(res.status).toBe(200);
         expect(res.body.data.followed).toBe(true);
         expect(res.body.data.followerCount).toBe(11);
      });

      it('POST /v1/collections/:slug/items adds item and returns 201', async () => {
         (prisma.collection.findUnique as jest.Mock).mockResolvedValueOnce({
            id: 'c1',
            slug: 'stellar-club',
         });
         (prisma.collectionItem.create as jest.Mock).mockResolvedValueOnce({
            id: 'item-1',
            keyId: 'k1',
            position: 1,
         });

         const res = await request(app)
            .post('/v1/collections/stellar-club/items')
            .send({ keyId: 'k1', position: 1, notes: 'Featured key' });

         expect(res.status).toBe(201);
         expect(res.body.data.keyId).toBe('k1');
      });
   });
});
