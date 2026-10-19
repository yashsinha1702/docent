import { Component } from 'react'
import type { ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** what to show instead, given the error's message */
  fallback: (message: string) => ReactNode
  /** drawing is tried again when this changes (the next snapshot) */
  resetOn: unknown
}
type State = { failed?: string }

/**
 * Keeps a snapshot that cannot be drawn from taking the window down: React unmounts the whole tree on
 * an uncaught render error and App.tsx has no boundary of its own. A class, as boundaries have no hook form.
 */
export class Boundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(err: unknown): State {
    return { failed: err instanceof Error ? err.message : String(err) }
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.failed !== undefined && prev.resetOn !== this.props.resetOn) this.setState({ failed: undefined })
  }

  render(): ReactNode {
    return this.state.failed === undefined ? this.props.children : this.props.fallback(this.state.failed)
  }
}
