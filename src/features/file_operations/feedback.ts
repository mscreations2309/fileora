import { router } from 'expo-router';

import { presentError } from '@/core/errors/FileoraError';
import { formatCount } from '@/core/format/format';
import { showToast } from '@/shared/components/overlays';

import { undoOperation } from './actions';
import type { OperationResult } from './types';

const PAST_TENSE: Record<string, string> = {
  copy: 'Copied',
  move: 'Moved',
  trash: 'Moved to Trash',
  delete: 'Deleted',
  restore: 'Restored',
  rename: 'Renamed',
  createFolder: 'Created',
  undo: 'Undone',
};

function items(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Turns an operation result into an accurate, accessible message. Success is only reported for
 * what actually completed; partial results say exactly how many items failed and why.
 */
export function reportResult(
  kind: keyof typeof PAST_TENSE,
  attempted: number,
  result: OperationResult & { operationId?: string; skippedNames?: string[] },
  reversible = true,
): void {
  const verb = PAST_TENSE[kind] ?? 'Done';
  const failed = result.failures.length;
  const skipped = result.skipped;
  const undo =
    reversible && result.operationId && (result.status === 'completed' || result.status === 'partial')
      ? {
          label: 'Undo',
          onPress: () => {
            const id = result.operationId;
            if (!id) return;
            void undoOperation(id).then((undone) => reportResult('undo', 1, undone, false));
          },
        }
      : undefined;

  switch (result.status) {
    case 'completed': {
      const done = Math.max(0, attempted - skipped);
      const message =
        done === 0 && skipped > 0
          ? `Nothing to do — ${items(skipped)} skipped`
          : `${verb} ${kind === 'undo' ? '' : items(done)}${skipped > 0 ? `, ${formatCount(skipped)} skipped` : ''}`.trim();
      showToast(message, 'success', undo);
      return;
    }
    case 'partial': {
      const reason = result.failures[0]?.error ?? result.error;
      showToast(
        `${verb} with problems: ${formatCount(failed)} failed${reason ? ` — ${presentError(reason).title.toLowerCase()}` : ''}.`,
        'error',
        { label: 'Details', onPress: () => router.push('/history') },
      );
      return;
    }
    case 'cancelled':
      showToast('Cancelled. Items finished before cancelling were kept.', 'neutral', { label: 'Details', onPress: () => router.push('/history') });
      return;
    case 'failed': {
      const error = result.error ?? result.failures[0]?.error;
      const presentation = error ? presentError(error) : null;
      showToast(presentation ? `${presentation.title}. ${presentation.guidance}` : 'The operation failed.', 'error');
      return;
    }
  }
}
