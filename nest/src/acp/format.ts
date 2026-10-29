import { RunRow } from './nest-api';

export function money(usd: number): string {
  if (usd === 0) {
    return '$0';
  }
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function sessionTitle(run: RunRow): string {
  return `${money(run.usd)} · ${run.key} · ${run.status} · ${run.currentStep} · ${when(run.updatedAt)}`;
}

export function flowTitle(flow: { key: string; status: string; currentStep: string; updatedAt: string }): string {
  return `${flow.key} · ${flow.status} · ${flow.currentStep} · ${when(flow.updatedAt)}`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hour = date.getHours();
  const shown = hour % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${months[date.getMonth()]} ${date.getDate()}, ${String(shown).padStart(2, '0')}:${minute} ${suffix}`;
}
