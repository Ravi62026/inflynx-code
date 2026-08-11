import { Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import './App.css'

import Navbar from './components/Navbar'
import Footer from './components/Footer'

import HomePage from './pages/HomePage'
import DashboardPage from './pages/DashboardPage'
import PricingPage from './pages/PricingPage'
import FeaturesPage from './pages/FeaturesPage'
import SignUpPage from './pages/SignUpPage'
import SignInPage from './pages/SignInPage'
import OnboardingPage from './pages/OnboardingPage'
import DocsPage from './pages/DocsPage'

/* Pages that use the marketing layout (Navbar + Footer) */
const MARKETING_ROUTES = ['/', '/features', '/pricing', '/docs']

/* Pages that are fullscreen (no Navbar/Footer) */
const FULLSCREEN_ROUTES = ['/signup', '/signin', '/onboarding', '/dashboard']

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

function MarketingLayout({ children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Navbar />
      <main style={{ flex: 1 }}>{children}</main>
      <Footer />
    </div>
  )
}

/* Simple 404 page */
function NotFoundPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, background: 'var(--color-background)', textAlign: 'center', padding: 24 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 80, fontWeight: 700, color: 'var(--color-primary)', lineHeight: 1, letterSpacing: '-0.04em' }}>404</span>
      <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 28, color: 'var(--color-on-surface)' }}>Page not found</h1>
      <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, color: 'var(--color-on-surface-variant)' }}>Looks like this route doesn't exist yet.</p>
      <a href="/" className="btn-primary">← Back to home</a>
    </div>
  )
}



export default function App() {
  const location = useLocation()

  return (
    <>
      <ScrollToTop />
      <Routes>
        {/* Marketing pages — with Navbar + Footer */}
        <Route
          path="/"
          element={
            <MarketingLayout>
              <HomePage />
            </MarketingLayout>
          }
        />
        <Route
          path="/features"
          element={
            <MarketingLayout>
              <FeaturesPage />
            </MarketingLayout>
          }
        />
        <Route
          path="/pricing"
          element={
            <MarketingLayout>
              <PricingPage />
            </MarketingLayout>
          }
        />
        <Route
          path="/docs"
          element={
            <MarketingLayout>
              <DocsPage />
            </MarketingLayout>
          }
        />

        {/* Auth & onboarding — fullscreen, no Navbar */}
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />

        {/* App — fullscreen with own sidebar */}
        <Route path="/dashboard" element={<DashboardPage />} />

        {/* Fallback */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  )
}