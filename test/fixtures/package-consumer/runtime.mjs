import assert from 'node:assert/strict';
import {
  DecisionSession,
  DecisionProgram,
  defineRouter,
  route,
  runTree,
  slot,
  complete,
} from 'jev-code';

assert.equal(typeof DecisionSession, 'function');
assert.equal(typeof DecisionProgram, 'function');
assert.equal(typeof defineRouter, 'function');
assert.equal(typeof route, 'function');
assert.equal(typeof runTree, 'function');
assert.equal(typeof slot, 'function');
assert.equal(typeof complete, 'function');
