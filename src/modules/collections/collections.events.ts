// src/modules/collections/collections.events.ts
// Internal event bus for curated collections (#1353).

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.utils';

export const ITEM_ADDED_EVENT = 'collection.item_added';

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(50);

export interface CollectionItemAddedEvent {
   type: typeof ITEM_ADDED_EVENT;
   collectionId: string;
   slug: string;
   keyId: string;
   position: number;
   notes?: string | null;
   addedAt: string;
}

export function onCollectionItemAdded(
   handler: (payload: CollectionItemAddedEvent) => void
): () => void {
   eventEmitter.on(ITEM_ADDED_EVENT, handler);
   return () => {
      eventEmitter.off(ITEM_ADDED_EVENT, handler);
   };
}

export function emitCollectionItemAdded(payload: CollectionItemAddedEvent): void {
   try {
      eventEmitter.emit(ITEM_ADDED_EVENT, payload);
      logger.info(
         {
            event: ITEM_ADDED_EVENT,
            collectionId: payload.collectionId,
            slug: payload.slug,
            keyId: payload.keyId,
            position: payload.position,
         },
         'Collection item added event emitted'
      );
   } catch (error) {
      logger.error({ error }, 'Failed to emit collection.item_added event');
   }
}
