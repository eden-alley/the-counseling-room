/// <reference types="vite/client" />

export function getAppConfig() {
  const configuredApiBase = import.meta.env.VITE_API_BASE;
  return { apiBase: configuredApiBase || window.location.origin };
}
