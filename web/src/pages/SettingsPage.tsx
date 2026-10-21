import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { useAiStatus, useSaveAiSettings } from '../api/hooks';
import type { AiEffort } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, Callout, ConfirmButton, Loading, Segmented, Spinner } from '../components/ui';
import { readStored, writeStored } from '../lib/storage';
import { useTheme, type ThemePref } from '../lib/theme';

const EFFORTS: Array<{ value: AiEffort; label: string; hint: string }> = [
  { value: 'low', label: 'Low', hint: 'fastest, cheapest' },
  { value: 'medium', label: 'Medium', hint: 'balanced' },
  { value: 'high', label: 'High', hint: 'more thorough' },
  { value: 'xhigh', label: 'Extra high', hint: 'deepest reasoning, slowest' },
];

const DEFAULT_MODEL = 'claude-opus-5-5';

function AiSettings() {
  const status = useAiStatus();
  const save = useSaveAiSettings();
  const [key, setKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<AiEffort>('high');
  const [saved, setSaved] = useState<string | null>(null);
  const st = status.data;

  useEffect(() => {
    if (st) {
      setModel(st.model || DEFAULT_MODEL);
      setEffort(st.effort);
    }
  }, [st]);
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(null), 4000);
    return () => window.clearTimeout(t);
  }, [saved]);

  if (status.isLoading) return <Loading label="Reading AI settings…" />;
  if (status.error) return <Callout tone="danger" title="Could not read the AI status">{errorMessage(status.error)}</Callout>;
  if (!st)
    return (
      <Callout tone="info" title="AI endpoints not available">
        The connected db-audit server does not expose <code>/api/ai</code> yet. Update the server to configure AI explanations.
      </Callout>
    );

  const submit = (input: Parameters<typeof save.mutate>[0], note: string) =>
    save.mutate(input, {
      onSuccess: () => {
        setSaved(note);
        setKey('');
      },
    });

  return (
    <div className="stack-md" data-testid="ai-settings">
      <div className="row">
        <span className="field-label" style={{ minWidth: 90 }}>
          Status
        </span>
        {st.configured ? <Badge tone="ok">configured</Badge> : <Badge tone="warn">not configured</Badge>}
        {st.keySource ? (
          <span className="small muted">
            key from {st.keySource === 'env' ? 'the ANTHROPIC_API_KEY environment variable' : 'db-audit settings (data/settings.json)'}
          </span>
        ) : (
          <span className="small muted">no API key</span>
        )}
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) submit({ apiKey: key.trim() }, 'API key saved.');
        }}
      >
        <span className="field-label">Anthropic API key</span>
        <div className="row">
          <input
            className="input mono grow"
            type="password"
            autoComplete="off"
            placeholder={st.keySource === 'settings' ? 'saved — enter a new key to replace it' : 'sk-ant-…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ maxWidth: 440 }}
            data-testid="ai-key"
          />
          <button className="btn btn-primary" type="submit" disabled={!key.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : <Icon name="key" size={13} />} Save key
          </button>
          {st.keySource === 'settings' ? (
            <ConfirmButton label="Clear key" confirmLabel="Remove saved key" className="btn" busy={save.isPending} onConfirm={() => submit({ apiKey: null }, 'API key removed.')} />
          ) : null}
        </div>
        <span className="field-hint">
          Write-only: the key is stored on this machine by the db-audit server and never sent back to the browser.
          {st.keySource === 'env' ? ' The environment variable is used while no key is saved here.' : ''}
        </span>
      </form>
      <div className="field-grid" style={{ gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)' }}>
        <label className="field">
          <span className="field-label">Model</span>
          <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} data-testid="ai-model" />
          <span className="field-hint">Default {DEFAULT_MODEL}</span>
        </label>
        <div className="field">
          <span className="field-label">Effort</span>
          <Segmented<AiEffort> label="Effort" value={effort} onChange={setEffort} options={EFFORTS.map((e) => ({ value: e.value, label: e.label }))} />
          <span className="field-hint">{EFFORTS.find((e) => e.value === effort)?.hint}</span>
        </div>
      </div>
      <div className="row">
        <button
          className="btn"
          onClick={() => submit({ model: model.trim() || DEFAULT_MODEL, effort }, 'Model and effort saved.')}
          disabled={save.isPending || (model === st.model && effort === st.effort)}
          data-testid="ai-save"
        >
          Save model &amp; effort
        </button>
        {saved ? (
          <span className="small" style={{ color: 'var(--ok)' }}>
            <Icon name="check" size={13} /> {saved}
          </span>
        ) : null}
      </div>
      {save.error ? <Callout tone="danger" title="Could not save">{errorMessage(save.error)}</Callout> : null}
      <div className="small muted">
        Generating an explanation sends that object’s source code and the names/types of the tables it references to Anthropic’s API. You are asked to confirm once per browser.
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { pref, setPref } = useTheme();
  const [consent, setConsent] = useState(() => readStored('aiConsent') === '1');
  return (
    <div className="page" style={{ maxWidth: 900 }} data-testid="settings-page">
      <div className="page-header">
        <div className="grow">
          <h1 className="page-title">Settings</h1>
          <div className="page-subtitle">AI explanations and appearance.</div>
        </div>
      </div>
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <Icon name="sparkles" />
          <h3>AI explanations</h3>
        </div>
        <div className="card-body">
          <AiSettings />
        </div>
      </section>
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <Icon name={pref === 'dark' ? 'moon' : 'sun'} />
          <h3>Appearance</h3>
        </div>
        <div className="card-body row">
          <span className="field-label" style={{ minWidth: 90 }}>
            Theme
          </span>
          <Segmented<ThemePref>
            label="Theme"
            value={pref}
            onChange={setPref}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </section>
      <section className="card">
        <div className="card-header">
          <Icon name="lock" />
          <h3>Privacy</h3>
        </div>
        <div className="card-body row">
          <span className="grow small text-2">
            {consent ? 'You have agreed to send code to Anthropic for AI explanations in this browser.' : 'You have not yet agreed to send code to Anthropic in this browser.'}
          </span>
          {consent ? (
            <button
              className="btn btn-sm"
              onClick={() => {
                writeStored('aiConsent', null);
                setConsent(false);
              }}
            >
              Reset consent
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
