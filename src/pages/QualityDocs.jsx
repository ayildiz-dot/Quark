import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { supabase } from '../lib/supabase'
import ColorPicker from '../components/ColorPicker'

import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'

/*
  Quality Documentation.

  Content is stored as TipTap JSON rather than HTML. That is a security decision as much
  as a convenience one: nothing here is ever handed to dangerouslySetInnerHTML, so a
  document cannot carry script. Authors are Admins and Owners, but a compromised admin
  account would otherwise become persistent XSS against every reader, agents included.

  Draft / publish / version history mirrors scorecards, because quality documentation is
  a standard people are measured against — what it said in March matters when reviewing a
  March evaluation.
*/


/* Font size. TipTap has no built-in size mark, so this adds a fontSize attribute to the
   existing textStyle mark — the same mark Color already writes to. Extending rather than
   adding a second mark keeps a coloured, resized run as one span instead of nested ones. */
const FontSize = TextStyle.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fontSize: {
        default: null,
        parseHTML: el => el.style.fontSize || null,
        renderHTML: attrs => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
      },
    }
  },
  addCommands() {
    return {
      setFontSize: size => ({ chain }) => chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize: () => ({ chain }) =>
        chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    }
  },
})

/* Cell background. Table cells carry no colour attribute out of the box; this adds one to
   both ordinary and header cells so setCellAttribute can write it. Stored as an attribute
   on the node, so it survives in the document JSON and renders identically in the reader
   and in the version diff. */
const cellBackground = {
  backgroundColor: {
    default: null,
    parseHTML: el => el.getAttribute('data-bg') || el.style.backgroundColor || null,
    renderHTML: attrs => (attrs.backgroundColor
      ? { 'data-bg': attrs.backgroundColor, style: `background-color: ${attrs.backgroundColor}` }
      : {}),
  },
}
const ColoredTableCell = TableCell.extend({
  addAttributes() { return { ...this.parent?.(), ...cellBackground } },
})
const ColoredTableHeader = TableHeader.extend({
  addAttributes() { return { ...this.parent?.(), ...cellBackground } },
})

const FONT_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '30px', '36px']
const DEFAULT_FONT = '16px'

const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
  }),
  Underline,
  Link.configure({
    openOnClick: false,
    autolink: true,
    // Anything a reader can click opens in a new tab and cannot reach back into Quark
    // via window.opener.
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
  }),
  Image.configure({ inline: false, allowBase64: false }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  FontSize,
  Color,
  Highlight.configure({ multicolor: true }),
  Table.configure({ resizable: true }),
  TableRow,
  ColoredTableHeader,
  ColoredTableCell,
]

/* ─────────────────────────────── toolbar bits ─────────────────────────────── */

const Btn = ({ on, onClick, title, children, disabled }) => (
  <button
    type="button" title={title} disabled={disabled}
    onMouseDown={e => e.preventDefault()}   // keep the editor selection
    onClick={onClick}
    style={{
      minWidth: 30, height: 28, padding: '0 7px', fontSize: 13, lineHeight: 1,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: on ? 'var(--accent-light, #2c4368)' : 'transparent',
      color: disabled ? 'var(--text-tertiary)' : (on ? 'var(--accent)' : 'var(--text-primary)'),
      border: '1px solid ' + (on ? 'var(--accent)' : 'transparent'),
      borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
    }}>{children}</button>
)

const Sep = () => (
  <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px', flexShrink: 0 }} />
)

/*
  The Google Docs table picker: hover a cell in the grid, insert that many rows/columns.
  Purely presentational — it calls the editor's insertTable with the hovered dimensions.
*/
function TableGrid({ onPick, onClose }) {
  const [hover, setHover] = useState({ r: 0, c: 0 })
  const MAX_R = 8, MAX_C = 8
  return (
    <div style={{
      position: 'absolute', top: 34, left: 0, zIndex: 30, padding: 10, borderRadius: 8,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
    }} onMouseLeave={() => setHover({ r: 0, c: 0 })}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${MAX_C}, 18px)`, gap: 2 }}>
        {Array.from({ length: MAX_R * MAX_C }).map((_, i) => {
          const r = Math.floor(i / MAX_C) + 1, c = (i % MAX_C) + 1
          const on = r <= hover.r && c <= hover.c
          return (
            <div key={i}
              onMouseEnter={() => setHover({ r, c })}
              onMouseDown={e => { e.preventDefault(); onPick(r, c); onClose() }}
              style={{
                width: 18, height: 18, borderRadius: 2, cursor: 'pointer',
                background: on ? 'var(--accent)' : 'var(--bg-secondary)',
                border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
              }} />
          )
        })}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>
        {hover.r ? `${hover.r} × ${hover.c}` : 'Insert table'}
      </div>
    </div>
  )
}


/* Inline SVG rather than emoji: the toolbar sits at 13px where emoji render
   inconsistently across platforms, and two of them were mangled outright when the
   5-hex-digit escapes were converted. */
const IconLink = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)
const IconImage = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
)

/* Text and highlight colour, using the same picker as the account theme settings
   (components/ColorPicker) so colour selection looks and behaves identically wherever
   it appears in Quark.

   The bar under the A / pen shows the colour currently applied at the cursor, read back
   from the editor rather than from local state — so moving the caret into differently
   coloured text updates the indicator. */
function ColorMenu({ label, glyph, current, fallback, onPick, onClear }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(current || fallback)
  const ref = useRef(null)

  useEffect(() => { setDraft(current || fallback) }, [current, fallback])

  // Close on any outside click, or the panel stays open behind the editor.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <Btn title={label} on={open} onClick={() => setOpen(v => !v)}>
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>{glyph}</span>
          <span style={{
            width: 15, height: 4, borderRadius: 1, marginTop: 2,
            background: current || fallback,
            border: current ? 'none' : '1px solid var(--border-light)',
          }} />
        </span>
      </Btn>
      {open && (
        <div onMouseDown={e => e.stopPropagation()} style={{
          position: 'absolute', top: 34, left: 0, zIndex: 30, width: 216, padding: 12,
          borderRadius: 10, background: 'var(--bg-surface)', border: '1px solid var(--border)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {label.toUpperCase()}
          </div>
          <ColorPicker value={draft} onChange={setDraft} />
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" style={{ flex: 1 }}
              onClick={() => { onClear(); setOpen(false) }}>None</button>
            <button type="button" className="btn btn-primary btn-sm" style={{ flex: 1 }}
              onClick={() => { onPick(draft); setOpen(false) }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Toolbar({ editor, onImage, busyImage }) {
  const [showGrid, setShowGrid] = useState(false)
  if (!editor) return null
  const inTable = editor.isActive('table')
  // Falls back to the base size so − and + have a sensible starting point on text that
  // has never had a size applied.
  const explicitFont = editor.getAttributes('textStyle').fontSize || null
  const curFont = explicitFont || DEFAULT_FONT

  const setLink = () => {
    const previous = editor.getAttributes('link').href || ''
    const url = window.prompt('Link URL', previous)
    if (url === null) return
    if (url === '') return editor.chain().focus().extendMarkRange('link').unsetLink().run()
    // Default to https rather than letting a bare string become a relative link, and
    // refuse javascript: outright — it would execute on click.
    let href = url.trim()
    if (/^javascript:/i.test(href)) return window.alert('That link type is not allowed.')
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) href = 'https://' + href
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', position: 'relative',
      padding: '6px 8px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-secondary)', borderRadius: '10px 10px 0 0',
    }}>
      <Btn title="Undo" onClick={() => editor.chain().focus().undo().run()}>↶</Btn>
      <Btn title="Redo" onClick={() => editor.chain().focus().redo().run()}>↷</Btn>
      <Sep />
      <select
        value={editor.isActive('heading', { level: 1 }) ? 'h1'
             : editor.isActive('heading', { level: 2 }) ? 'h2'
             : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p'}
        onChange={e => {
          const v = e.target.value
          if (v === 'p') editor.chain().focus().setParagraph().run()
          else editor.chain().focus().toggleHeading({ level: Number(v[1]) }).run()
        }}
        style={{
          height: 28, fontSize: 12, borderRadius: 6, padding: '0 6px',
          background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)',
        }}>
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <Sep />
      {/* Font size: the − and + step through FONT_SIZES, the select jumps straight to one.
          Current size is read back from the mark, so it reflects the caret position. */}
      <Btn title="Decrease font size" onClick={() => {
        const i = FONT_SIZES.indexOf(curFont)
        editor.chain().focus().setFontSize(FONT_SIZES[Math.max(0, i - 1)]).run()
      }}>A−</Btn>
      <select
        value={explicitFont || 'default'}
        onChange={e => {
          const v = e.target.value
          if (v === 'default') editor.chain().focus().unsetFontSize().run()
          else editor.chain().focus().setFontSize(v).run()
        }}
        title="Font size"
        style={{
          height: 28, fontSize: 12, borderRadius: 6, padding: '0 4px', width: 62,
          background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)',
        }}>
        <option value="default">Default</option>
        {FONT_SIZES.map(f => <option key={f} value={f}>{parseInt(f, 10)}</option>)}
      </select>
      <Btn title="Increase font size" onClick={() => {
        const i = FONT_SIZES.indexOf(curFont)
        editor.chain().focus().setFontSize(FONT_SIZES[Math.min(FONT_SIZES.length - 1, i + 1)]).run()
      }}>A+</Btn>
      <Sep />
      <Btn title="Bold"      on={editor.isActive('bold')}      onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></Btn>
      <Btn title="Italic"    on={editor.isActive('italic')}    onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></Btn>
      <Btn title="Underline" on={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></Btn>
      <Btn title="Strikethrough" on={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></Btn>
      <Btn title="Inline code" on={editor.isActive('code')}    onClick={() => editor.chain().focus().toggleCode().run()}>{'</>'}</Btn>
      <Sep />
      <Btn title="Align left"   on={editor.isActive({ textAlign: 'left' })}   onClick={() => editor.chain().focus().setTextAlign('left').run()}>≡</Btn>
      <Btn title="Align centre" on={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>☲</Btn>
      <Btn title="Align right"  on={editor.isActive({ textAlign: 'right' })}  onClick={() => editor.chain().focus().setTextAlign('right').run()}>≣</Btn>
      <Sep />
      <Btn title="Bulleted list" on={editor.isActive('bulletList')}  onClick={() => editor.chain().focus().toggleBulletList().run()}>•</Btn>
      <Btn title="Numbered list" on={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</Btn>
      <Btn title="Quote"         on={editor.isActive('blockquote')}  onClick={() => editor.chain().focus().toggleBlockquote().run()}>“</Btn>
      <Sep />
      <ColorMenu label="Text colour" glyph="A"
        current={editor.getAttributes('textStyle').color || null} fallback="var(--text-primary)"
        onPick={c => editor.chain().focus().setColor(c).run()}
        onClear={() => editor.chain().focus().unsetColor().run()} />
      <ColorMenu label="Highlight colour" glyph="✎"
        current={editor.getAttributes('highlight').color || null} fallback="transparent"
        onPick={c => editor.chain().focus().toggleHighlight({ color: c }).run()}
        onClear={() => editor.chain().focus().unsetHighlight().run()} />
      <Sep />
      <Btn title="Link" on={editor.isActive('link')} onClick={setLink}><IconLink /></Btn>
      <Btn title="Insert image" disabled={busyImage} onClick={onImage}>{busyImage ? '…' : <IconImage />}</Btn>
      <Btn title="Horizontal line" onClick={() => editor.chain().focus().setHorizontalRule().run()}>—</Btn>
      <div style={{ position: 'relative' }}>
        <Btn title="Insert table" on={showGrid} onClick={() => setShowGrid(v => !v)}>⊞</Btn>
        {showGrid && (
          <TableGrid
            onClose={() => setShowGrid(false)}
            onPick={(rows, cols) => editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()}
          />
        )}
      </div>

      {/* Table controls appear only inside a table, the way Google Docs surfaces them. */}
      {inTable && (
        <>
          <Sep />
          <Btn title="Add column before" onClick={() => editor.chain().focus().addColumnBefore().run()}>⇤col</Btn>
          <Btn title="Add column after"  onClick={() => editor.chain().focus().addColumnAfter().run()}>col⇥</Btn>
          <Btn title="Delete column"     onClick={() => editor.chain().focus().deleteColumn().run()}>✖col</Btn>
          <Btn title="Add row before"    onClick={() => editor.chain().focus().addRowBefore().run()}>⇡row</Btn>
          <Btn title="Add row after"     onClick={() => editor.chain().focus().addRowAfter().run()}>row⇣</Btn>
          <Btn title="Delete row"        onClick={() => editor.chain().focus().deleteRow().run()}>✖row</Btn>
          <Btn title="Merge cells"       onClick={() => editor.chain().focus().mergeCells().run()}>merge</Btn>
          <Btn title="Split cell"        onClick={() => editor.chain().focus().splitCell().run()}>split</Btn>
          <Btn title="Delete table"      onClick={() => editor.chain().focus().deleteTable().run()}>✖ table</Btn>
          <ColorMenu label="Cell background" glyph="▦"
            current={editor.getAttributes('tableCell').backgroundColor
                  || editor.getAttributes('tableHeader').backgroundColor || null}
            fallback="transparent"
            onPick={c => editor.chain().focus().setCellAttribute('backgroundColor', c).run()}
            onClear={() => editor.chain().focus().setCellAttribute('backgroundColor', null).run()} />
        </>
      )}
    </div>
  )
}

/* ─────────────────────────── shared editor styles ─────────────────────────── */
/* Injected once. Tables and images need real CSS to be usable, and there is no
   stylesheet in this project that knows about ProseMirror. */
const EDITOR_CSS = `
.qd-editor .ProseMirror { outline: none; min-height: 100%; padding: 18px 20px; color: var(--text-primary); }
.qd-editor .ProseMirror > * + * { margin-top: 0.75em; }
.qd-editor .ProseMirror h1 { font-size: 1.7em; font-weight: 700; }
.qd-editor .ProseMirror h2 { font-size: 1.35em; font-weight: 700; }
.qd-editor .ProseMirror h3 { font-size: 1.15em; font-weight: 600; }
.qd-editor .ProseMirror ul, .qd-editor .ProseMirror ol { padding-left: 1.4em; }
.qd-editor .ProseMirror blockquote { border-left: 3px solid var(--border-light); padding-left: 12px; color: var(--text-secondary); }
.qd-editor .ProseMirror hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }
.qd-editor .ProseMirror img { max-width: 100%; height: auto; border-radius: 6px; }
.qd-editor .ProseMirror a { color: var(--accent); text-decoration: underline; }
.qd-editor .ProseMirror mark { padding: 0 2px; border-radius: 3px; }
.qd-editor .ProseMirror code { background: var(--bg-secondary); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
.qd-editor .ProseMirror table { border-collapse: collapse; table-layout: fixed; width: 100%; overflow: hidden; }
.qd-editor .ProseMirror td, .qd-editor .ProseMirror th {
  border: 1px solid var(--border); padding: 7px 9px; vertical-align: top; position: relative; min-width: 1em;
}
.qd-editor .ProseMirror th { background: var(--bg-secondary); font-weight: 600; text-align: left; }
.qd-editor .ProseMirror .selectedCell:after {
  content: ''; position: absolute; inset: 0; background: rgba(59,130,246,0.18); pointer-events: none;
}
.qd-editor .ProseMirror .column-resize-handle {
  position: absolute; right: -2px; top: 0; bottom: 0; width: 4px; background: var(--accent); pointer-events: none;
}
.qd-editor .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder); float: left; color: var(--text-tertiary); pointer-events: none; height: 0;
}
`

function useEditorStyles() {
  useEffect(() => {
    if (document.getElementById('qd-editor-css')) return
    const el = document.createElement('style')
    el.id = 'qd-editor-css'
    el.textContent = EDITOR_CSS
    document.head.appendChild(el)
  }, [])
}

/* ─────────────────────────────── list search ─────────────────────────────── */

/* A document's body is TipTap JSON, so its words sit in the text of the leaf nodes.
   docText walks the tree and joins them: text runs inside one paragraph are joined
   directly (a word split by bold or colour stays one word), while separate blocks,
   list items and table cells get a space between them so words never run together. */
function docText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text || ''
  if (node.type === 'hardBreak') return ' '
  if (!Array.isArray(node.content)) return ''
  return node.content
    .map(c => (c && c.type === 'text') ? (c.text || '') : ' ' + docText(c) + ' ')
    .join('')
}

/* Case- and accent-insensitive form used for matching, so "dsat" finds "DSAT" and
   "cafe" finds "café". The character class is the Unicode combining-diacritics range. */
const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/* A short excerpt around the first place `term` appears in the body, so a card that
   matched on its content shows why. Returned as three plain strings and rendered as text,
   never as HTML. Folding can change a string's length for a few unusual characters; in
   that case the positions would not line up, so no excerpt is shown (the card still
   matches). */
function snippetFor(text, term) {
  const folded = fold(text)
  if (folded.length !== text.length) return null
  const i = folded.indexOf(term)
  if (i < 0) return null
  let start = Math.max(0, i - 50)
  if (start > 0) {
    const sp = text.indexOf(' ', start)
    if (sp > -1 && sp < i) start = sp + 1
  }
  const end = Math.min(text.length, i + term.length + 90)
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, i),
    match: text.slice(i, i + term.length),
    after: text.slice(i + term.length, end) + (end < text.length ? '…' : ''),
  }
}

/* ─────────────────────────────── list view ─────────────────────────────── */

export default function QualityDocs() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const canEdit = ['owner', 'admin'].includes(profile?.role)

  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  // The body (content) is loaded too, so search can look inside documents and not only at
  // titles. The searchable text is built once here rather than on every keystroke, and
  // the raw JSON is dropped afterwards since the list never renders it.
  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('quality_documents')
      .select('id, title, summary, content, is_published, version, updated_at, updated_by, users:updated_by(name)')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
    setDocs((data || []).map(({ content, ...d }) => {
      const body = docText(content).replace(/\s+/g, ' ').trim()
      return {
        ...d,
        _body: body,
        _head: fold(`${d.title || ''} ${d.summary || ''}`),
        _hay: fold(`${d.title || ''} ${d.summary || ''} ${body}`),
      }
    }))
    setLoading(false)
  }, [])

  useEffect(() => { if (profile) load() }, [profile, load])

  const createDoc = async () => {
    const { data, error } = await supabase.from('quality_documents')
      .insert({ title: 'Untitled document', content: null, created_by: profile.id, updated_by: profile.id })
      .select().single()
    if (error) return window.alert('Could not create the document: ' + error.message)
    navigate(`/quality-docs/${data.id}/edit`)
  }

  // Every word typed must appear somewhere in the title, summary or body, in any order.
  const terms = fold(q).split(/\s+/).filter(Boolean)
  const shown = terms.length === 0 ? docs : docs.filter(d => terms.every(t => d._hay.includes(t)))

  if (loading) return <div className="page"><div className="spinner" /></div>

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1>Quality Documentation</h1>
          <p className="page-sub">Standards, guidelines and process documentation.</p>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={createDoc}>+ New Documentation</button>}
      </div>

      <input className="input" placeholder="Search titles and content…" value={q} onChange={e => setQ(e.target.value)}
        style={{ maxWidth: 360, marginBottom: 20 }} />

      {shown.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
          {docs.length === 0 ? 'No documentation yet.' : 'Nothing matches that search.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {shown.map(d => {
            // Excerpt only when a word matched in the body and not already in the title or
            // summary; otherwise the card itself already shows why it matched.
            const bodyTerm = terms.find(t => !d._head.includes(t))
            const snip = bodyTerm ? snippetFor(d._body, bodyTerm) : null
            return (
            <div key={d.id} className="card"
              onClick={() => navigate(`/quality-docs/${d.id}`)}
              onMouseEnter={e => {
                e.currentTarget.style.transform = 'translateY(-4px)'
                e.currentTarget.style.borderColor = 'var(--border-light)'
                e.currentTarget.style.boxShadow = 'var(--shadow)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.borderColor = 'var(--border)'
                e.currentTarget.style.boxShadow = 'none'
              }}
              style={{
                cursor: 'pointer', padding: 18, minHeight: 130,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                transition: 'transform .25s cubic-bezier(0.34, 1.56, 0.64, 1), border-color .18s ease, box-shadow .18s ease',
              }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{d.title}</span>
                  {!d.is_published && (
                    <span className="badge" style={{ background: 'var(--warning-light, #5b3d05)', color: '#fcd34d', fontSize: 10 }}>DRAFT</span>
                  )}
                </div>
                {d.summary && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{d.summary}</div>
                )}
                {snip && (
                  <div style={{
                    fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginTop: 10,
                    padding: '7px 10px', borderRadius: 8, background: 'var(--bg-secondary)',
                  }}>
                    {snip.before}
                    <mark style={{ background: 'var(--accent-light)', color: 'var(--text-primary)', borderRadius: 3, padding: '0 2px' }}>{snip.match}</mark>
                    {snip.after}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 12 }}>
                v{d.version} · updated {new Date(d.updated_at).toLocaleDateString()}
                {d.users?.name ? ` · ${d.users.name}` : ''}
              </div>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────── reader ─────────────────────────────── */

export function QualityDocView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const canEdit = ['owner', 'admin'].includes(profile?.role)
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  useEditorStyles()

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('quality_documents')
        .select('*, users:updated_by(name)').eq('id', id).maybeSingle()
      setDoc(data); setLoading(false)
    })()
  }, [id])

  // Read-only TipTap instance. Rendering through the editor rather than converting to
  // HTML is what keeps this free of dangerouslySetInnerHTML.
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: doc?.content || '',
    editable: false,
  }, [doc?.id, doc?.content])

  if (loading) return <div className="page"><div className="spinner" /></div>
  if (!doc) return (
    <div className="page">
      <button className="btn btn-ghost btn-sm" onClick={() => navigate('/quality-docs')}>← Back</button>
      <div className="card" style={{ padding: 32, marginTop: 16 }}>This document is not available.</div>
    </div>
  )

  return (
    <div className="page">
      <button className="btn btn-ghost btn-sm" onClick={() => navigate('/quality-docs')} style={{ marginBottom: 12 }}>← Back to documentation</button>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1>{doc.title}</h1>
          <p className="page-sub">
            v{doc.version} · updated {new Date(doc.updated_at).toLocaleDateString()}
            {doc.users?.name ? ` · ${doc.users.name}` : ''}
            {!doc.is_published && ' · DRAFT'}
          </p>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => navigate(`/quality-docs/${id}/history`)}>History</button>
            <button className="btn btn-primary" onClick={() => navigate(`/quality-docs/${id}/edit`)}>Edit</button>
          </div>
        )}
      </div>
      <div className="card qd-editor" style={{ padding: 0, overflow: 'hidden' }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

/* ─────────────────────────────── editor ─────────────────────────────── */

export function QualityDocEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile, setUnsavedChanges, safeNavigate } = useAuth()
  useEditorStyles()

  const [doc, setDoc] = useState(null)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [busyImage, setBusyImage] = useState(false)
  const [msg, setMsg] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [askReason, setAskReason] = useState(false)
  const [reason, setReason] = useState('')
  // The editor pane is resizable in both directions, so a long document can be worked on
  // without the page itself scrolling.
  const [paneHeight, setPaneHeight] = useState(560)
  const fileRef = useRef(null)

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000) }

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: '',
    onUpdate: () => { setDirty(true); setUnsavedChanges && setUnsavedChanges(true) },
  })

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('quality_documents').select('*').eq('id', id).maybeSingle()
      if (data) {
        setDoc(data); setTitle(data.title || ''); setSummary(data.summary || '')
        if (editor && data.content) editor.commands.setContent(data.content)
      }
      setLoading(false)
    })()
    // eslint-disable-next-line
  }, [id, editor])

  useEffect(() => () => setUnsavedChanges && setUnsavedChanges(false), [setUnsavedChanges])

  const insertImage = async () => fileRef.current?.click()

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 5 * 1024 * 1024) return flash('Images must be under 5 MB.', false)
    setBusyImage(true)
    const safe = file.name.replace(/[^\w.\-]+/g, '_')
    const path = `${id}/${Date.now()}-${safe}`
    const { error: upErr } = await supabase.storage.from('quality-doc-images').upload(path, file, { upsert: false })
    if (upErr) { setBusyImage(false); return flash('Image upload failed: ' + upErr.message, false) }
    // The bucket is private, so a signed URL is needed to display it. Long-lived because
    // it is embedded in a document people will read for months.
    const { data: signed } = await supabase.storage.from('quality-doc-images')
      .createSignedUrl(path, 60 * 60 * 24 * 365)
    setBusyImage(false)
    if (!signed?.signedUrl) return flash('Image uploaded but could not be displayed.', false)
    editor?.chain().focus().setImage({ src: signed.signedUrl }).run()
  }

  // Draft save: no version bump, no history row. Same idea as an unpublished scorecard.
  const saveDraft = async () => {
    if (!title.trim()) return flash('A title is required.', false)
    setBusy(true)
    const { error } = await supabase.from('quality_documents').update({
      title: title.trim(), summary: summary.trim() || null,
      content: editor?.getJSON() || null,
      updated_by: profile.id, updated_at: new Date().toISOString(),
    }).eq('id', id)
    setBusy(false)
    if (error) return flash('Save failed: ' + error.message, false)
    setDirty(false); setUnsavedChanges && setUnsavedChanges(false)
    flash('Draft saved.')
  }

  // Publishing bumps the version and writes a history row with the stated reason — the
  // same discipline as a published scorecard, and for the same reason: people are
  // measured against this, so what it said and why it changed has to be recoverable.
  const publish = async () => {
    if (!title.trim()) return flash('A title is required.', false)
    if (doc?.is_published && !reason.trim()) return flash('Please state what changed and why.', false)
    setBusy(true)
    const nextVersion = doc?.is_published ? (doc.version || 1) + 1 : (doc?.version || 1)
    const content = editor?.getJSON() || null

    const { error } = await supabase.from('quality_documents').update({
      title: title.trim(), summary: summary.trim() || null, content,
      is_published: true, version: nextVersion,
      updated_by: profile.id, updated_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) { setBusy(false); return flash('Publish failed: ' + error.message, false) }

    const { error: hErr } = await supabase.from('quality_document_history').insert({
      document_id: id, version_number: nextVersion,
      title: title.trim(), summary: summary.trim() || null, content,
      change_reason: reason.trim() || 'Initial publication', changed_by: profile.id,
    })
    setBusy(false)
    // A failed history row is worth surfacing: the document published, but the audit
    // trail did not record it.
    if (hErr) flash('Published, but the history entry failed: ' + hErr.message, false)
    else flash(`Published as v${nextVersion}.`)
    setAskReason(false); setReason(''); setDirty(false)
    setUnsavedChanges && setUnsavedChanges(false)
    setDoc(d => ({ ...d, is_published: true, version: nextVersion }))
  }

  const unpublish = async () => {
    setBusy(true)
    const { error } = await supabase.from('quality_documents')
      .update({ is_published: false, updated_by: profile.id, updated_at: new Date().toISOString() }).eq('id', id)
    setBusy(false)
    if (error) return flash('Could not unpublish: ' + error.message, false)
    setDoc(d => ({ ...d, is_published: false }))
    flash('Unpublished — it is now visible to Admins and Owners only.')
  }

  const back = () => (safeNavigate ? safeNavigate('/quality-docs') : navigate('/quality-docs'))

  if (loading) return <div className="page"><div className="spinner" /></div>
  if (!doc) return <div className="page"><div className="card" style={{ padding: 32 }}>Document not found.</div></div>

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />

      <button className="btn btn-ghost btn-sm" onClick={back} style={{ marginBottom: 12 }}>← Back to documentation</button>

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div><h1>{doc.is_published ? 'Edit documentation' : 'New documentation'}</h1></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="badge" style={{
            background: doc.is_published ? 'var(--success-light, #0d6b52)' : 'var(--warning-light, #5b3d05)',
            color: doc.is_published ? '#a7f3d0' : '#fcd34d',
          }}>{doc.is_published ? `PUBLISHED v${doc.version}` : 'DRAFT'}</span>
          {dirty && <span style={{ fontSize: 12, color: 'var(--warning)' }}>Unsaved changes</span>}
          <button className="btn btn-ghost" onClick={() => navigate(`/quality-docs/${id}/history`)}>History</button>
          <button className="btn btn-outline" disabled={busy} onClick={saveDraft}>Save draft</button>
          <button className="btn btn-primary" disabled={busy}
            onClick={() => (doc.is_published ? setAskReason(true) : publish())}>
            {doc.is_published ? 'Save changes' : 'Publish'}
          </button>
          {doc.is_published && <button className="btn btn-danger" disabled={busy} onClick={unpublish}>Unpublish</button>}
        </div>
      </div>

      {msg && <div className={`flash ${msg.ok ? 'flash-ok' : 'flash-err'}`} style={{ marginBottom: 16 }}>{msg.text}</div>}

      <div className="form-field" style={{ marginBottom: 12 }}>
        <label>Title <span style={{ color: 'var(--danger)' }}>*</span></label>
        <input className="input" value={title} maxLength={160}
          onChange={e => { setTitle(e.target.value); setDirty(true); setUnsavedChanges && setUnsavedChanges(true) }}
          placeholder="e.g. DSAT Controllability Guidelines" style={{ fontSize: 16, fontWeight: 600 }} />
      </div>
      <div className="form-field" style={{ marginBottom: 16 }}>
        <label>Summary <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>(shown on the card)</span></label>
        <input className="input" value={summary} maxLength={200}
          onChange={e => { setSummary(e.target.value); setDirty(true); setUnsavedChanges && setUnsavedChanges(true) }}
          placeholder="One line describing what this covers" />
      </div>

      {/* The editor pane. resize: both lets it be dragged wider and taller, which is what
          makes a long document workable without the page scrolling underneath. */}
      <div className="qd-editor" style={{
        border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-surface)',
        resize: 'vertical', overflow: 'auto', height: paneHeight, minHeight: 260, width: '100%',
        display: 'flex', flexDirection: 'column',
      }} onMouseUp={e => setPaneHeight(e.currentTarget.offsetHeight)}>
        <Toolbar editor={editor} onImage={insertImage} busyImage={busyImage} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <EditorContent editor={editor} />
        </div>
      </div>

      {askReason && (
        <div className="modal-backdrop" onClick={() => setAskReason(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2>Publish v{(doc.version || 1) + 1}</h2>
              <button className="btn-close" onClick={() => setAskReason(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
                This documentation is a standard people are measured against, so every published
                change is versioned with a stated reason. Anyone reading an older evaluation can
                then see what the guidance said at the time.
              </p>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>What changed, and why? <span style={{ color: 'var(--danger)' }}>*</span></label>
              <textarea className="input" rows={3} value={reason} onChange={e => setReason(e.target.value)}
                style={{ width: '100%', resize: 'vertical', marginTop: 6 }}
                placeholder="e.g. Clarified the controllability definition after Q3 calibration findings" />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn btn-ghost" onClick={() => setAskReason(false)}>Cancel</button>
                <button className="btn btn-primary" disabled={busy} onClick={publish}>Publish</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────── history ─────────────────────────────── */


/* Block-level diff between two versions.

   Compares the top-level blocks of the stored TipTap documents — paragraphs, headings,
   tables, images, lists — and works out which were removed and which were added. Blocks
   are matched on their serialised form, so an untouched paragraph is recognised even if
   everything around it moved.

   Standard LCS. The point is to show the actual content that changed rather than a count:
   "this table was removed, this paragraph replaced it" answers the question a reader
   actually has when reviewing a guideline change. */
const sig = (b) => JSON.stringify(b)

function diffBlocks(prevDoc, curDoc) {
  const A = (prevDoc?.content || []), B = (curDoc?.content || [])
  const n = A.length, m = B.length
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = sig(A[i]) === sig(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const removed = [], added = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (sig(A[i]) === sig(B[j])) { i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(A[i++])
    else added.push(B[j++])
  }
  while (i < n) removed.push(A[i++])
  while (j < m) added.push(B[j++])
  return { removed, added }
}

/* Renders a set of blocks read-only through TipTap, so tables and images appear exactly
   as they do in the document — and, as everywhere else here, without ever touching
   dangerouslySetInnerHTML. */
function BlockPreview({ blocks, empty }) {
  const doc = { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] }
  const editor = useEditor({ extensions: EXTENSIONS, content: doc, editable: false }, [JSON.stringify(doc)])
  if (!blocks.length) {
    return <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{empty}</div>
  }
  return <div className="qd-editor"><EditorContent editor={editor} /></div>
}

function VersionDiffModal({ row, prev, onClose }) {
  const { removed, added } = diffBlocks(prev?.content, row?.content)
  const titleChanged = prev && (prev.title || '') !== (row.title || '')
  const summaryChanged = prev && (prev.summary || '') !== (row.summary || '')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 1100, width: '94vw' }}>
        <div className="modal-header">
          <h2>{prev ? `Changes from v${prev.version_number} to v${row.version_number}` : `v${row.version_number} — initial version`}</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '74vh', overflowY: 'auto' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14 }}>
            {new Date(row.created_at).toLocaleString()} · {row.users?.name || '—'}
            {row.change_reason ? <> · “{row.change_reason}”</> : null}
          </div>

          {(titleChanged || summaryChanged) && (
            <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              {titleChanged && (
                <div style={{ fontSize: 13, marginBottom: summaryChanged ? 8 : 0 }}>
                  <b>Title:</b>{' '}
                  <span style={{ textDecoration: 'line-through', color: 'var(--text-tertiary)' }}>{prev.title}</span>
                  {' → '}<span>{row.title}</span>
                </div>
              )}
              {summaryChanged && (
                <div style={{ fontSize: 13 }}>
                  <b>Summary:</b>{' '}
                  <span style={{ textDecoration: 'line-through', color: 'var(--text-tertiary)' }}>{prev.summary || '—'}</span>
                  {' → '}<span>{row.summary || '—'}</span>
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', color: '#fecaca', marginBottom: 6 }}>
                REMOVED
              </div>
              <div style={{ border: '1px solid var(--danger, #ef4444)', borderRadius: 8, background: 'rgba(239,68,68,0.06)', overflow: 'hidden' }}>
                <BlockPreview blocks={removed} empty={prev ? 'Nothing was removed.' : 'No earlier version.'} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', color: '#a7f3d0', marginBottom: 6 }}>
                ADDED
              </div>
              <div style={{ border: '1px solid var(--success, #10b981)', borderRadius: 8, background: 'rgba(16,185,129,0.06)', overflow: 'hidden' }}>
                <BlockPreview blocks={added} empty="Nothing was added." />
              </div>
            </div>
          </div>

          {!removed.length && !added.length && !titleChanged && !summaryChanged && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              No content changed between these versions — the difference was formatting only.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function QualityDocHistory() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const canEdit = ['owner', 'admin'].includes(profile?.role)
  const [rows, setRows] = useState([])
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [openDiff, setOpenDiff] = useState(null)   // { row, prev }

  const load = useCallback(async () => {
    setLoading(true)
    const [d, h] = await Promise.all([
      supabase.from('quality_documents').select('*').eq('id', id).maybeSingle(),
      supabase.from('quality_document_history')
        .select('*, users:changed_by(name)').eq('document_id', id).order('version_number', { ascending: false }),
    ])
    setDoc(d.data); setRows(h.data || []); setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  // Restoring writes the old content back as a NEW version rather than rewinding the
  // counter, so the history stays append-only and the restore is itself auditable.
  const restore = async (row) => {
    if (!window.confirm(`Restore v${row.version_number}? This creates a new version with that content.`)) return
    setBusy(true)
    const nextVersion = (doc?.version || 1) + 1
    await supabase.from('quality_documents').update({
      title: row.title, summary: row.summary, content: row.content,
      version: nextVersion, updated_by: profile.id, updated_at: new Date().toISOString(),
    }).eq('id', id)
    await supabase.from('quality_document_history').insert({
      document_id: id, version_number: nextVersion,
      title: row.title, summary: row.summary, content: row.content,
      change_reason: `Restored from v${row.version_number}`, changed_by: profile.id,
    })
    setBusy(false)
    await load()
  }

  if (loading) return <div className="page"><div className="spinner" /></div>

  return (
    <div className="page">
      <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/quality-docs/${id}`)} style={{ marginBottom: 12 }}>← Back to document</button>
      <div className="page-header">
        <h1>{doc?.title || 'Document'} — history</h1>
        <p className="page-sub">Every published change, most recent first.</p>
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 24, color: 'var(--text-secondary)' }}>No published versions yet.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr><th>Version</th><th>Date</th><th>Changed by</th><th>Reason</th>{canEdit && <th></th>}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                // rows are newest-first, so the previous version is the NEXT one along
                const prev = rows[i + 1]
                return (
                  <tr key={r.id}
                    onClick={() => setOpenDiff({ row: r, prev })}
                    title="See what changed in this version"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover, #363f54)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>v{r.version_number}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</td>
                    <td>{r.users?.name || '—'}</td>
                    <td>{r.change_reason || '—'}</td>
                    {canEdit && (
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => restore(r)}>Restore</button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {openDiff && (
        <VersionDiffModal row={openDiff.row} prev={openDiff.prev} onClose={() => setOpenDiff(null)} />
      )}
    </div>
  )
}