import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../src/service.js';

const unavailableDatabase = {collection() { throw Error('Database should not be accessed.'); }};

test('an unauthenticated caller is rejected before database access', async () => {
  await assert.rejects(createService(unavailableDatabase).book(null, {}), error => error.code === 'unauthenticated');
});

test('resident cannot invoke any administrator operation', async () => {
  const service = createService(unavailableDatabase);
  for (const operation of ['maintenance', 'resolve', 'resolveReport']) {
    await assert.rejects(service[operation]({uid: 'resident', isAdmin: false}, {}), error => error.code === 'permission-denied');
  }
});

test('a user cannot inject a document path into a request key', async () => {
  await assert.rejects(createService(unavailableDatabase).book({uid: '../admin'}, {requestId: 'request'}), error => error.code === 'invalid-argument');
});
