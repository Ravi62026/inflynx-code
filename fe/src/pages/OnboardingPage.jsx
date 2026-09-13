import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const steps = [
  {
    id: 'workspace',
    title: 'Name your workspace',
    subtitle: 'This is how your team will identify this Inflynx instance.',
    icon: 'folder_open',
  },
  {
    id: 'repo',
    title: 'Connect a repository',
    subtitle: 'Inflynx will index your codebase and build the dependency graph.',
    icon: 'account_tree',
  },
  {
    id: 'provider',
    title: 'Choose your AI providers',
    subtitle: 'Select which models to enable. You can change this anytime.',
    icon: 'memory',
  },
  {
    id: 'ready',
    title: "You're ready to deploy",
    subtitle: 'Your first agent task is waiting.',
    icon: 'rocket_launch',
  },
]

const providers = [
  { id: 'claude', name: 'Claude Opus 5 / Sonnet 5', tag: 'Flagship planning & coding', color: 'var(--color-secondary)', selected: true },
  { id: 'gemini', name: 'Gemini 3.8 Flash', tag: '1M+ context & native thinking', color: 'var(--color-primary)', selected: true },
  { id: 'openai', name: 'GPT-6 Astra / GPT-5.6 Sol', tag: 'Frontier reasoning & computer use', color: '#10a37f', selected: true },
  { id: 'deepseek', name: 'DeepSeek V4 Flash', tag: 'Ultra-fast MoE coding', color: 'var(--color-tertiary)', selected: true },
  { id: 'openrouter', name: 'OpenRouter / Local', tag: 'Universal gateway & air-gapped BYOK', color: '#666', selected: false },
]

export default function OnboardingPage() {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [workspace, setWorkspace] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [enabledProviders, setEnabledProviders] = useState(new Set(['claude', 'gemini', 'openai', 'deepseek']))
  const [indexing, setIndexing] = useState(false)
  const [indexed, setIndexed] = useState(false)

  const progress = ((currentStep) / (steps.length - 1)) * 100

  const handleNext = () => {
    if (currentStep === 1 && !indexed) {
      setIndexing(true)
      setTimeout(() => {
        setIndexing(false)
        setIndexed(true)
      }, 2000)
      return
    }
    if (currentStep < steps.length - 1) {
      setCurrentStep(s => s + 1)
    } else {
      navigate('/dashboard')
    }
  }

  const toggleProvider = (id) => {
    setEnabledProviders(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-background)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-inter)' }}>
      {/* Top progress bar */}
      <div style={{ height: 3, background: 'var(--color-surface-container)' }}>
        <div style={{ height: '100%', background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))', width: `${progress}%`, transition: 'width 0.4s ease' }} />
      </div>

      {/* Stepper header */}
      <header style={{ borderBottom: '1px solid var(--color-outline-variant)', padding: '16px 32px', display: 'flex', alignItems: 'center', gap: 24, background: 'var(--color-surface-container-lowest)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 18, color: 'var(--color-primary)' }}>
          <span className="material-symbols-outlined icon-fill" style={{ fontSize: 22 }}>terminal</span>
          Inflynx Code
        </div>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 8 }}>
          {steps.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: i < currentStep ? 'var(--color-tertiary)' : i === currentStep ? 'var(--color-primary)' : 'var(--color-surface-container-high)',
                border: `2px solid ${i <= currentStep ? (i < currentStep ? 'var(--color-tertiary)' : 'var(--color-primary)') : 'var(--color-outline-variant)'}`,
                transition: 'all 0.3s ease',
              }}>
                {i < currentStep ? (
                  <span className="material-symbols-outlined icon-fill" style={{ fontSize: 16, color: 'white' }}>check</span>
                ) : (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: i === currentStep ? 'white' : 'var(--color-on-surface-variant)' }}>{i + 1}</span>
                )}
              </div>
              <span style={{ fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: i === currentStep ? 600 : 400, color: i === currentStep ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)' }} className="hidden md:block">
                {s.title.split(' ').slice(0, 2).join(' ')}
              </span>
              {i < steps.length - 1 && <div style={{ width: 24, height: 1, background: 'var(--color-outline-variant)' }} />}
            </div>
          ))}
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px' }}>
        <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 32 }} className="animate-scale-in">

          {/* Step icon & title */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: 'rgba(0,74,198,0.08)', border: '1px solid rgba(0,74,198,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <span className="material-symbols-outlined icon-fill" style={{ fontSize: 32, color: 'var(--color-primary)' }}>{steps[currentStep].icon}</span>
            </div>
            <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 28, letterSpacing: '-0.02em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
              {steps[currentStep].title}
            </h1>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>
              {steps[currentStep].subtitle}
            </p>
          </div>

          {/* Step content */}
          <div className="card" style={{ padding: 28 }}>

            {/* Step 0: Workspace name */}
            {currentStep === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 8 }}>Workspace name</label>
                  <input className="input" type="text" placeholder="e.g. Acme Engineering" value={workspace} onChange={e => setWorkspace(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 8 }}>Organization (optional)</label>
                  <input className="input" type="text" placeholder="Acme Corp" />
                </div>
                <div style={{ padding: '12px 16px', background: 'var(--color-surface-container-low)', borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', border: '1px solid var(--color-outline-variant)' }}>
                  Workspace URL: <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>inflynx.dev/{workspace.toLowerCase().replace(/\s/g, '-') || 'your-workspace'}</span>
                </div>
              </div>
            )}

            {/* Step 1: Connect repo */}
            {currentStep === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 8 }}>Repository URL</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input" type="text" placeholder="https://github.com/your-org/repo" value={repoUrl} onChange={e => setRepoUrl(e.target.value)} style={{ flex: 1 }} />
                  </div>
                </div>
                {indexing && (
                  <div style={{ padding: '16px', background: 'var(--color-surface-container)', borderRadius: 8, border: '1px solid var(--color-outline-variant)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'var(--color-primary)', animation: 'spin 1s linear infinite' }}>progress_activity</span>
                      <span style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 14 }}>Indexing repository...</span>
                    </div>
                    {['Cloning repository...', 'Parsing AST (142 files)...', 'Building dependency graph...'].map((t, i) => (
                      <div key={t} style={{ display: 'flex', gap: 8, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', animationDelay: `${i * 0.4}s` }} className="animate-fade-in">
                        <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--color-tertiary)' }}>check_circle</span>
                        {t}
                      </div>
                    ))}
                  </div>
                )}
                {indexed && (
                  <div style={{ padding: '16px', background: 'rgba(0,96,86,0.06)', borderRadius: 8, border: '1px solid rgba(0,96,86,0.2)' }} className="animate-scale-in">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className="material-symbols-outlined icon-fill" style={{ color: 'var(--color-tertiary)', fontSize: 22 }}>check_circle</span>
                      <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 15, color: 'var(--color-tertiary)' }}>Repository indexed successfully!</span>
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', display: 'flex', gap: 24 }}>
                      <span>📁 142 files</span>
                      <span>🔗 312 symbols</span>
                      <span>⏱ 0.8s</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Providers */}
            {currentStep === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {providers.map(({ id, name, tag, color }) => (
                  <button
                    key={id}
                    onClick={() => toggleProvider(id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '14px 16px',
                      borderRadius: 10,
                      border: `2px solid ${enabledProviders.has(id) ? color : 'var(--color-outline-variant)'}`,
                      background: enabledProviders.has(id) ? `${color}08` : 'var(--color-surface-container-lowest)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 16, color }}>
                        {name[0]}
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 14, color: 'var(--color-on-surface)' }}>{name}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)' }}>{tag}</div>
                      </div>
                    </div>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${enabledProviders.has(id) ? color : 'var(--color-outline-variant)'}`, background: enabledProviders.has(id) ? color : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease' }}>
                      {enabledProviders.has(id) && <span className="material-symbols-outlined icon-fill" style={{ fontSize: 14, color: 'white' }}>check</span>}
                    </div>
                  </button>
                ))}
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', textAlign: 'center', marginTop: 4 }}>
                  Add your API keys in Settings after setup.
                </p>
              </div>
            )}

            {/* Step 3: Ready */}
            {currentStep === 3 && (
              <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center' }}>
                <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(0,96,86,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse-glow 2s ease-in-out infinite' }}>
                  <span className="material-symbols-outlined icon-fill" style={{ fontSize: 40, color: 'var(--color-tertiary)' }}>check_circle</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
                  {[
                    { icon: 'folder_open', label: 'Workspace', value: workspace || 'My Workspace' },
                    { icon: 'account_tree', label: 'Repository', value: '142 files indexed' },
                    { icon: 'memory', label: 'Providers', value: `${enabledProviders.size} enabled` },
                  ].map(({ icon, label, value }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--color-surface-container-low)', borderRadius: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'var(--color-primary)' }}>{icon}</span>
                        <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)' }}>{label}</span>
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)' }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Navigation */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={() => setCurrentStep(s => Math.max(0, s - 1))}
              className="btn-secondary"
              style={{ visibility: currentStep === 0 ? 'hidden' : 'visible' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
              Back
            </button>
            <button
              onClick={handleNext}
              className="btn-primary"
              disabled={indexing}
            >
              {currentStep === 1 && !indexed
                ? (<><span className="material-symbols-outlined" style={{ fontSize: 18 }}>{indexing ? 'progress_activity' : 'account_tree'}</span>{indexing ? 'Indexing...' : 'Index Repository'}</>)
                : currentStep === steps.length - 1
                  ? (<><span className="material-symbols-outlined" style={{ fontSize: 18 }}>rocket_launch</span>Launch Dashboard</>)
                  : (<>Continue<span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_forward</span></>)
              }
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
