/// <reference types="vite/client" />

declare namespace React {
  export type ReactNode =
    | string
    | number
    | boolean
    | null
    | undefined
    | ReactElement
    | Iterable<ReactNode>

  export interface ReactElement<P = any, T extends string | JSXElementConstructor<any> = string | JSXElementConstructor<any>> {
    type: T
    props: P
    key: string | number | null
  }

  export type JSXElementConstructor<P> = (props: P) => ReactElement<any, any> | null

  export interface FC<P = {}> {
    (props: P): ReactElement<any, any> | null
  }

  export interface CSSProperties {
    [key: string]: any
  }

  export interface ChangeEvent<T = any> {
    target: T
  }

  export interface KeyboardEvent<T = any> {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
    altKey: boolean
    preventDefault(): void
  }

  export interface MouseEvent<T = any> {
    preventDefault(): void
    stopPropagation(): void
  }

  export function useState<T>(initialState: T | (() => T)): [T, (newState: T | ((prevState: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void
  export function useMemo<T>(factory: () => T, deps: readonly any[] | undefined): T
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly any[]): T
  export function useRef<T>(initialValue?: T): { current: T }
  export function createContext<T>(defaultValue: T): any
  export function useContext<T>(context: any): T

  export const StrictMode: FC<{ children?: ReactNode }>
  export const Fragment: FC<{ children?: ReactNode; key?: string | number }>
}

declare module 'react' {
  export = React
  export as namespace React
}

declare module 'react/jsx-runtime' {
  export namespace JSX {
    interface Element extends React.ReactElement<any, any> {}
    interface IntrinsicElements {
      [elemName: string]: any
    }
    interface ElementChildrenAttribute {
      children: {}
    }
  }
  export function jsx(type: any, props: any, key?: any): React.ReactElement
  export function jsxs(type: any, props: any, key?: any): React.ReactElement
  export function Fragment(props: { children?: React.ReactNode }): React.ReactElement
}

declare module 'react/jsx-dev-runtime' {
  export namespace JSX {
    interface Element extends React.ReactElement<any, any> {}
    interface IntrinsicElements {
      [elemName: string]: any
    }
    interface ElementChildrenAttribute {
      children: {}
    }
  }
  export function jsxDEV(type: any, props: any, key?: any, isStatic?: boolean, source?: any, self?: any): React.ReactElement
  export function Fragment(props: { children?: React.ReactNode }): React.ReactElement
}

declare module 'react-dom/client' {
  export interface Root {
    render(children: any): void
    unmount(): void
  }
  export function createRoot(container: Element | DocumentFragment): Root
}

declare module 'vite' {
  export function defineConfig(config: any): any
}

declare module '@vitejs/plugin-react' {
  export default function react(): any
}

declare namespace JSX {
  interface Element extends React.ReactElement<any, any> {}
  interface IntrinsicElements {
    [elemName: string]: any
  }
  interface ElementChildrenAttribute {
    children: {}
  }
}
