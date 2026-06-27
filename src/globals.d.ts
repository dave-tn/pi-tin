declare const PKG_VERSION: string;
declare const PKG_HOMEPAGE: string;

declare module '*.md' {
  const content: string;
  export default content;
}
