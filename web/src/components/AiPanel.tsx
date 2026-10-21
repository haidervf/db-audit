import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage, isApiError } from '../api/client';
import { useAiStatus, useDescribe } from '../api/hooks';
import type { AiDescription, ObjectKind } from '../api/types';
import { fmtDateTime, fmtNumber } from '../lib/format';
import { readStored, writeStored } from '../lib/storage';
import type { LineRange } from './CodeView';
import { Icon } from './Icon';
import { Callout, Dialog, Empty, Loading, Spinner } from './ui';

/** Parses an AI step's `lines` ("12", "12-20", "L12–L20", "12-14, 20") into the first range. */
export function parseLines(s: string): LineRange | null {
  const m = /(\d+)\s*(?:[-–—]|to)?\s*L?(\d+)?/i.exec(s.replace(/lines?\s*/i, ''));
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return a > 0 ? [Math.min(a, b), Math.max(a, b)] : null;
}

const CONSENT_KEY = 'aiConsent';

/** First-use consent for sending data to Anthropic (shared by every AI feature; stored once per browser). */
export function useConsent(): [boolean, () => void] {
  const [ok, setOk] = useState(() => readStored(CONSENT_KEY) === '1');
  return [
    ok,
    () => {
      writeStored(CONSENT_KEY, '1');
      setOk(true);
    },
  ];
}

export function Elapsed() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setS((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="mono">{s}s</span>;
}

/** Title for an AI request error, by HTTP status (same statuses for every AI endpoint). */
export function aiErrorTitle(err: unknown, refused: string, failed: string): string {
  if (!err) return '';
  return isApiError(err, 400)
    ? 'AI is not configured'
    : isApiError(err, 422)
      ? refused
      : isApiError(err, 429)
        ? 'Rate limited by the AI API'
        : isApiError(err, 502)
          ? 'The AI API returned an error'
          : failed;
}

/** `model · effort · generated <time> · tokens` line of an AI result. */
export function aiMetaText(r: { model: string; effort: string; createdAt: string; usage: { inputTokens: number; outputTokens: number } | null }): string {
  return `${r.model} · ${r.effort} effort · generated ${fmtDateTime(r.createdAt)}${r.usage ? ` · ${fmtNumber(r.usage.inputTokens)} in / ${fmtNumber(r.usage.outputTokens)} out tokens` : ''}`;
}

export function AiConsentDialog({
  open,
  onClose,
  onContinue,
  title = 'Send code to Anthropic?',
  children,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" data-autofocus onClick={onContinue}>
            I understand, continue
          </button>
        </>
      }
    >
      <div className="dialog-body stack-md">
        {children}
        <p className="muted small" style={{ margin: 0 }}>
          No data rows are sent. The result is cached locally with the connection. You will only be asked once in this browser.
        </p>
      </div>
    </Dialog>
  );
}

export function AiPanel({
  connId,
  target,
  ai,
  hasSource,
  onShowLines,
  subject,
}: {
  connId: string;
  target: { type: 'object'; kind: ObjectKind; schema: string; name: string } | { type: 'job'; jobId: string };
  ai: AiDescription | null | undefined;
  hasSource: boolean;
  onShowLines?: (r: LineRange) => void;
  subject: string;
}) {
  const status = useAiStatus();
  const describe = useDescribe(connId, target);
  const [consented, giveConsent] = useConsent();
  const [askConsent, setAskConsent] = useState<null | boolean>(null);
  const current = describe.data ?? ai ?? null;

  const run = (force: boolean) => {
    if (!consented) {
      setAskConsent(force);
      return;
    }
    describe.mutate(force);
  };

  if (status.isLoading) return <Loading label="Checking AI configuration…" />;
  if (status.error) return <Callout tone="danger" title="Could not read the AI status">{errorMessage(status.error)}</Callout>;
  const st = status.data;

  const consentDialog = (
    <AiConsentDialog
      open={askConsent !== null}
      onClose={() => setAskConsent(null)}
      onContinue={() => {
        const force = askConsent ?? false;
        giveConsent();
        setAskConsent(null);
        describe.mutate(force);
      }}
    >
      <p style={{ margin: 0 }}>
        This sends this object&apos;s source code and the names/types of the tables it references to Anthropic&apos;s API to generate the explanation.
      </p>
    </AiConsentDialog>
  );

  if (!st) {
    return (
      <Empty
        icon="sparkles"
        title="AI explanations are not available on this server"
        body="The connected db-audit server does not expose the AI endpoints yet. Update the server to use this feature."
      />
    );
  }

  if (!st.configured && !current) {
    return (
      <Empty
        icon="sparkles"
        title="AI not configured — add a key in Settings"
        body="Add an Anthropic API key in Settings (or set ANTHROPIC_API_KEY for the server) to generate line-by-line explanations."
        action={
          <Link className="btn btn-primary" to="/settings">
            Open Settings
          </Link>
        }
      />
    );
  }

  if (!hasSource) {
    return <Empty icon="lock" title="No source code to explain" body="The definition is not available (encrypted, CLR or no VIEW DEFINITION)." />;
  }

  const err = describe.error;
  const errTitle = aiErrorTitle(err, 'The model declined to describe this code', 'Could not generate the explanation');

  if (describe.isPending) {
    return (
      <div className="card" data-testid="ai-loading">
        <div className="empty">
          <Spinner large />
          <div className="empty-title">Generating explanation…</div>
          <div className="empty-body">
            Asking {st.model} ({st.effort} effort) to explain {subject}. This can take a minute. <Elapsed />
          </div>
        </div>
        {consentDialog}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="stack-md">
        {err ? <Callout tone="danger" title={errTitle}>{errorMessage(err)}</Callout> : null}
        <div className="card">
          <Empty
            icon="sparkles"
            title="Explain with AI"
            body={`Generate a plain-language, step-by-step explanation of ${subject}, with the data it reads and writes and potential risks. Uses ${st.model} (${st.effort} effort).`}
            action={
              <button className="btn btn-primary" onClick={() => run(false)} data-testid="ai-describe">
                <Icon name="sparkles" size={14} /> Describe with AI
              </button>
            }
          />
        </div>
        {consentDialog}
      </div>
    );
  }

  const c = current.content;
  return (
    <div className="stack-md" data-testid="ai-result">
      {err ? <Callout tone="danger" title={errTitle}>{errorMessage(err)}</Callout> : null}
      {current.stale ? (
        <Callout
          tone="warn"
          title="The code changed since this explanation was generated"
          action={
            <button className="btn btn-sm" onClick={() => run(true)} disabled={!st.configured}>
              <Icon name="refresh" size={13} /> Regenerate
            </button>
          }
        >
          The explanation may no longer match the current definition.
        </Callout>
      ) : null}
      <div className="card">
        <div className="card-body stack-md">
          <div className="ai-section">
            <h4>Summary</h4>
            <div className="ai-summary">{c.summary}</div>
          </div>
          {c.purpose ? (
            <div className="ai-section">
              <h4>Purpose</h4>
              <div className="text-2">{c.purpose}</div>
            </div>
          ) : null}
        </div>
      </div>

      {c.steps.length ? (
        <div className="card">
          <div className="card-header">
            <h3>Step by step</h3>
            <span className="muted small">click a line range to see it in the code</span>
          </div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {c.steps.map((s, i) => {
              const r = parseLines(s.lines);
              return (
                <div className="ai-step" key={i}>
                  <div>
                    {r && onShowLines ? (
                      <button className="line-link" style={{ fontSize: 12 }} onClick={() => onShowLines(r)} title="Show in code">
                        L{s.lines.replace(/^L/i, '')}
                      </button>
                    ) : (
                      <span className="mono xsmall muted">{s.lines}</span>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.title}</div>
                    <div className="text-2">{s.explanation}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3>Data access</h3>
          </div>
          {c.dataAccess.length ? (
            <div className="table-wrap">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th>Access</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {c.dataAccess.map((d, i) => (
                    <tr key={i}>
                      <td className="mono">{d.object}</td>
                      <td className="nowrap">{d.access}</td>
                      <td className="text-2">{d.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card-body muted small">None.</div>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h3>Calls</h3>
          </div>
          {c.calls.length ? (
            <ul className="list-plain" style={{ padding: '4px 0' }}>
              {c.calls.map((d, i) => (
                <li key={i} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}>
                  <span className="mono small">{d.object}</span>
                  <span className="text-2 small">{d.why}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="card-body muted small">None.</div>
          )}
        </div>
      </div>

      {c.risks.length ? (
        <div className="card">
          <div className="card-header">
            <h3>Risks</h3>
          </div>
          <div className="card-body stack-sm">
            {c.risks.map((r, i) => (
              <div className="risk" key={i}>
                <Icon name="alert" size={14} />
                <span>{r}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {c.notes.length ? (
        <div className="card">
          <div className="card-header">
            <h3>Notes</h3>
          </div>
          <ul className="card-body" style={{ margin: 0, paddingLeft: 30 }}>
            {c.notes.map((n, i) => (
              <li key={i} className="text-2" style={{ marginBottom: 4 }}>
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="row small muted" style={{ flexWrap: 'wrap' }}>
        <span>{aiMetaText(current)}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => run(true)} disabled={!st.configured} title={st.configured ? undefined : 'AI not configured'}>
          <Icon name="refresh" size={13} /> Regenerate
        </button>
      </div>
      {consentDialog}
    </div>
  );
}
