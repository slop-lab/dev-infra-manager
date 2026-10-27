import {expect,it} from 'vitest';
import {createCancellationState} from '../../../../packages/web/plugins/execution/src/assets/cancellation.js';
it('retains unknown cancellation when an older list read finishes',()=>{
  const state=createCancellationState(), old=state.beginRead(); state.unknown('local/job');
  state.reconcile('local/job',old,{phase:'queued'}); expect(state.locked('local/job')).toBe(true);
  state.reconcile('local/job',state.beginRead(),{phase:'recovering',cancelRequestedAt:1}); expect(state.outcome('local/job')).toBe('observed');
});
it('keeps a known accepted cancellation locked regardless of later detail failures or old summaries',()=>{
  const state=createCancellationState(); state.accepted('local/job');
  state.reconcile('local/job',state.beginRead(),{phase:'queued'}); expect(state.locked('local/job')).toBe(true);
});
it('allows a separate cancellation only after a fresh authoritative list shows no request',()=>{
  const state=createCancellationState(); state.unknown('local/job');
  state.reconcile('local/job',state.beginRead(),{phase:'queued'}); expect(state.locked('local/job')).toBe(false);
});
