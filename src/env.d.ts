/// <reference types="astro/client" />
/// <reference path="../.astro/types.d.ts" />

declare module "@fontsource-variable/jetbrains-mono";
declare module "@fontsource-variable/jetbrains-mono/wght-italic.css";

interface ImportMetaEnv {
	readonly PUBLIC_API_ORIGIN?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
