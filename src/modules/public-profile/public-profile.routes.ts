// src/modules/public-profile/public-profile.routes.ts
// Public portfolio profile and handle registry endpoints (#1355).

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
   getPublicProfileByHandle,
   HandleTakenError,
   InvalidHandleFormatError,
   ReservedHandleError,
   upsertPublicProfile,
} from './public-profile.service';

export const publicProfileMeRouter = Router();
export const publicProfilesPublicRouter = Router();

const updateProfileSchema = z.object({
   handle: z.string().trim().min(3).max(30),
   enabled: z.boolean().optional(),
   showHoldings: z.boolean().optional(),
   showPnl: z.boolean().optional(),
   showKeyCount: z.boolean().optional(),
   showJoined: z.boolean().optional(),
   showWallet: z.boolean().optional(),
   hideExactAmounts: z.boolean().optional(),
});

/**
 * PUT /v1/me/public-profile
 * Register or update public profile handle and visibility settings.
 */
publicProfileMeRouter.put(
   '/public-profile',
   requireJwtAuth,
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const parsed = updateProfileSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(res, 'Validation failed', zodIssuesToDetails(parsed.error.issues));
            return;
         }

         const wallet = (req as AuthenticatedRequest).user?.wallet;
         if (!wallet) {
            sendValidationError(res, 'Wallet authentication required');
            return;
         }

         const profile = await upsertPublicProfile(wallet, parsed.data);
         sendSuccess(res, profile, 200);
      } catch (error) {
         if (error instanceof HandleTakenError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof ReservedHandleError || error instanceof InvalidHandleFormatError) {
            sendValidationError(res, error.message);
            return;
         }
         next(error);
      }
   }
);

/**
 * GET /v1/public/profiles/:handle
 * View a public portfolio profile with privacy filtering.
 * Returns identical 404 for disabled profiles and unknown handles.
 */
publicProfilesPublicRouter.get(
   '/:handle',
   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const rawHandle = req.params.handle;
         if (!rawHandle || typeof rawHandle !== 'string') {
            sendNotFound(res, 'Profile not found');
            return;
         }

         const profile = await getPublicProfileByHandle(rawHandle);
         if (!profile) {
            sendNotFound(res, 'Profile');
            return;
         }

         // Set cache header for public caching
         res.setHeader('Cache-Control', 'public, max-age=60');
         sendSuccess(res, profile, 200);
      } catch (error) {
         next(error);
      }
   }
);
