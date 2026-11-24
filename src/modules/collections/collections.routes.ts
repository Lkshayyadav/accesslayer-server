// src/modules/collections/collections.routes.ts
// Curated collections endpoints with public listings, editor controls, and follower tracking (#1353).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   sendConflict,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   addItemToCollection,
   CollectionNotFoundError,
   createCollection,
   DuplicateSlugError,
   followCollection,
   getCollectionBySlug,
   getPublishedCollections,
   removeItemFromCollection,
   reorderCollectionItems,
   setCollectionPublishStatus,
   unfollowCollection,
} from './collections.service';

export const collectionsRouter = Router();

const toParamString = (param: string | string[] | undefined): string => {
   if (!param) return '';
   return Array.isArray(param) ? param[0] : param;
};

const createCollectionSchema = z.object({
   slug: z.string().trim().min(2).max(64).regex(/^[a-z0-9_-]+$/i, 'Invalid slug format'),
   title: z.string().trim().min(1).max(128),
   description: z.string().trim().max(1000).optional(),
   published: z.boolean().optional(),
});

const addItemSchema = z.object({
   keyId: z.string().trim().min(1),
   position: z.number().int().min(0),
   notes: z.string().trim().max(500).optional(),
});

const reorderSchema = z.object({
   items: z.array(
      z.object({
         keyId: z.string().trim().min(1),
         position: z.number().int().min(0),
      })
   ).min(1),
});

const publishSchema = z.object({
   published: z.boolean(),
});

// ── Public Routes ─────────────────────────────────────────────

/** GET /v1/collections — List published collections. */
collectionsRouter.get(
   '/',
   async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const collections = await getPublishedCollections();
         sendSuccess(res, collections, 200);
      } catch (error) {
         next(error);
      }
   }
);

/** GET /v1/collections/:slug — Get published collection by slug. */
collectionsRouter.get(
   '/:slug',
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const slug = toParamString(req.params.slug);
         if (!slug) {
            sendNotFound(res, 'Collection');
            return;
         }

         const collection = await getCollectionBySlug(slug, true);
         if (!collection) {
            sendNotFound(res, 'Collection');
            return;
         }

         sendSuccess(res, collection, 200);
      } catch (error) {
         next(error);
      }
   }
);

// ── Follower Routes ───────────────────────────────────────────

/** POST /v1/collections/:slug/follow — Follow collection. */
collectionsRouter.post(
   '/:slug/follow',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const result = await followCollection(wallet, toParamString(req.params.slug));
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof CollectionNotFoundError) {
            sendNotFound(res, 'Collection');
            return;
         }
         next(error);
      }
   }
);

/** DELETE /v1/collections/:slug/follow — Unfollow collection. */
collectionsRouter.delete(
   '/:slug/follow',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const result = await unfollowCollection(wallet, toParamString(req.params.slug));
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof CollectionNotFoundError) {
            sendNotFound(res, 'Collection');
            return;
         }
         next(error);
      }
   }
);

// ── Editor Routes ─────────────────────────────────────────────

/** POST /v1/collections — Create new collection. */
collectionsRouter.post(
   '/',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const parsed = createCollectionSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(res, 'Validation failed', zodIssuesToDetails(parsed.error.issues));
            return;
         }

         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const collection = await createCollection(wallet, parsed.data);
         sendSuccess(res, collection, 201);
      } catch (error) {
         if (error instanceof DuplicateSlugError) {
            sendConflict(res, error.message);
            return;
         }
         next(error);
      }
   }
);

/** POST /v1/collections/:slug/items — Add item to collection. */
collectionsRouter.post(
   '/:slug/items',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const parsed = addItemSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(res, 'Validation failed', zodIssuesToDetails(parsed.error.issues));
            return;
         }

         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const item = await addItemToCollection(wallet, toParamString(req.params.slug), parsed.data);
         sendSuccess(res, item, 201);
      } catch (error) {
         if (error instanceof CollectionNotFoundError) {
            sendNotFound(res, 'Collection');
            return;
         }
         next(error);
      }
   }
);

/** DELETE /v1/collections/:slug/items/:keyId — Remove item from collection. */
collectionsRouter.delete(
   '/:slug/items/:keyId',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         await removeItemFromCollection(wallet, toParamString(req.params.slug), toParamString(req.params.keyId));
         sendSuccess(res, { removed: true }, 200);
      } catch (error) {
         if (error instanceof CollectionNotFoundError) {
            sendNotFound(res, 'Collection');
            return;
         }
         next(error);
      }
   }
);

/** PUT /v1/collections/:slug/reorder — Reorder items in collection. */
collectionsRouter.put(
   '/:slug/reorder',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const parsed = reorderSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(res, 'Validation failed', zodIssuesToDetails(parsed.error.issues));
            return;
         }

         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const items = await reorderCollectionItems(wallet, toParamString(req.params.slug), parsed.data.items);
         sendSuccess(res, items, 200);
      } catch (error) {
         if (error instanceof CollectionNotFoundError) {
            sendNotFound(res, 'Collection');
            return;
         }
         next(error);
      }
   }
);

/** PATCH /v1/collections/:slug/publish — Set collection publish status. */
collectionsRouter.patch(
   '/:slug/publish',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const parsed = publishSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(res, 'Validation failed', zodIssuesToDetails(parsed.error.issues));
            return;
         }

         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const updated = await setCollectionPublishStatus(wallet, toParamString(req.params.slug), parsed.data.published);
         sendSuccess(res, updated, 200);
      } catch (error) {
         if (error instanceof CollectionNotFoundError) {
            sendNotFound(res, 'Collection');
            return;
         }
         next(error);
      }
   }
);

export default collectionsRouter;
