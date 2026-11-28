import React from 'react'
import Panel from './ui/Panel'
import Button from './ui/Button'
import StatusDot from './ui/StatusDot'

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
        <div className="w-full max-w-sm">
          <Panel label="App error" tone="danger">
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-heading text-foreground">
                <StatusDot status="danger" />
                Something broke
              </p>
              <p className="text-body-sm text-muted">
                The app hit an error it couldn't recover from. Your data is safe — reloading
                usually fixes it.
              </p>
              <Button icon="refresh" full onClick={this.handleReload}>
                Reload
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    )
  }
}
