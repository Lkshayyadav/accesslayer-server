// src/modules/collections/collections.service.ts
// Curated collections service with editor operations, unique reordering,
// follower updates, and automatic exclusion of frozen/retired keys (#1353).

import { prisma } from '../../utils/prisma.utils';
import { emitCollectionItemAdded, ITEM_ADDED_EVENT } from './collections.events';

export class CollectionNotFoundError extends Error {
   constructor(slug: string) {
      super(`Collection with slug '${slug}' not found.`);
      this.name = 'CollectionNotFoundError';
   }
}

export class DuplicateSlugError extends Error {
   constructor(slug: string) {
      super(`Collection with slug '${slug}' already exists.`);
      this.name = 'DuplicateSlugError';
   }
}

export interface CreateCollectionInput {
   slug: string;
   title: string;
   description?: string;
   published?: boolean;
}

export interface AddItemInput {
   keyId: string;
   position: number;
   notes?: string;
}

export interface ReorderItemInput {
   keyId: string;
   position: number;
}

export async function getPublishedCollections() {
   return prisma.collection.findMany({
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      include: {
         _count: {
            select: { items: true, follows: true },
         },
      },
   });
}

export async function getCollectionBySlug(slug: string, requirePublished = true) {
   const collection = await prisma.collection.findUnique({
      where: { slug: slug.trim().toLowerCase() },
      include: {
         items: {
            orderBy: { position: 'asc' },
         },
      },
   });

   if (!collection) {
      return null;
   }

   if (requirePublished && !collection.published) {
      return null;
   }

   if (collection.items.length === 0) {
      return collection;
   }

   const keyIds = collection.items.map(item => item.keyId);

   // Exclude frozen keys
   const frozenKeys = await prisma.keyFreeze.findMany({
      where: {
         keyId: { in: keyIds },
         isFrozen: true,
      },
      select: { keyId: true },
   });
   const frozenSet = new Set(frozenKeys.map(k => k.keyId));

   // Exclude retired keys
   const retiredKeys = await prisma.keyRetirement.findMany({
      where: {
         keyId: { in: keyIds },
         status: 'retired',
      },
      select: { keyId: true },
   });
   const retiredSet = new Set(retiredKeys.map(k => k.keyId));

   // Exclude flagged/actioned keys
   const actionedReports = await prisma.keyReport.findMany({
      where: {
         keyId: { in: keyIds },
         status: 'actioned',
      },
      select: { keyId: true },
   });
   const flaggedSet = new Set(actionedReports.map(k => k.keyId));

   // Filter out inactive keys from public view
   const visibleItems = collection.items.filter(
      item =>
         !frozenSet.has(item.keyId) &&
         !retiredSet.has(item.keyId) &&
         !flaggedSet.has(item.keyId)
   );

   return {
      ...collection,
      items: visibleItems,
   };
}

export async function createCollection(
   editorWallet: string,
   input: CreateCollectionInput
) {
   const normalizedSlug = input.slug.trim().toLowerCase();

   const existing = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (existing) {
      throw new DuplicateSlugError(normalizedSlug);
   }

   return prisma.collection.create({
      data: {
         slug: normalizedSlug,
         title: input.title.trim(),
         description: input.description?.trim(),
         published: input.published ?? false,
         createdBy: editorWallet,
      },
   });
}

export async function addItemToCollection(
   _editorWallet: string,
   slug: string,
   input: AddItemInput
) {
   const normalizedSlug = slug.trim().toLowerCase();
   const collection = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (!collection) {
      throw new CollectionNotFoundError(normalizedSlug);
   }

   const item = await prisma.collectionItem.create({
      data: {
         collectionId: collection.id,
         keyId: input.keyId,
         position: input.position,
         notes: input.notes?.trim(),
      },
   });

   // Emit event for downstream ingestion
   emitCollectionItemAdded({
      type: ITEM_ADDED_EVENT,
      collectionId: collection.id,
      slug: collection.slug,
      keyId: item.keyId,
      position: item.position,
      notes: item.notes,
      addedAt: new Date().toISOString(),
   });

   return item;
}

export async function removeItemFromCollection(
   _editorWallet: string,
   slug: string,
   keyId: string
) {
   const normalizedSlug = slug.trim().toLowerCase();
   const collection = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (!collection) {
      throw new CollectionNotFoundError(normalizedSlug);
   }

   return prisma.collectionItem.deleteMany({
      where: {
         collectionId: collection.id,
         keyId,
      },
   });
}

export async function reorderCollectionItems(
   _editorWallet: string,
   slug: string,
   reorders: ReorderItemInput[]
) {
   const normalizedSlug = slug.trim().toLowerCase();
   const collection = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (!collection) {
      throw new CollectionNotFoundError(normalizedSlug);
   }

   // Unique positions constraint verification
   const positions = new Set(reorders.map(r => r.position));
   if (positions.size !== reorders.length) {
      throw new Error('Positions must be unique');
   }

   // Update within transaction
   return prisma.$transaction(async tx => {
      // Step 1: Temporarily shift positions to negative to prevent collision on unique constraint
      for (let i = 0; i < reorders.length; i++) {
         const r = reorders[i];
         await tx.collectionItem.updateMany({
            where: { collectionId: collection.id, keyId: r.keyId },
            data: { position: -(i + 1000) },
         });
      }

      // Step 2: Assign final target positions
      for (const r of reorders) {
         await tx.collectionItem.updateMany({
            where: { collectionId: collection.id, keyId: r.keyId },
            data: { position: r.position },
         });
      }

      return tx.collectionItem.findMany({
         where: { collectionId: collection.id },
         orderBy: { position: 'asc' },
      });
   });
}

export async function setCollectionPublishStatus(
   _editorWallet: string,
   slug: string,
   published: boolean
) {
   const normalizedSlug = slug.trim().toLowerCase();
   const collection = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (!collection) {
      throw new CollectionNotFoundError(normalizedSlug);
   }

   return prisma.collection.update({
      where: { id: collection.id },
      data: { published },
   });
}

export async function followCollection(wallet: string, slug: string) {
   const normalizedSlug = slug.trim().toLowerCase();
   const collection = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (!collection) {
      throw new CollectionNotFoundError(normalizedSlug);
   }

   // Check if already followed (idempotent)
   const existingFollow = await prisma.collectionFollow.findUnique({
      where: {
         collectionId_wallet: {
            collectionId: collection.id,
            wallet,
         },
      },
   });

   if (existingFollow) {
      return { followed: true, followerCount: collection.followerCount };
   }

   const [updatedCollection] = await prisma.$transaction([
      prisma.collection.update({
         where: { id: collection.id },
         data: { followerCount: { increment: 1 } },
      }),
      prisma.collectionFollow.create({
         data: {
            collectionId: collection.id,
            wallet,
         },
      }),
   ]);

   return { followed: true, followerCount: updatedCollection.followerCount };
}

export async function unfollowCollection(wallet: string, slug: string) {
   const normalizedSlug = slug.trim().toLowerCase();
   const collection = await prisma.collection.findUnique({
      where: { slug: normalizedSlug },
   });
   if (!collection) {
      throw new CollectionNotFoundError(normalizedSlug);
   }

   const existingFollow = await prisma.collectionFollow.findUnique({
      where: {
         collectionId_wallet: {
            collectionId: collection.id,
            wallet,
         },
      },
   });

   if (!existingFollow) {
      return { followed: false, followerCount: collection.followerCount };
   }

   const [updatedCollection] = await prisma.$transaction([
      prisma.collection.update({
         where: { id: collection.id },
         data: { followerCount: { decrement: 1 } },
      }),
      prisma.collectionFollow.delete({
         where: {
            collectionId_wallet: {
               collectionId: collection.id,
               wallet,
            },
         },
      }),
   ]);

   return { followed: false, followerCount: updatedCollection.followerCount };
}
