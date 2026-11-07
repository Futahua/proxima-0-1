import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/agent-context.js';

// The displayed timeline omits templates; blob context must read them from stored facts.
test('blob context finds templates on stored blobs, not on the display projection', () => {
  const state = { seq: 1, timelineIntervals: [{ id: 'a', name: 'House', rowId: 'r', start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z', deadline: '2026-12-01T00:00:00Z',
    templates: [{ kind: 'as-you-go', version: 2, workspaceId: 'ayg-root', folderId: 'f1' }, { kind: 'appflowy', documentId: 'd1', appflowyWorkspaceId: 'w' }] }] };
  const timeline = [{ id: 'a', name: 'House', rowId: 'r', start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z', deadline: '2026-12-01T00:00:00Z' }];
  const v = globalThis.ProximaAgentContext.query({ state, timeline }, { kind: 'blob-context', name: 'house' });
  assert.deepEqual(v.go, [{ workspace_id: 'ayg-root', folder_id: 'f1', blob_id: 'a' }]);
  assert.equal(v.flow[0].document_id, 'd1');
  assert.equal(v.deadlines.length, 1);
});

// A damaged record without an id must never be returned for a lookup by name.
test('lookup by name ignores id-less records', () => {
  const state = { seq: 1, timelineIntervals: [{ rev: 3, color: '#000000', rowOrder: 1, rowId: 'x' }, { id: 'a', name: 'House', rowId: 'r', start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' }] };
  const v = globalThis.ProximaAgentContext.query({ state, timeline: state.timelineIntervals.filter(x => x.id) }, { kind: 'blob-context', name: 'house' });
  assert.equal(v.blob.id, 'a');
});
