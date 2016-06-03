// @flow

// Copyright 2016 The Noms Authors. All rights reserved.
// Licensed under the Apache License, version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0

import {invariant} from './assert.js';
import {equals, less} from './compare.js';
import {OrderedSequence, OrderedSequenceCursor} from './ordered-sequence.js';
import {SequenceCursor} from './sequence.js';
import type Value from './value.js'; // eslint-disable-line no-unused-vars

// TODO: Expose an iteration API.

/**
 * Returns a 3-tuple [added, removed, modified] sorted keys.
 */
export default async function diff<K: Value, T>(
    last: OrderedSequence<K, T>, current: OrderedSequence<K, T>):
    Promise<[Array<K>, Array<K>, Array<K>]> {
  // TODO: Construct the cursor at exactly the right position. There is no point reading in the
  // first chunk of each sequence if we're not going to use them. This needs for chunks (or at
  // least meta chunks) to encode their height.
  // See https://github.com/attic-labs/noms/issues/1219.
  const [lastCur, currentCur] = await Promise.all([last.newCursorAt(), current.newCursorAt()]);
  const [added, removed, modified] = [[], [], []];

  while (lastCur.valid && currentCur.valid) {
    await fastForward(lastCur, currentCur);

    while (lastCur.valid && currentCur.valid &&
           !lastCur.sequence.equalsAt(lastCur.idx, currentCur.getCurrent())) {
      const lastKey = lastCur.getCurrentKey(), currentKey = currentCur.getCurrentKey();

      if (equals(lastKey, currentKey)) {
        modified.push(lastKey);
        await Promise.all([lastCur.advance(), currentCur.advance()]);
      } else if (less(lastKey, currentKey)) {
        removed.push(lastKey);
        await lastCur.advance();
      } else {
        added.push(currentKey);
        await currentCur.advance();
      }
    }
  }

  for (; lastCur.valid; await lastCur.advance()) {
    removed.push(lastCur.getCurrentKey());
  }
  for (; currentCur.valid; await currentCur.advance()) {
    added.push(currentCur.getCurrentKey());
  }

  return [added, removed, modified];
}

/**
 * Advances |a| and |b| past their common sequence of equal values.
 */
export function fastForward(a: OrderedSequenceCursor, b: OrderedSequenceCursor): Promise<void> {
  return a.valid && b.valid ? doFastForward(true, a, b).then() : Promise.resolve();
}

/*
 * Returns an array matching |a| and |b| respectively to whether that cursor has more values.
 */
async function doFastForward(allowPastEnd: boolean,
                             a: OrderedSequenceCursor, b: OrderedSequenceCursor):
                             Promise<[boolean, boolean]> {
  invariant(a.valid && b.valid);
  let aHasMore = true, bHasMore = true;

  while (aHasMore && bHasMore && isCurrentEqual(a, b)) {
    const aParent = a.parent, bParent = b.parent;

    if (aParent && bParent && isCurrentEqual(aParent, bParent)) {
      // Key optimisation: if the sequences have common parents, then entire chunks can be
      // fast-forwarded without reading unnecessary data.
      invariant(aParent instanceof OrderedSequenceCursor);
      invariant(bParent instanceof OrderedSequenceCursor);
      [aHasMore, bHasMore] = await doFastForward(false, aParent, bParent);

      const syncWithIdx = (cur, hasMore) => cur.sync().then(() => {
        if (hasMore) {
          cur.idx = 0;
        } else if (allowPastEnd) {
          cur.idx = cur.length;
        } else {
          cur.idx = cur.length - 1;
        }
      });
      await Promise.all([syncWithIdx(a, aHasMore), syncWithIdx(b, bHasMore)]);
    } else {
      if (a.canAdvanceLocal() && b.canAdvanceLocal()) {
        // Performance optimisation: allowing non-async resolution of leaf elements
        aHasMore = a.advanceLocal(allowPastEnd);
        bHasMore = b.advanceLocal(allowPastEnd);
      } else {
        await Promise.all([a.advance(allowPastEnd), b.advance(allowPastEnd)]).then(([am, bm]) => {
          aHasMore = am;
          bHasMore = bm;
        });
      }
    }
  }

  return [aHasMore, bHasMore];
}

function isCurrentEqual(a: SequenceCursor, b: SequenceCursor): boolean {
  return a.sequence.equalsAt(a.idx, b.getCurrent());
}
