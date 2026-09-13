import { useState, useMemo, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

/* ── Minimalist Callout Box ── */
function Callout({ type = 'note', title, children }) {
  const configs = {
    note: { bg: 'rgba(0, 74, 198, 0.04)', border: 'var(--color-primary)', icon: 'info', iconColor: 'var(--color-primary)' },
    tip: { bg: 'rgba(0, 96, 86, 0.04)', border: 'var(--color-tertiary)', icon: 'lightbulb', iconColor: 'var(--color-tertiary)' },
    warning: { bg: 'rgba(232, 160, 32, 0.06)', border: '#e8a020', icon: 'warning', iconColor: '#b57908' },
    security: { bg: 'rgba(186, 26, 26, 0.04)', border: 'var(--color-error)', icon: 'shield', iconColor: 'var(--color-error)' },
  }
  const cfg = configs[type] || configs.note

  return (
    <div
      style={{
        background: cfg.bg,
        borderLeft: `3px solid ${cfg.border}`,
        borderRadius: '0 8px 8px 0',
        padding: '14px 18px',
        margin: '20px 0',
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <span className="material-symbols-outlined" style={{ color: cfg.iconColor, fontSize: 20, flexShrink: 0, marginTop: 2 }}>
        {cfg.icon}
      </span>
      <div style={{ flex: 1, fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface)' }}>
        {title && <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 13, color: cfg.iconColor, marginBottom: 2 }}>{title}</div>}
        {children}
      </div>
    </div>
  )
}

/* ── Minimalist Terminal / Code Block with Tabs & Copy ── */
function CodeBlock({ tabs, code, language = 'bash' }) {
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState(tabs ? tabs[0].label : null)

  const activeCode = tabs ? tabs.find(t => t.label === activeTab)?.code || '' : code

  const handleCopy = () => {
    navigator.clipboard.writeText(activeCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      style={{
        margin: '18px 0',
        borderRadius: 10,
        overflow: 'hidden',
        background: '#0d131a',
        border: '1px solid rgba(195, 198, 215, 0.12)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
      }}
    >
      {/* Terminal Titlebar */}
      <div
        style={{
          background: '#090e14',
          padding: '8px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid rgba(195, 198, 215, 0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Traffic dots */}
          <div style={{ display: 'flex', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f56', opacity: 0.8 }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ffbd2e', opacity: 0.8 }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#27c93f', opacity: 0.8 }} />
          </div>

          {/* Optional Tabs */}
          {tabs ? (
            <div style={{ display: 'flex', gap: 4 }}>
              {tabs.map((tab) => (
                <button
                  key={tab.label}
                  onClick={() => setActiveTab(tab.label)}
                  style={{
                    background: activeTab === tab.label ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                    border: 'none',
                    borderRadius: 4,
                    padding: '3px 8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    color: activeTab === tab.label ? '#ffffff' : 'rgba(230, 242, 255, 0.5)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(230, 242, 255, 0.4)', textTransform: 'uppercase' }}>
              {language}
            </span>
          )}
        </div>

        {/* Copy Button */}
        <button
          onClick={handleCopy}
          style={{
            background: 'none',
            border: 'none',
            color: copied ? 'var(--color-tertiary-fixed)' : 'rgba(230, 242, 255, 0.5)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            transition: 'color 0.15s ease',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            {copied ? 'check' : 'content_copy'}
          </span>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Code Body */}
      <div style={{ padding: '14px 18px', overflowX: 'auto' }}>
        <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.65, color: '#dbe1ff' }}>
          <code>{activeCode}</code>
        </pre>
      </div>
    </div>
  )
}

/* ── Minimalist Config Generator ── */
function ConfigGenerator() {
  const [provider, setProvider] = useState('google')
  const [model, setModel] = useState('gemini-3.8-flash')
  const [effort, setEffort] = useState('high')
  const [budget, setBudget] = useState(8192)
  const [sandbox, setSandbox] = useState(true)

  const configJson = useMemo(() => {
    return JSON.stringify(
      {
        version: '2.4.0',
        defaultProvider: provider,
        defaultModel: model,
        effortLevel: effort,
        thinkingBudgetTokens: Number(budget),
        sandbox: {
          enabled: sandbox,
          networkAccess: 'none',
          image: 'inflynx/sandbox:latest',
        },
        policy: {
          requireApprovalForMutations: true,
          blockedCommands: ['rm -rf /', 'git push --force'],
        },
      },
      null,
      2
    )
  }, [provider, model, effort, budget, sandbox])

  return (
    <div
      style={{
        margin: '20px 0',
        padding: 20,
        background: 'var(--color-surface-container-lowest)',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)' }}>
          Tailored Configuration Builder
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-primary)', background: 'rgba(0,74,198,0.08)', padding: '2px 8px', borderRadius: 4 }}>
          .inflynx/config.json
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div>
          <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)', display: 'block', marginBottom: 4 }}>
            Provider
          </label>
          <select
            className="input"
            value={provider}
            onChange={e => {
              setProvider(e.target.value)
              if (e.target.value === 'google') setModel('gemini-3.8-flash')
              if (e.target.value === 'anthropic') setModel('claude-opus-5')
              if (e.target.value === 'openai') setModel('gpt-6-astra')
              if (e.target.value === 'deepseek') setModel('deepseek-v4-flash')
            }}
            style={{ fontSize: 12, padding: '6px 10px' }}
          >
            <option value="google">Google Gemini</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </div>

        <div>
          <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)', display: 'block', marginBottom: 4 }}>
            Model
          </label>
          <select
            className="input"
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{ fontSize: 12, padding: '6px 10px' }}
          >
            {provider === 'google' && (
              <>
                <option value="gemini-3.8-flash">gemini-3.8-flash</option>
                <option value="gemini-3.8-flash-cyber">gemini-3.8-flash-cyber</option>
              </>
            )}
            {provider === 'anthropic' && (
              <>
                <option value="claude-opus-5">claude-opus-5</option>
                <option value="claude-sonnet-5">claude-sonnet-5</option>
              </>
            )}
            {provider === 'openai' && (
              <>
                <option value="gpt-6-astra">gpt-6-astra</option>
                <option value="gpt-5.6-sol">gpt-5.6-sol</option>
              </>
            )}
            {provider === 'deepseek' && (
              <>
                <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                <option value="deepseek-v4-coder">deepseek-v4-coder</option>
              </>
            )}
          </select>
        </div>

        <div>
          <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)', display: 'block', marginBottom: 4 }}>
            Effort Level
          </label>
          <select
            className="input"
            value={effort}
            onChange={e => setEffort(e.target.value)}
            style={{ fontSize: 12, padding: '6px 10px' }}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        </div>

        <div>
          <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)', display: 'block', marginBottom: 4 }}>
            Thinking Tokens
          </label>
          <input
            type="number"
            className="input"
            value={budget}
            onChange={e => setBudget(e.target.value)}
            style={{ fontSize: 12, padding: '6px 10px' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'var(--font-inter)', fontSize: 12, color: 'var(--color-on-surface)' }}>
          <input type="checkbox" checked={sandbox} onChange={e => setSandbox(e.target.checked)} />
          Enforce zero-network sandbox
        </label>
      </div>

      <CodeBlock code={configJson} language="json" />
    </div>
  )
}

/* ── Static Documentation Structure ── */
const SECTIONS = [
  {
    group: 'Getting Started',
    items: [
      { id: 'getting-started', title: 'Quickstart & Installation', time: '3m', headings: ['1. Installation', '2. Configure API Keys', '3. First Agent Session'] },
      { id: 'providers-byok', title: 'Frontier Providers & BYOK', time: '4m', headings: ['Curated 2026 Model Suite', 'Keyring Security', 'Routing Directives'] },
      { id: 'configuration', title: 'Configuration & Schemas', time: '4m', headings: ['Interactive Builder', 'Schema Specification', 'Environment Variables'] },
    ],
  },
  {
    group: 'Cognitive Runtime',
    items: [
      { id: 'prompt-modes', title: 'The 4 Execution Modes', time: '5m', headings: ['Ask Mode', 'Plan Mode', 'Agent Mode', 'Debug Mode'] },
      { id: 'effort-profiles', title: 'Reasoning Effort & Budgets', time: '3m', headings: ['Effort Tiers', 'Cost vs Latency Tradeoffs'] },
      { id: 'orchestration-runtime', title: 'Orchestration State Machine', time: '6m', headings: ['Event Loop Stages', 'Deterministic Gates'] },
    ],
  },
  {
    group: 'Command API',
    items: [
      { id: 'slash-commands', title: '14 Built-in Slash Commands', time: '5m', headings: ['Command Reference', 'Workflow Commands', 'Execution & Verification'] },
      { id: 'dependency-graph', title: 'AST Dependency Graph', time: '4m', headings: ['Tree-Sitter Parsing', 'Call-Chain Topology', 'Symbol Resolution'] },
    ],
  },
  {
    group: 'Security & Sandboxing',
    items: [
      { id: 'security-policy', title: 'Docker Sandboxes & PathGuard', time: '4m', headings: ['Zero-Network Containment', 'Path Traversal Prevention'] },
      { id: 'secret-redaction', title: 'Shannon Entropy Secret Scrubber', time: '3m', headings: ['Entropy Thresholds', 'Redaction Pipeline'] },
    ],
  },
  {
    group: 'Specification',
    items: [
      { id: 'rfc-roadmap-phases', title: 'Production Maturity RFC', time: '7m', headings: ['Implementation Phases', 'Milestones 0–13'] },
    ],
  },
]

const ALL_ITEMS = SECTIONS.flatMap(g => g.items)

const SLASH_COMMANDS = [
  { cmd: '/plan', cat: 'workflow', desc: 'Generate an AST-aware structured execution plan without filesystem mutation.', args: '<task>' },
  { cmd: '/verify', cat: 'execution', desc: 'Execute compilers and test suites inside an isolated Docker container.', args: '[--suite]' },
  { cmd: '/apply', cat: 'execution', desc: 'Cryptographically sign and apply the verified patch diff to the workspace.', args: '<plan-id>' },
  { cmd: '/debug', cat: 'workflow', desc: 'Launch root-cause analysis engine with stack trace and regression tracing.', args: '<error>' },
  { cmd: '/graph', cat: 'ast', desc: 'Inspect the topological dependency graph and symbol callers for a target file.', args: '<file>' },
  { cmd: '/compress', cat: 'context', desc: 'Trigger ZSTD stream compression to compact distant dependencies in context.', args: '' },
  { cmd: '/route', cat: 'model', desc: 'Override or inspect cognitive provider routing (Claude, GPT, Gemini, DeepSeek).', args: '<model>' },
  { cmd: '/sandbox', cat: 'execution', desc: 'Attach an interactive shell session into the active Docker sandbox container.', args: '' },
  { cmd: '/audit', cat: 'security', desc: 'Stream cryptographic SHA-256 patch signatures and secret redaction logs.', args: '' },
  { cmd: '/diff', cat: 'execution', desc: 'Preview colored unified diff of proposed changes before signoff.', args: '' },
  { cmd: '/revert', cat: 'execution', desc: 'Deterministically rollback to the previous checkpoint hash.', args: '<hash>' },
  { cmd: '/memory', cat: 'context', desc: 'Display active context window consumption, pinned files, and cache hits.', args: '' },
  { cmd: '/doctor', cat: 'diagnostics', desc: 'Verify local system dependencies (Docker, Git, Node, Keyring credentials).', args: '' },
  { cmd: '/clean', cat: 'diagnostics', desc: 'Prune stale Docker containers, AST cache artifacts, and temporary logs.', args: '' },
]

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('getting-started')
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [slashCategory, setSlashCategory] = useState('all')
  const [feedback, setFeedback] = useState(null)
  const searchInputRef = useRef(null)

  const activeDoc = ALL_ITEMS.find(i => i.id === activeSection) || ALL_ITEMS[0]
  const currentIndex = ALL_ITEMS.findIndex(i => i.id === activeSection)
  const prevDoc = currentIndex > 0 ? ALL_ITEMS[currentIndex - 1] : null
  const nextDoc = currentIndex < ALL_ITEMS.length - 1 ? ALL_ITEMS[currentIndex + 1] : null

  // ⌘K Keyboard Shortcut Listener
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setIsSearchOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Auto-focus search input when modal opens
  useEffect(() => {
    if (isSearchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [isSearchOpen])

  // Filtered search results for ⌘K modal
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
    const matchedDocs = ALL_ITEMS.filter(i => i.title.toLowerCase().includes(q))
    const matchedCommands = SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
    return { docs: matchedDocs, commands: matchedCommands }
  }, [searchQuery])

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh', fontFamily: 'var(--font-inter)' }}>

      {/* ═══ ⌘K COMMAND SEARCH MODAL ═══ */}
      {isSearchOpen && (
        <div
          onClick={() => setIsSearchOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(16, 29, 39, 0.6)',
            backdropFilter: 'blur(8px)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '12vh',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 580,
              background: '#0d131a',
              border: '1px solid rgba(195, 198, 215, 0.2)',
              borderRadius: 12,
              boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
            className="animate-scale-in"
          >
            {/* Modal Input */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid rgba(195, 198, 215, 0.1)' }}>
              <span className="material-symbols-outlined" style={{ color: 'var(--color-primary-fixed-dim)', fontSize: 20, marginRight: 12 }}>
                search
              </span>
              <input
                ref={searchInputRef}
                placeholder="Search documentation, commands, concepts..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  fontFamily: 'var(--font-inter)',
                  fontSize: 14,
                  color: '#ffffff',
                }}
              />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(230,242,255,0.4)', background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4 }}>
                ESC
              </span>
            </div>

            {/* Modal Results */}
            <div style={{ maxHeight: 360, overflowY: 'auto', padding: '12px' }}>
              {searchQuery.trim() ? (
                <>
                  {searchResults.docs.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,242,255,0.4)', padding: '4px 8px' }}>
                        Documentation Pages
                      </div>
                      {searchResults.docs.map(doc => (
                        <button
                          key={doc.id}
                          onClick={() => {
                            setActiveSection(doc.id)
                            setIsSearchOpen(false)
                            setSearchQuery('')
                            window.scrollTo({ top: 0, behavior: 'smooth' })
                          }}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 12px',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: 6,
                            color: '#ffffff',
                            fontFamily: 'var(--font-inter)',
                            fontSize: 13,
                            textAlign: 'left',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <span>{doc.title}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-primary-fixed-dim)' }}>Jump →</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {searchResults.commands.length > 0 && (
                    <div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,242,255,0.4)', padding: '4px 8px' }}>
                        Slash Commands
                      </div>
                      {searchResults.commands.map(cmd => (
                        <div
                          key={cmd.cmd}
                          onClick={() => {
                            setActiveSection('slash-commands')
                            setIsSearchOpen(false)
                            setSearchQuery('')
                            window.scrollTo({ top: 0, behavior: 'smooth' })
                          }}
                          style={{
                            padding: '8px 12px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            borderRadius: 6,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <div>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary-fixed-dim)', fontWeight: 700 }}>{cmd.cmd}</code>
                            <span style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'rgba(230,242,255,0.6)', marginLeft: 10 }}>{cmd.desc}</span>
                          </div>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,242,255,0.4)' }}>{cmd.cat}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {searchResults.docs.length === 0 && searchResults.commands.length === 0 && (
                    <div style={{ padding: '24px 16px', textAlign: 'center', color: 'rgba(230,242,255,0.5)', fontSize: 13 }}>
                      No results found for "{searchQuery}".
                    </div>
                  )}
                </>
              ) : (
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(230,242,255,0.4)', textTransform: 'uppercase' }}>
                    Quick Shortcuts
                  </span>
                  {[
                    { label: 'Quickstart Guide', id: 'getting-started' },
                    { label: 'Frontier Providers & BYOK', id: 'providers-byok' },
                    { label: '14 Built-in Slash Commands', id: 'slash-commands' },
                    { label: 'Docker Sandboxing & PathGuard', id: 'security-policy' },
                  ].map(q => (
                    <button
                      key={q.id}
                      onClick={() => {
                        setActiveSection(q.id)
                        setIsSearchOpen(false)
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                      style={{
                        padding: '8px 10px',
                        background: 'none',
                        border: 'none',
                        color: 'rgba(230,242,255,0.8)',
                        textAlign: 'left',
                        fontFamily: 'var(--font-inter)',
                        fontSize: 13,
                        cursor: 'pointer',
                        borderRadius: 6,
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ 3-COLUMN DOCUMENTATION LAYOUT ═══ */}
      <div style={{ maxWidth: 1400, margin: '0 auto', width: '100%', display: 'flex', alignItems: 'stretch' }}>

        {/* ── COLUMN 1: LEFT NAVIGATION (Sticky Minimalist Sidebar) ── */}
        <aside
          style={{
            width: 260,
            borderRight: '1px solid var(--color-outline-variant)',
            padding: '24px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            flexShrink: 0,
            position: 'sticky',
            top: 64,
            height: 'calc(100vh - 64px)',
            overflowY: 'auto',
          }}
        >
          {/* Quick Search Trigger */}
          <button
            onClick={() => setIsSearchOpen(true)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              background: 'var(--color-surface-container-lowest)',
              border: '1px solid var(--color-outline-variant)',
              borderRadius: 8,
              cursor: 'pointer',
              color: 'var(--color-on-surface-variant)',
              fontFamily: 'var(--font-inter)',
              fontSize: 12,
              transition: 'border-color 0.15s ease',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>search</span>
              Search docs...
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--color-surface-container)', padding: '2px 5px', borderRadius: 4 }}>
              ⌘K
            </span>
          </button>

          {/* Grouped Links */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: 1 }}>
            {SECTIONS.map(group => (
              <div key={group.group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 8px 6px' }}>
                  {group.group}
                </span>
                {group.items.map(item => {
                  const isActive = activeSection === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setActiveSection(item.id)
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 10px',
                        borderRadius: 6,
                        border: 'none',
                        borderLeft: isActive ? '2px solid var(--color-primary)' : '2px solid transparent',
                        background: isActive ? 'rgba(0, 74, 198, 0.06)' : 'transparent',
                        color: isActive ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
                        fontFamily: 'var(--font-inter)',
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 400,
                        textAlign: 'left',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.6 }}>
                        {item.time}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* Direct Ecosystem Navigation */}
          <div style={{ borderTop: '1px solid var(--color-outline-variant)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Link to="/architecture" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>architecture</span>
              Architecture Overview
            </Link>
            <Link to="/security" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>shield</span>
              Security & Sandboxing
            </Link>
            <Link to="/status" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-tertiary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="material-symbols-outlined icon-fill" style={{ fontSize: 15 }}>check_circle</span>
              All Systems Operational
            </Link>
          </div>
        </aside>

        {/* ── COLUMN 2: MAIN ARTICLE (Minimalist Depth) ── */}
        <main style={{ flex: 1, padding: '40px 56px', maxWidth: 840, overflowY: 'auto' }}>

          {/* Breadcrumb strip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-outline)', marginBottom: 16 }}>
            <Link to="/" style={{ color: 'inherit', textDecoration: 'none' }}>Home</Link>
            <span>/</span>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Docs</span>
            <span>/</span>
            <span style={{ color: 'var(--color-on-surface)' }}>{activeDoc.title}</span>
          </div>

          {/* ────────── SECTION: GETTING STARTED ────────── */}
          {activeSection === 'getting-started' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Quickstart & Installation
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Inflynx Code provides autonomous repository agents powered by AST dependency indexing, multi-provider model routing, and deterministic verification sandboxes.
                </p>
              </div>

              <div id="installation">
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 20, color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  1. Installation
                </h2>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                  Run Inflynx directly via <code>npx</code> or install it globally into your CLI environment:
                </p>

                <CodeBlock
                  tabs={[
                    { label: 'npx (Instant)', code: 'npx @inflynx/code init' },
                    { label: 'pnpm', code: 'pnpm add -g @inflynx/code\ninflynx init' },
                    { label: 'npm', code: 'npm install -g @inflynx/code\ninflynx init' },
                    { label: 'bun', code: 'bun add -g @inflynx/code\ninflynx init' },
                    { label: 'brew', code: 'brew tap inflynx/tap\nbrew install inflynx\ninflynx init' },
                  ]}
                />
              </div>

              <div id="configure-api-keys">
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 20, color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  2. Configure Frontier API Keys (BYOK)
                </h2>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                  Under our Bring Your Own Key architecture, credentials stream directly from your machine to provider gateways. Keys are never transmitted to Inflynx servers.
                </p>

                <CodeBlock
                  code={`# Shell environment variables:
export ANTHROPIC_API_KEY="sk-ant-api03-..."      # Claude Opus 5 & Sonnet 5
export OPENAI_API_KEY="sk-proj-..."              # GPT-6 Astra & GPT-5.6 Sol
export GOOGLE_API_KEY="AIzaSy..."                # Gemini 3.8 Flash & Flash Cyber
export DEEPSEEK_API_KEY="sk-..."                 # DeepSeek V4 Flash (0731 GA)

# Or store securely in the encrypted OS keyring:
inflynx auth login --provider anthropic
inflynx auth login --provider google`}
                  language="bash"
                />
              </div>

              <div id="first-agent-session">
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 20, color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  3. Launch First Agent Session
                </h2>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                  Navigate to any project repository and run <code>inflynx</code> to launch the terminal REPL:
                </p>

                <CodeBlock
                  code={`cd my-project-repository
inflynx

# Or execute structured prompts directly from shell:
inflynx --mode plan "Refactor session store to prevent race conditions"
inflynx --mode debug "Investigate uncaught promise rejection in token manager"`}
                  language="bash"
                />
              </div>

              <Callout type="tip" title="Deterministic Three-Phase Workflow">
                Inflynx Code never blindly commits code. It generates an execution plan, validates compilation and tests inside an ephemeral Docker container, and prompts you for final approval.
              </Callout>
            </article>
          )}

          {/* ────────── SECTION: PROVIDERS & BYOK ────────── */}
          {activeSection === 'providers-byok' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Frontier Providers & BYOK
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Inflynx Code integrates the full 2026 frontier model landscape, enabling granular per-task model routing within a single agentic session.
                </p>
              </div>

              <div id="curated-2026-model-suite">
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 20, color: 'var(--color-on-surface)', marginBottom: 12 }}>
                  Curated 2026 Model Suite
                </h2>

                <div style={{ border: '1px solid var(--color-outline-variant)', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-inter)', fontSize: 13, textAlign: 'left' }}>
                    <thead>
                      <tr style={{ background: 'var(--color-surface-container-low)', borderBottom: '1px solid var(--color-outline-variant)' }}>
                        <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Provider</th>
                        <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Curated Model</th>
                        <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Context</th>
                        <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Specialization</th>
                        <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Tag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { prov: 'Anthropic', model: 'Claude Opus 5', ctx: '1M+', use: 'Architectural planning & deep refactoring', tag: '@claude-opus' },
                        { prov: 'Anthropic', model: 'Claude Sonnet 5', ctx: '1M+', use: 'Fast multi-file code editing & reasoning', tag: '@claude-sonnet' },
                        { prov: 'OpenAI', model: 'GPT-6 Astra', ctx: '1.05M', use: 'Autonomous reasoning & computer use', tag: '@gpt-6-astra' },
                        { prov: 'Google', model: 'Gemini 3.8 Flash', ctx: '1.04M', use: '1M+ context cross-repo symbol search', tag: '@gemini-trace' },
                        { prov: 'DeepSeek', model: 'DeepSeek V4 Flash', ctx: '1M+', use: 'Ultra-low latency MoE code synthesis', tag: '@deepseek-v4' },
                        { prov: 'Local', model: 'Llama 3.3 / Qwen 3.6', ctx: '256k', use: 'Air-gapped offline security compliance', tag: '@local' },
                      ].map(({ prov, model, ctx, use, tag }, i) => (
                        <tr key={model} style={{ borderBottom: i < 5 ? '1px solid var(--color-outline-variant)' : 'none' }}>
                          <td style={{ padding: '10px 14px', fontWeight: 600 }}>{prov}</td>
                          <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', color: 'var(--color-primary)' }}>{model}</td>
                          <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', color: 'var(--color-on-surface-variant)' }}>{ctx}</td>
                          <td style={{ padding: '10px 14px', color: 'var(--color-on-surface-variant)' }}>{use}</td>
                          <td style={{ padding: '10px 14px' }}>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--color-surface-container)', padding: '2px 6px', borderRadius: 4 }}>{tag}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div id="routing-directives">
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 20, color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Subtask Routing Directives
                </h2>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                  Direct individual subtasks to specific cognitive architectures in a single prompt:
                </p>

                <CodeBlock
                  code={`# Route planning to Claude Opus 5 and implementation to DeepSeek V4 Flash:
inflynx "@claude-opus plan the database migration, then @deepseek-v4 write the migration unit tests"

# Scan entire 100,000-line codebase for unhandled promise rejections:
inflynx "@gemini-trace search across repo for unhandled rejection call sites"`}
                  language="bash"
                />
              </div>
            </article>
          )}

          {/* ────────── SECTION: CONFIGURATION ────────── */}
          {activeSection === 'configuration' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Configuration & Schemas
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Workspace policies and execution parameters are managed in <code>.inflynx/config.json</code> at your project root.
                </p>
              </div>

              <div id="interactive-builder">
                <ConfigGenerator />
              </div>

              <div id="schema-specification">
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 20, color: 'var(--color-on-surface)', marginBottom: 12 }}>
                  Schema Specification
                </h2>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { key: 'defaultProvider', type: 'string', desc: 'Default provider for unspecified tasks ("google", "anthropic", "openai", "deepseek").' },
                    { key: 'defaultModel', type: 'string', desc: 'Exact model ID from curated catalog (e.g., "gemini-3.8-flash").' },
                    { key: 'effortLevel', type: 'string', desc: 'Reasoning effort tier ("none", "low", "medium", "high", "max").' },
                    { key: 'thinkingBudgetTokens', type: 'number', desc: 'Budget allocated for intermediate thinking/reasoning blocks.' },
                    { key: 'sandbox.networkAccess', type: 'string', desc: '"none" for zero-network containment, or "host".' },
                    { key: 'policy.requireApprovalForMutations', type: 'boolean', desc: 'Enforces human signoff before modifying workspace files.' },
                  ].map(({ key, type, desc }) => (
                    <div key={key} style={{ padding: '12px 16px', background: 'var(--color-surface-container-lowest)', border: '1px solid var(--color-outline-variant)', borderRadius: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-primary)' }}>{key}</code>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>{type}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 4 }}>{desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          )}

          {/* ────────── SECTION: PROMPT MODES ────────── */}
          {activeSection === 'prompt-modes' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  The 4 Execution Modes
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Enforce strict cognitive constraints by launching agents in dedicated prompt modes.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                {[
                  { mode: 'Ask Mode', flag: '--mode ask', desc: 'Read-only exploratory queries. Traces call trees and explains logic with zero filesystem mutations.', perm: 'Read Only' },
                  { mode: 'Plan Mode', flag: '--mode plan', desc: 'Produces structured JSON execution plans mapping affected AST symbols before any edits.', perm: 'Planning' },
                  { mode: 'Agent Mode', flag: '--mode agent', desc: 'Autonomous multi-file modification with Docker verification gates and diff signing.', perm: 'Full Agent' },
                  { mode: 'Debug Mode', flag: '--mode debug', desc: 'Dynamic finding engine with stack trace reproduction and regression isolation.', perm: 'Diagnostic' },
                ].map(({ mode, flag, desc, perm }) => (
                  <div key={mode} style={{ padding: 18, background: 'var(--color-surface-container-lowest)', border: '1px solid var(--color-outline-variant)', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 15, color: 'var(--color-on-surface)' }}>{mode}</span>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-primary)', background: 'rgba(0,74,198,0.06)', padding: '2px 6px', borderRadius: 4 }}>{flag}</code>
                    </div>
                    <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>{desc}</p>
                    <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>
                      Permission: {perm}
                    </div>
                  </div>
                ))}
              </div>
            </article>
          )}

          {/* ────────── SECTION: EFFORT PROFILES ────────── */}
          {activeSection === 'effort-profiles' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Reasoning Effort & Budgets
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Inflynx never silently lowers your requested reasoning effort. Choose from 5 deterministic thinking tiers.
                </p>
              </div>

              <div style={{ border: '1px solid var(--color-outline-variant)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-inter)', fontSize: 13, textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-container-low)', borderBottom: '1px solid var(--color-outline-variant)' }}>
                      <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Effort Tier</th>
                      <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Token Budget</th>
                      <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Typical Use Case</th>
                      <th style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)' }}>Supported Providers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { tier: 'none / minimal', budget: '0–1,024', use: 'Syntax edits, formatting, docstrings', prov: 'OpenAI, DeepSeek' },
                      { tier: 'low', budget: '2,048', use: 'Single-function refactoring, unit tests', prov: 'All frontier providers' },
                      { tier: 'medium', budget: '4,096', use: 'Multi-file feature development', prov: 'All frontier providers' },
                      { tier: 'high', budget: '8,192–16,384', use: 'Complex architectural refactors', prov: 'Claude Opus 5, Gemini 3.8, GPT-6' },
                      { tier: 'max', budget: '32,768–65,536', use: 'Subsystem rewrite, race condition resolution', prov: 'Claude Opus 5, GPT-6 Astra' },
                    ].map(({ tier, budget, use, prov }, i) => (
                      <tr key={tier} style={{ borderBottom: i < 4 ? '1px solid var(--color-outline-variant)' : 'none' }}>
                        <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-primary)' }}>{tier}</td>
                        <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', color: 'var(--color-on-surface)' }}>{budget}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-on-surface-variant)' }}>{use}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--color-on-surface-variant)' }}>{prov}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {/* ────────── SECTION: ORCHESTRATION ENGINE ────────── */}
          {activeSection === 'orchestration-runtime' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Orchestration State Machine
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Every agent execution follows an immutable 6-stage lifecycle preventing unverified code from polluting your codebase.
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { num: '01', title: 'Intent Ingestion & Secret Redaction', desc: 'User input is parsed; Shannon Entropy scrubber strips credentials before socket emit.' },
                  { num: '02', title: 'AST Graph Context Assembly', desc: 'Incremental Tree-Sitter parser builds symbol call chain with ZSTD stream compression.' },
                  { num: '03', title: 'Cognitive Model Dispatch', desc: 'Subtask is dispatched to the chosen frontier model (Claude Opus 5, GPT-6 Astra, Gemini 3.8).' },
                  { num: '04', title: 'Tool Execution Gateway', desc: 'PathGuard blocks directory traversal; CommandPolicy filters destructive commands.' },
                  { num: '05', title: 'Ephemeral Docker Sandboxing', desc: 'Compilers and test runners verify patch stability with --network none isolation.' },
                  { num: '06', title: 'Cryptographic Diff Signoff', desc: 'SHA-256 unified diff signature is presented for developer approval before applying.' },
                ].map(({ num, title, desc }) => (
                  <div key={num} style={{ display: 'flex', gap: 16, padding: '14px 18px', background: 'var(--color-surface-container-lowest)', border: '1px solid var(--color-outline-variant)', borderRadius: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--color-primary)' }}>{num}</span>
                    <div>
                      <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 2 }}>{title}</div>
                      <div style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          )}

          {/* ────────── SECTION: SLASH COMMANDS ────────── */}
          {activeSection === 'slash-commands' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  14 Built-in Slash Commands
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Direct terminal control palette for inspecting and overriding agent state.
                </p>
              </div>

              {/* Category Filter Pills */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['all', 'workflow', 'execution', 'ast', 'context', 'security', 'diagnostics'].map(cat => (
                  <button
                    key={cat}
                    onClick={() => setSlashCategory(cat)}
                    style={{
                      background: slashCategory === cat ? 'var(--color-primary)' : 'var(--color-surface-container-lowest)',
                      color: slashCategory === cat ? '#ffffff' : 'var(--color-on-surface-variant)',
                      border: '1px solid var(--color-outline-variant)',
                      borderRadius: 9999,
                      padding: '4px 12px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Command List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {SLASH_COMMANDS.filter(c => slashCategory === 'all' || c.cat === slashCategory).map(({ cmd, cat, desc, args }) => (
                  <div
                    key={cmd}
                    style={{
                      padding: '12px 16px',
                      background: 'var(--color-surface-container-lowest)',
                      border: '1px solid var(--color-outline-variant)',
                      borderRadius: 8,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--color-primary)' }}>{cmd}</code>
                      {args && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-outline)' }}>{args}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 13, color: 'var(--color-on-surface-variant)' }}>{desc}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', background: 'var(--color-surface-container)', padding: '2px 6px', borderRadius: 4, color: 'var(--color-outline)' }}>{cat}</span>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          )}

          {/* ────────── SECTION: AST DEPENDENCY GRAPH ────────── */}
          {activeSection === 'dependency-graph' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  AST Dependency Graph Engine
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Inflynx constructs an incremental Abstract Syntax Tree (AST) mapping import relationships, interface boundaries, and symbol caller hierarchies.
                </p>
              </div>

              <CodeBlock
                code={`# Inspect the symbol dependency chain for a service:
inflynx /graph src/auth/AuthService.ts

# Output topology:
# ├── imports
# │   ├── TokenManager (from ./TokenManager.ts)
# │   └── RedisClient (from ./redis.ts)
# ├── exported symbols
# │   ├── class AuthService [line 14]
# │   ├── function verifySession [line 48]
# │   └── type AuthState [line 92]
# └── reverse caller graph (12 callers found)
#     ├── src/api/middleware/auth.ts:22
#     └── src/routes/user.ts:89`}
                language="bash"
              />
            </article>
          )}

          {/* ────────── SECTION: SECURITY POLICY ────────── */}
          {activeSection === 'security-policy' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Docker Sandboxes & PathGuard
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  Zero-trust mathematical isolation ensuring model tool calls cannot access unauthorized hosts or escape workspace boundaries.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
                <div style={{ padding: 18, background: 'var(--color-surface-container-lowest)', border: '1px solid var(--color-outline-variant)', borderRadius: 8 }}>
                  <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)', marginBottom: 6 }}>PathGuard Containment</h3>
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                    Resolves canonical paths for all file operations. Any path containing <code>../</code> or referencing parent directories outside the git root is immediately aborted.
                  </p>
                </div>
                <div style={{ padding: 18, background: 'var(--color-surface-container-lowest)', border: '1px solid var(--color-outline-variant)', borderRadius: 8 }}>
                  <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)', marginBottom: 6 }}>Zero-Network Docker</h3>
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                    Build tools and test runners execute inside containers with <code>--network none</code>. No data can be exfiltrated over the network during compilation.
                  </p>
                </div>
              </div>
            </article>
          )}

          {/* ────────── SECTION: SECRET REDACTION ────────── */}
          {activeSection === 'secret-redaction' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Shannon Entropy Secret Redaction
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  High-speed pre-socket scanner stripping credentials and private API tokens before prompts are emitted to any model provider.
                </p>
              </div>

              <CodeBlock
                code={`# Scans detect high-entropy credentials (> 4.5 Shannon Entropy):
Raw prompt payload:
  AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  DATABASE_URL="postgres://admin:superSecret123@prod.db:5432/core"

Sanitized payload emitted to LLM:
  AWS_SECRET_ACCESS_KEY="[REDACTED_AWS_KEY]"
  DATABASE_URL="postgres://[USER]:[REDACTED_PASSWORD]@prod.db:5432/core"`}
                language="bash"
              />
            </article>
          )}

          {/* ────────── SECTION: RFC ROADMAP ────────── */}
          {activeSection === 'rfc-roadmap-phases' && (
            <article className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 3.5vw, 40px)', letterSpacing: '-0.03em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                  Production Maturity RFC
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                  The engineering roadmap to full autonomous coding platform maturity.
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { phase: 'Phase 0 — Core Protocol', desc: 'JSON-RPC contracts, event streaming, CLI scaffolding.', status: 'Complete' },
                  { phase: 'Phase 1 — AST Parser Engine', desc: 'Incremental Tree-Sitter parser, call graph mapping.', status: 'Complete' },
                  { phase: 'Phase 2 — Multi-Provider Gateway', desc: 'Claude Opus 5, GPT-6 Astra, Gemini 3.8, DeepSeek V4.', status: 'Complete' },
                  { phase: 'Phase 3 — Ephemeral Docker Sandboxes', desc: 'Zero-network container testing with compiler gates.', status: 'Complete' },
                  { phase: 'Phase 4 — Secret Redaction & Policy', desc: 'Shannon entropy scrubber, PathGuard, SSRF guard.', status: 'Complete' },
                  { phase: 'Phase 5 — Context Packing & Compression', desc: 'ZSTD compression and proximity token budgeting.', status: 'Complete' },
                  { phase: 'Phase 6 — Plan State Machine', desc: 'Plan → Verify → Apply with SHA-256 diff signing.', status: 'Complete' },
                  { phase: 'Phase 7 — Telemetry & Web Portal', desc: 'Live console, telemetry metrics, and credit analytics.', status: 'Active' },
                ].map(({ phase, desc, status }) => (
                  <div key={phase} style={{ padding: '12px 16px', background: 'var(--color-surface-container-lowest)', border: '1px solid var(--color-outline-variant)', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 14, color: 'var(--color-on-surface)' }}>{phase}</span>
                      <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', margin: '2px 0 0' }}>{desc}</p>
                    </div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: status === 'Complete' ? 'var(--color-tertiary)' : 'var(--color-primary)', fontWeight: 600 }}>
                      {status}
                    </span>
                  </div>
                ))}
              </div>
            </article>
          )}

          {/* ── PREV / NEXT BOTTOM NAVIGATION ── */}
          <div style={{ borderTop: '1px solid var(--color-outline-variant)', marginTop: 40, paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            {prevDoc ? (
              <button
                onClick={() => {
                  setActiveSection(prevDoc.id)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-outline-variant)',
                  borderRadius: 8,
                  padding: '8px 14px',
                  fontFamily: 'var(--font-inter)',
                  fontSize: 13,
                  color: 'var(--color-on-surface-variant)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
                {prevDoc.title}
              </button>
            ) : <div />}

            {nextDoc && (
              <button
                onClick={() => {
                  setActiveSection(nextDoc.id)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                style={{
                  background: 'var(--color-primary)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 14px',
                  fontFamily: 'var(--font-inter)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#ffffff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {nextDoc.title}
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
              </button>
            )}
          </div>

          {/* ── MINIMALIST FEEDBACK WIDGET ── */}
          <div style={{ marginTop: 32, padding: '12px 16px', borderRadius: 8, background: 'var(--color-surface-container-low)', border: '1px solid var(--color-outline-variant)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
              Was this article helpful?
            </span>
            {feedback ? (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-tertiary)', fontWeight: 600 }}>
                ✓ Thanks for the feedback!
              </span>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setFeedback('yes')} style={{ padding: '4px 8px', border: '1px solid var(--color-outline-variant)', borderRadius: 4, background: 'none', cursor: 'pointer', fontSize: 12 }}>👍</button>
                <button onClick={() => setFeedback('no')} style={{ padding: '4px 8px', border: '1px solid var(--color-outline-variant)', borderRadius: 4, background: 'none', cursor: 'pointer', fontSize: 12 }}>👎</button>
              </div>
            )}
          </div>
        </main>

        {/* ── COLUMN 3: RIGHT TABLE OF CONTENTS (On this page) ── */}
        <aside
          style={{
            width: 220,
            padding: '40px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            flexShrink: 0,
            position: 'sticky',
            top: 64,
            height: 'calc(100vh - 64px)',
            overflowY: 'auto',
          }}
          className="hidden lg:flex"
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            On This Page
          </span>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activeDoc.headings?.map((heading) => {
              const anchorId = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')
              return (
                <a
                  key={heading}
                  href={`#${anchorId}`}
                  style={{
                    fontFamily: 'var(--font-inter)',
                    fontSize: 12,
                    color: 'var(--color-on-surface-variant)',
                    textDecoration: 'none',
                    lineHeight: 1.4,
                    transition: 'color 0.15s ease',
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--color-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--color-on-surface-variant)'}
                >
                  {heading}
                </a>
              )
            })}
          </div>

          <div style={{ borderTop: '1px solid var(--color-outline-variant)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
              Edit on GitHub
            </a>
            <Link
              to="/contact"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-outline)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>chat</span>
              Ask the Community
            </Link>
          </div>
        </aside>
      </div>
    </div>
  )
}
