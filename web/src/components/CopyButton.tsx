import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { copyText } from '../lib/clipboard';
import { Icon } from './Icon';

/**
 * Copy-to-clipboard button with a short "Copied" state (~1.5 s). Without `label` it renders as a small icon button.
 * `text` may be a function so large texts are only built on click.
 */
export function CopyButton({ text, label, title = 'Copy', testId }: { text: string | (() => string); label?: string; title?: string; testId?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async (e: MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(typeof text === 'function' ? text() : text);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1500);
  };
  const tip = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : title;
  const icon = state === 'copied' ? 'check' : state === 'failed' ? 'x' : 'copy';
  if (label) {
    return (
      <button type="button" className="btn btn-ghost btn-xs" onClick={onClick} title={tip} data-testid={testId} data-state={state}>
        <Icon name={icon} size={12} />
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </button>
    );
  }
  return (
    <button type="button" className="icon-btn sm" onClick={onClick} title={tip} aria-label={tip} data-testid={testId} data-state={state}>
      <Icon name={icon} size={13} />
    </button>
  );
}
