declare module "*.css";

declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode };
  }
}
