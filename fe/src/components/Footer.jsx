import { Link } from 'react-router-dom'

export default function Footer() {
  const footerLinks = [
    { label: 'Privacy', to: '#' },
    { label: 'Terms', to: '#' },
    { label: 'Security', to: '/#security' },
    { label: 'Status', to: '#' },
    { label: 'Contact', to: '#' },
  ]

  return (
    <footer
      style={{
        background: 'var(--color-surface-container-lowest)',
        borderTop: '1px solid var(--color-outline-variant)',
        padding: '40px 32px',
      }}
    >
      <div
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          {/* Logo */}
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
            <span className="material-symbols-outlined icon-fill" style={{ fontSize: 22 }}>terminal</span>
            Inflynx Code
          </Link>

          {/* Footer Links */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
            {footerLinks.map(({ label, to }) => (
              <Link
                key={label}
                to={to}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: 'var(--color-on-surface-variant)',
                  textDecoration: 'none',
                  transition: 'color 0.2s ease',
                }}
                onMouseEnter={e => e.target.style.color = 'var(--color-primary)'}
                onMouseLeave={e => e.target.style.color = 'var(--color-on-surface-variant)'}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        {/* Copyright */}
        <div
          style={{
            borderTop: '1px solid var(--color-outline-variant)',
            paddingTop: 20,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--color-on-surface-variant)',
            }}
          >
            © 2024 Inflynx Code. All rights reserved.
          </span>
          <div style={{ display: 'flex', gap: 16 }}>
            {['github', 'twitter', 'discord'].map(platform => (
              <a
                key={platform}
                href="#"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  border: '1px solid var(--color-outline-variant)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--color-on-surface-variant)',
                  textDecoration: 'none',
                  transition: 'all 0.2s ease',
                  background: 'var(--color-surface-container-lowest)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 600,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'var(--color-primary)'
                  e.currentTarget.style.color = 'var(--color-primary)'
                  e.currentTarget.style.transform = 'translateY(-2px)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--color-outline-variant)'
                  e.currentTarget.style.color = 'var(--color-on-surface-variant)'
                  e.currentTarget.style.transform = 'translateY(0)'
                }}
              >
                {platform === 'github' ? 'GH' : platform === 'twitter' ? 'TW' : 'DC'}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
