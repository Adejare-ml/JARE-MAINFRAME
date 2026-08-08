import React from 'react'

/**
 * Last line of defence: a render throw anywhere below used to unmount the
 * whole tree and leave a white page with nothing to tap.
 *
 * A class component because error boundaries still have no hook equivalent.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Render error caught by boundary:', error, info)
  }

  handleReload = () => {
    // Full reload rather than a state reset: whatever threw may have left
    // module-level state (subscriptions, the toast store) inconsistent.
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-sm">
          <span className="text-4xl" aria-hidden="true">💥</span>
          <div>
            <p className="text-lg font-bold text-white mb-1">Something broke</p>
            <p className="text-xs text-muted">
              The app hit an error it couldn't recover from. Your data is safe — reloading
              usually fixes it.
            </p>
          </div>
          <button
            onClick={this.handleReload}
            className="px-6 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px]"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
