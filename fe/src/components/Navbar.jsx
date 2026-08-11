import { Link, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'

export default function Navbar() {
  const location = useLocation()
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const links = [
    { to: '/features', label: 'Product' },
    { to: '/#architecture', label: 'Architecture' },
    { to: '/#security', label: 'Security' },
    { to: '/pricing', label: 'Pricing' },
    { to: '/docs', label: 'Docs' },
  ]

  const isActive = (to) => location.pathname === to

  return (
    <header
      className={`sticky top-0 z-50 w-full border-b transition-all duration-300 ${
        scrolled
          ? 'bg-white/90 backdrop-blur-md shadow-soft border-[var(--color-outline-variant)]'
          : 'bg-[var(--color-surface)]/80 backdrop-blur-md border-[var(--color-outline-variant)]'
      }`}
    >
      {/* Announcement Banner */}
      <div className="announcement-banner text-sm">
        <a
          href="#"
          className="flex items-center gap-2 text-[var(--color-on-surface)] hover:text-[var(--color-primary)] transition-colors"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
        >
          <span
            style={{
              background: 'var(--color-primary)',
              color: 'var(--color-on-primary)',
              padding: '2px 8px',
              borderRadius: 9999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            v2.4.0
          </span>
          New: Multi-Provider Routing (Claude 3.5 Sonnet + Gemini 1.5 Pro)
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
        </a>
      </div>

      {/* Main Navbar */}
      <div
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '0 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          height: 64,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
          <Link
            to="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--font-geist)',
              fontWeight: 700,
              fontSize: 20,
              color: 'var(--color-primary)',
              textDecoration: 'none',
            }}
          >
            <span className="material-symbols-outlined icon-fill" style={{ fontSize: 24 }}>terminal</span>
            Inflynx Code
          </Link>

          {/* Desktop Nav Links */}
          <nav style={{ display: 'flex', gap: 24, alignItems: 'center' }} className="hidden md:flex">
            {links.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`nav-link ${isActive(to) ? 'active' : ''}`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }} className="hidden md:flex">
          <Link
            to="/signin"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--color-on-surface-variant)',
              textDecoration: 'none',
              transition: 'color 0.2s ease',
            }}
            onMouseEnter={e => e.target.style.color = 'var(--color-primary)'}
            onMouseLeave={e => e.target.style.color = 'var(--color-on-surface-variant)'}
          >
            Sign in
          </Link>
          <Link to="/signup" className="btn-primary" style={{ padding: '8px 20px' }}>
            Initialize Workspace
          </Link>
        </div>

        {/* Mobile Menu Toggle */}
        <button
          className="md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-on-surface)',
          }}
        >
          <span className="material-symbols-outlined">{mobileOpen ? 'close' : 'menu'}</span>
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div
          style={{
            background: 'var(--color-surface-container-lowest)',
            borderTop: '1px solid var(--color-outline-variant)',
            padding: '16px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
          className="animate-fade-in md:hidden"
        >
          {links.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className="nav-link"
              onClick={() => setMobileOpen(false)}
              style={{ padding: '10px 0', fontSize: 16 }}
            >
              {label}
            </Link>
          ))}
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Link to="/signin" className="btn-secondary" style={{ justifyContent: 'center' }} onClick={() => setMobileOpen(false)}>Sign in</Link>
            <Link to="/signup" className="btn-primary" style={{ justifyContent: 'center' }} onClick={() => setMobileOpen(false)}>Initialize Workspace</Link>
          </div>
        </div>
      )}
    </header>
  )
}
