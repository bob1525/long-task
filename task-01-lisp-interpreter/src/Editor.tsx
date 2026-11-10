import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { useEffect, useRef } from 'react';

interface Highlight {
  from: number;
  to: number;
  error: boolean;
}

interface EditorProps {
  source: string;
  highlight: Highlight | null;
  onChange: (source: string) => void;
}

interface ScanState {
  inString: boolean;
}

const KEYWORDS = new Set(['define', 'lambda', 'if', 'cond', 'let', 'let*', 'begin', 'quote', 'set!', 'else']);
const BUILTINS = new Set([
  'cons', 'car', 'cdr', 'list', 'null?', 'pair?', 'list?', 'length', 'append',
  'number?', 'boolean?', 'string?', 'symbol?', 'procedure?', 'eq?', 'equal?', 'not',
  'display', 'write', 'newline', 'modulo', 'remainder', 'abs',
]);

const lispLanguage = StreamLanguage.define<ScanState>({
  name: 'scheme',
  startState: () => ({ inString: false }),
  token(stream, state) {
    if (state.inString) {
      if (stream.eat('\\')) {
        stream.next();
        return 'string';
      }
      if (stream.eat('"')) {
        state.inString = false;
        return 'string';
      }
      stream.next();
      return 'string';
    }
    if (stream.eatSpace()) return null;
    const next = stream.peek();
    if (next === ';') {
      stream.skipToEnd();
      return 'comment';
    }
    if (next === '"') {
      stream.next();
      state.inString = true;
      return 'string';
    }
    if (next === '(' || next === ')') {
      stream.next();
      return 'paren';
    }
    if (next === "'") {
      stream.next();
      return 'operator';
    }
    if (!next) return null;
    stream.next();
    stream.eatWhile(/[^\s()'"`,;]/);
    const word = stream.current();
    if (/^(#t|#f|#true|#false)$/i.test(word)) return 'atom';
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(word)) return 'number';
    if (KEYWORDS.has(word)) return 'keyword';
    if (BUILTINS.has(word)) return 'variableName.standard';
    return 'variableName';
  },
  languageData: {
    commentTokens: { line: ';' },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
});

const lispHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#e4a15a', fontWeight: '600' },
  { tag: tags.comment, color: '#8d8070', fontStyle: 'italic' },
  { tag: tags.string, color: '#d5d6a3' },
  { tag: tags.number, color: '#f0d7a1' },
  { tag: tags.atom, color: '#f0b4a0' },
  { tag: tags.operator, color: '#e7c39a' },
  { tag: tags.paren, color: '#cbbba6' },
  { tag: tags.standard(tags.variableName), color: '#9dcc9a' },
  { tag: tags.variableName, color: '#f6efe4' },
]);

const setHighlight = StateEffect.define<Highlight | null>();

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlight)) continue;
      const value = effect.value;
      if (!value) {
        next = Decoration.none;
        continue;
      }
      const length = transaction.newDoc.length;
      const from = Math.max(0, Math.min(value.from, length));
      const to = Math.max(from, Math.min(value.to, length));
      next =
        from === to
          ? Decoration.none
          : Decoration.set([
              Decoration.mark({ class: value.error ? 'cm-eval-error' : 'cm-eval-current' }).range(from, to),
            ]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: '#f6efe4',
    fontSize: '14px',
  },
  '.cm-scroller': {
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '8px 0 16px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: '#7d7266',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 244, 220, 0.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#e4a15a' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(228, 161, 90, 0.22)',
  },
  '.cm-eval-current': {
    backgroundColor: 'rgba(228, 161, 90, 0.32)',
    borderRadius: '3px',
  },
  '.cm-eval-error': {
    backgroundColor: 'rgba(224, 122, 95, 0.4)',
    borderRadius: '3px',
  },
});

export function LispEditor({ source, highlight, onChange }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return undefined;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          lispLanguage,
          syntaxHighlighting(lispHighlight),
          editorTheme,
          highlightField,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          EditorState.tabSize.of(2),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor owns the document after mount; later source updates are dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== source) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    }
  }, [source]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        setHighlight.of(highlight),
        ...(highlight && highlight.to > highlight.from
          ? [EditorView.scrollIntoView(highlight.from, { y: 'center' })]
          : []),
      ],
    });
  }, [highlight]);

  return <div ref={hostRef} className="editor-host" data-testid="editor" />;
}
