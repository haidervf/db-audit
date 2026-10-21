import { useEffect, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { MSSQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutterLineClass } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export type LineRange = [number, number];

interface Highlight {
  selected: LineRange | null;
  hover: LineRange[];
}

const setHighlight = StateEffect.define<Highlight>();

const highlightField = StateField.define<Highlight>({
  create: () => ({ selected: null, hover: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) value = e.value;
    return value;
  },
});

const selectedLine = Decoration.line({ class: 'cm-hl-selected' });
const hoverLine = Decoration.line({ class: 'cm-hl-hover' });

class HlGutterMarker extends GutterMarker {
  elementClass = 'cm-hl-gutter';
}
const hlGutterMarker = new HlGutterMarker();

function clampRange(r: LineRange, lines: number): LineRange | null {
  const a = Math.max(1, Math.min(r[0], r[1]));
  const b = Math.min(lines, Math.max(r[0], r[1]));
  return a > lines || b < 1 ? null : [a, b];
}

const highlightDecorations = EditorView.decorations.compute([highlightField], (state) => {
  const hl = state.field(highlightField);
  const ranges: Range<Decoration>[] = [];
  const n = state.doc.lines;
  const add = (r: LineRange, deco: Decoration) => {
    const c = clampRange(r, n);
    if (!c) return;
    for (let l = c[0]; l <= c[1]; l++) ranges.push(deco.range(state.doc.line(l).from));
  };
  if (hl.selected) add(hl.selected, selectedLine);
  for (const h of hl.hover) add(h, hoverLine);
  return Decoration.set(ranges, true);
});

const highlightGutter = gutterLineClass.compute([highlightField], (state) => {
  const hl = state.field(highlightField);
  const n = state.doc.lines;
  const marks: Range<GutterMarker>[] = [];
  if (hl.selected) {
    const c = clampRange(hl.selected, n);
    if (c) for (let l = c[0]; l <= c[1]; l++) marks.push(hlGutterMarker.range(state.doc.line(l).from));
  }
  return RangeSet.of(marks, true);
});

/** Light/dark aware theme driven by CSS variables (tokens.css), so it follows the app theme without re-creating the editor. */
const cssVarTheme: Extension = [
  EditorView.theme({
    '&': { backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
    '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'transparent', padding: '6px 0' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--code-gutter-bg)', color: 'var(--code-gutter-fg)', borderRight: '1px solid var(--border)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '36px' },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 4px 0 0' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--focus) !important' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: '1px solid var(--border)', color: 'var(--text-3)' },
    '.cm-searchMatch': { backgroundColor: 'var(--code-hl-hover)', outline: '1px solid var(--code-hl-hover-edge)' },
    '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--syn-keyword)', fontWeight: '600' },
      { tag: [t.typeName, t.standard(t.name), t.special(t.name)], color: 'var(--syn-type)' },
      { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
      { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
      { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
      { tag: [t.variableName, t.special(t.variableName)], color: 'var(--text)' },
      { tag: [t.labelName], color: 'var(--syn-variable)' },
      { tag: [t.function(t.variableName)], color: 'var(--syn-function)' },
      { tag: [t.operator, t.punctuation, t.paren, t.bracket], color: 'var(--syn-operator)' },
    ]),
  ),
];

const baseExtensions: Extension[] = [
  sql({ dialect: MSSQL, upperCaseKeywords: true }),
  EditorView.editable.of(false),
  highlightField,
  highlightDecorations,
  highlightGutter,
];

const basicSetup = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  bracketMatching: false,
  closeBrackets: false,
  highlightSelectionMatches: false,
  crosshairCursor: false,
  rectangularSelection: false,
  dropCursor: false,
  indentOnInput: false,
  searchKeymap: true,
};

/**
 * Read-only T-SQL viewer (MSSQL dialect, line numbers) with two highlight layers:
 * `selected` (outline / step selection; scrolled into view) and `hover` (e.g. a table chip's statements).
 */
export function CodeView({
  code,
  selected,
  hover,
  maxHeight = 'calc(100vh - 250px)',
  minHeight,
  testId,
  scrollKey,
}: {
  code: string;
  selected: LineRange | null;
  hover?: LineRange[];
  maxHeight?: string;
  minHeight?: string;
  testId?: string;
  /** changes whenever the selection should be scrolled into view again (even if the range is unchanged) */
  scrollKey?: number;
}) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  const hoverKey = JSON.stringify(hover ?? []);
  const selKey = selected ? `${selected[0]}-${selected[1]}` : '';

  const apply = (view: EditorView, scroll: boolean) => {
    const effects: StateEffect<unknown>[] = [setHighlight.of({ selected, hover: hover ?? [] })];
    if (scroll && selected) {
      const c = clampRange(selected, view.state.doc.lines);
      if (c) effects.push(EditorView.scrollIntoView(view.state.doc.line(c[0]).from, { y: 'center' }));
    }
    view.dispatch({ effects });
  };

  useEffect(() => {
    const view = ref.current?.view;
    if (view) apply(view, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, scrollKey]);

  useEffect(() => {
    const view = ref.current?.view;
    if (view) apply(view, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverKey]);

  const extensions = useMemo(() => baseExtensions, []);

  return (
    <div data-testid={testId} data-highlight={selKey || undefined} className="code-view">
      <CodeMirror
        ref={ref}
        value={code}
        readOnly
        editable={false}
        theme={cssVarTheme}
        basicSetup={basicSetup}
        extensions={extensions}
        maxHeight={maxHeight}
        minHeight={minHeight}
        onCreateEditor={(view) => apply(view, true)}
      />
    </div>
  );
}
