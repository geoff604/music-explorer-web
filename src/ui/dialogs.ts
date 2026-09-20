import { formatTicks, smpteToTicks, ticksToSmpte } from '../core/AudioTime';
import type { TickSelection } from './WaveformView';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

export function showAbout(): void {
  el<HTMLDialogElement>('about-dialog').showModal();
}

export interface RangeDialogInput {
  fileName: string;
  lengthTicks: number;
  selection: TickSelection | null;
}

const FIELDS = {
  start: ['sh', 'sm', 'ss', 'sf'],
  end: ['eh', 'em', 'es', 'ef'],
} as const;

/**
 * The Select Range dialog (IDD_SELECTRANGEDIALOG). Resolves with the chosen range in ticks, or
 * null if cancelled.
 *
 * Unlike the original, which accepted any values (a listed Known Issue), this requires the end
 * to be after the start and the range to lie inside the file.
 */
export function selectRange(input: RangeDialogInput): Promise<TickSelection | null> {
  const dialog = el<HTMLDialogElement>('range-dialog');
  const form = el<HTMLFormElement>('range-form');
  const error = el<HTMLElement>('range-error');
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

  el<HTMLElement>('range-file').textContent = input.fileName;
  el<HTMLOutputElement>('range-length').textContent = formatTicks(input.lengthTicks);

  const fill = (names: readonly string[], ticks: number) => {
    const t = ticksToSmpte(ticks);
    const values = [t.hours, t.minutes, t.seconds, t.frames];
    names.forEach((n, i) => (field(n).value = String(values[i])));
  };
  const read = (names: readonly string[]) => {
    const [hours, minutes, seconds, frames] = names.map((n) => field(n).valueAsNumber) as [
      number,
      number,
      number,
      number,
    ];
    return smpteToTicks({ hours, minutes, seconds, frames });
  };

  fill(FIELDS.start, input.selection?.start ?? 0);
  fill(FIELDS.end, input.selection?.end ?? 0);
  error.hidden = true;

  return new Promise((resolve) => {
    let result: TickSelection | null = null;

    const onSubmit = (e: SubmitEvent) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const start = read(FIELDS.start);
      const end = read(FIELDS.end);
      if (end <= start) return fail('The end time must be after the start time.');
      if (start >= input.lengthTicks) return fail(`The start time is past the end of the file (${formatTicks(input.lengthTicks)}).`);
      if (end > input.lengthTicks) return fail(`The end time is past the end of the file (${formatTicks(input.lengthTicks)}).`);
      result = { start, end };
      dialog.close();
    };
    const fail = (message: string) => {
      error.textContent = message;
      error.hidden = false;
    };
    const onCancel = () => dialog.close();
    const onClose = () => {
      form.removeEventListener('submit', onSubmit);
      el('range-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      resolve(result);
    };

    form.addEventListener('submit', onSubmit);
    el('range-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    field('sh').select();
  });
}
